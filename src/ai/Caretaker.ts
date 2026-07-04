import { CONFIG } from "../shared/config";
import { DEFAULT_MAP } from "../shared/map";
import type { GameState, Caretaker } from "../schema/GameState.js";
import { NavMap, type Pt } from "./NavMap.js";

const EXIT = DEFAULT_MAP.exit;
// Endgame guard targets: the relocated far-back exit door + an approach point in
// the back-hall corridor leading to it (the chokepoint for the escape dash).
const EXIT_GUARD: Pt[] = [
  { x: EXIT.x, z: EXIT.z + 1 }, // just inside the doorway
  { x: EXIT.x, z: EXIT.z + 7 }, // the back-hall approach to the exit
];

/**
 * The AI Caretaker (solo Hunter). Server-authoritative. Perception (sight cone +
 * LOS + hearing → awareness + last-known-position) drives a state machine:
 *   PATROL → INVESTIGATE → CHASE → (ATTACK) → SEARCH → PATROL.
 * Walks (slower than running searchers) so it's beatable; the threat comes from
 * hearing it, near-misses, and the flashlight gamble. See BLACKOUT_ai_caretaker.md.
 */
export class CaretakerAI {
  private t = 0; // accumulated seconds
  private awareness = 0;
  private chaseId: string | null = null;
  private lastSeen = 0;
  private lkp: Pt | null = null; // last-known position
  private patrolTarget: Pt | null = null;
  private path: Pt[] = [];
  private repathT = 0;
  private meleeReadyAt = 0;
  private windupUntil = 0; // >0 while a swing is winding up (the dodge window)
  private investigateUntil = 0;
  private searchUntil = 0;
  private guard = false; // endgame: bias toward the back exit + its approaches

  constructor(private readonly nav: NavMap) {}

  activate(state: GameState, spawn: { x: number; z: number }) {
    const c = state.caretaker;
    c.active = true;
    c.x = spawn.x;
    c.z = spawn.z;
    c.ry = 0;
    c.aiState = "patrol";
    this.reset();
  }

  deactivate(state: GameState) {
    state.caretaker.active = false;
    state.caretaker.aiState = "idle";
    this.reset();
  }

  private reset() {
    this.awareness = 0;
    this.chaseId = null;
    this.lkp = null;
    this.patrolTarget = null;
    this.path = [];
    this.investigateUntil = 0;
    this.searchUntil = 0;
    this.windupUntil = 0;
  }

  update(
    dt: number,
    state: GameState,
    runningOf: (id: string) => boolean,
    onCatch: (id: string) => void,
    targetable: (id: string) => boolean = () => true,
  ) {
    const c = state.caretaker;
    if (!c.active) return;
    this.t += dt;
    this.guard = state.deposited >= CONFIG.AI_GUARD_PAD_THRESHOLD || state.doorsOpen;
    const me: Pt = { x: c.x, z: c.z };

    // ---- Perception ----
    let seen: { id: string; x: number; z: number } | null = null;
    let seenD = Infinity;
    state.players.forEach((p) => {
      if (p.downed) return;
      if (!targetable(p.id)) return; // e.g. the traitor — the Caretaker's ally
      const d = Math.hypot(p.x - me.x, p.z - me.z);

      // Hearing.
      if (!p.hidden) {
        if (runningOf(p.id) && d <= CONFIG.RUN_AUDIBLE_RADIUS) {
          this.awareness = Math.min(100, this.awareness + (50 * (1 - d / CONFIG.RUN_AUDIBLE_RADIUS) + 10) * dt);
          this.lkp = { x: p.x, z: p.z };
        } else if (d <= CONFIG.WALK_AUDIBLE_RADIUS) {
          this.awareness = Math.min(100, this.awareness + 18 * dt);
          this.lkp = { x: p.x, z: p.z };
        }
      } else if (d <= CONFIG.AI_HEARS_HIDDEN_RADIUS) {
        // Hidden-breath leak (AI spec §6): a locker is NOT absolute safety — pass
        // right beside an occupied one and something is faintly audible. He can't
        // see or strike a hidden player; he just comes to linger. Dread as counter-
        // pressure against locker camping.
        this.awareness = Math.min(100, this.awareness + 30 * dt);
        this.lkp = { x: p.x, z: p.z };
      }

      // Sight: range (+lit bonus), LOS clear, within FOV (or beam visible).
      if (p.hidden) return;
      if (p.y > CONFIG.MELEE_MAX_DY) return; // elevated (booth) — the 2D AI can't see or reach up there
      const range = CONFIG.AI_VISION_RANGE + (p.light ? CONFIG.AI_VISION_RANGE_LIT_BONUS : 0);
      if (d > range) return;
      if (!this.nav.losClear(me.x, me.z, p.x, p.z)) return;
      const toAng = Math.atan2(-(p.x - me.x), -(p.z - me.z));
      const inFov = Math.abs(angleDiff(c.ry, toAng)) <= ((CONFIG.AI_VISION_FOV * Math.PI) / 180) / 2;
      if (inFov || p.light) {
        if (d < seenD) {
          seenD = d;
          seen = { id: p.id, x: p.x, z: p.z };
        }
      }
    });

    if (seen) {
      const s = seen as { id: string; x: number; z: number };
      this.awareness = 100;
      this.lkp = { x: s.x, z: s.z };
      this.chaseId = s.id;
      this.lastSeen = this.t;
    } else {
      this.awareness = Math.max(0, this.awareness - CONFIG.AI_AWARE_DECAY * dt);
    }

    // ---- Decide state + target ----
    let target: Pt | null;
    let st: string;
    const chaseP = this.chaseId ? state.players.get(this.chaseId) : undefined;

    if (chaseP && !chaseP.downed && this.t - this.lastSeen < CONFIG.AI_GIVEUP_S) {
      const d = Math.hypot(chaseP.x - me.x, chaseP.z - me.z);
      if (d <= CONFIG.MELEE_RANGE + CONFIG.CARETAKER_RADIUS && chaseP.y <= CONFIG.MELEE_MAX_DY) {
        // ATTACK — with a WINDUP (AI spec §8): the swing takes a beat to land,
        // and that beat is the player's dodge window. Sprinting clear of the
        // range before it lands = a whiffed swing, not a coin-flip death.
        c.aiState = "attack";
        c.ry = Math.atan2(-(chaseP.x - me.x), -(chaseP.z - me.z));
        if (this.windupUntil === 0 && this.t >= this.meleeReadyAt) {
          this.windupUntil = this.t + CONFIG.AI_MELEE_WINDUP_S; // raise the arm…
        } else if (this.windupUntil > 0 && this.t >= this.windupUntil) {
          this.windupUntil = 0;
          this.meleeReadyAt = this.t + CONFIG.AI_MELEE_COOLDOWN_S;
          onCatch(chaseP.id); // …and it lands (room decides: brick save vs downed)
          this.chaseId = null;
        }
        return; // hold position during the swing
      }
      this.windupUntil = 0; // target slipped out mid-swing — the whiff
      st = "chase";
      target = { x: chaseP.x, z: chaseP.z };
      this.lkp = target;
    } else if (this.chaseId) {
      this.windupUntil = 0;
      // Lost the target → SEARCH the last-known position, then give up.
      st = "search";
      if (this.searchUntil === 0) this.searchUntil = this.t + CONFIG.AI_SEARCH_S;
      target = this.lkp;
      if (this.t >= this.searchUntil || !this.lkp) {
        this.chaseId = null;
        this.searchUntil = 0;
        this.awareness = 0;
      }
    } else if (this.awareness >= CONFIG.AI_AWARE_INVESTIGATE && this.lkp) {
      st = "investigate";
      target = this.lkp;
      if (Math.hypot(this.lkp.x - me.x, this.lkp.z - me.z) < 1.5) {
        if (this.investigateUntil === 0) this.investigateUntil = this.t + CONFIG.AI_INVESTIGATE_S;
        if (this.t >= this.investigateUntil) {
          this.awareness = 0;
          this.lkp = null;
          this.investigateUntil = 0;
        }
      }
    } else {
      st = "patrol";
      if (!this.patrolTarget || Math.hypot(this.patrolTarget.x - me.x, this.patrolTarget.z - me.z) < 1.5) {
        this.patrolTarget = this.pickPatrol(me);
      }
      target = this.patrolTarget;
    }

    c.aiState = st;
    if (st !== "search") this.searchUntil = 0;
    if (st !== "investigate") this.investigateUntil = 0;

    if (target) this.moveToward(c, me, target, dt);
  }

  private pickPatrol(me: Pt): Pt {
    // Endgame (exit unlockable): pressure the far-back exit dash — haunt the back
    // door + the corridor approaching it, not the front deposit pad.
    if (this.guard && Math.random() < 0.8) return EXIT_GUARD[Math.floor(Math.random() * EXIT_GUARD.length)];
    const nodes = this.nav.nodeList();
    let best = nodes[0];
    let bestScore = -Infinity;
    for (const n of nodes) {
      const d = Math.hypot(n.x - me.x, n.z - me.z);
      const score = d + Math.random() * 22; // wander, but prefer somewhere new
      if (d > 4 && score > bestScore) {
        bestScore = score;
        best = n;
      }
    }
    return { x: best.x, z: best.z };
  }

  private moveToward(c: Caretaker, me: Pt, target: Pt, dt: number) {
    this.repathT -= dt;
    if (this.repathT <= 0 || this.path.length === 0) {
      this.path = this.nav.path(me, target);
      this.repathT = 0.5;
    }
    while (this.path.length > 1 && Math.hypot(this.path[0].x - me.x, this.path[0].z - me.z) < 0.8) {
      this.path.shift();
    }
    const wp = this.path[0] ?? target;
    const dx = wp.x - me.x;
    const dz = wp.z - me.z;
    const len = Math.hypot(dx, dz) || 1;
    const step = CONFIG.HUNTER_SPEED * dt;
    const nx = (dx / len) * step;
    const nz = (dz / len) * step;
    const m = CONFIG.CARETAKER_RADIUS;
    let moved = false;
    if (!this.nav.blocked(c.x + nx, c.z, m)) {
      c.x += nx;
      moved = true;
    }
    if (!this.nav.blocked(c.x, c.z + nz, m)) {
      c.z += nz;
      moved = true;
    }
    if (moved) c.ry = Math.atan2(-nx, -nz);
  }
}

function angleDiff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
