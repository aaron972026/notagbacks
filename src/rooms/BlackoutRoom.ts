import { Room, Client } from "colyseus";
import { CONFIG, MASK_IDS, TITLE_IDS, DARE_IDS, Phase, Role, HunterMode, REQUIRED_ITEM_KINDS, ItemKind, sanitizeOutfit } from "../shared/config";
import { DEFAULT_MAP, SOLO_LOOT_ROOMS, roomSpot, type DoorGap } from "../shared/map";

const DOOR_LOCK_S = 45; // how long a slammed door stays locked, then it reopens
const KILL_LIGHTS_S = 4; // duration of the total kill-the-lights blackout (also kills flashlights) — short, sharp scare; 30s cooldown (HUNTER_BLACKOUT_CD_S)

// Caretaker taunts (Hunter-triggered radial wheel). Index → sound bank id; the
// client sends an index, the server maps it (never trusts a client soundId).
const TAUNT_SOUNDS = ["taunt_dangerous", "taunt_smell", "taunt_comeout", "taunt_quiet", "taunt_why", "sting_no"];
const TAUNT_COOLDOWN_MS = 2500;
const STING_THROTTLE_MS = 700; // min gap between sting_no events
const ROAR_THROTTLE_MS = 4000; // min gap between alert_roar events

// Silly default names — comedy in the bones.
const NAME_ADJ = ["Sweaty", "Doomed", "Nervous", "Clumsy", "Spooky", "Hapless", "Jumpy", "Cursed", "Soggy", "Frantic", "Wobbly", "Greasy", "Anxious", "Twitchy"];
const NAME_NOUN = ["Larry", "Greg", "Karen", "Gizmo", "Noodle", "Biscuit", "Goose", "Pickle", "Wendy", "Chad", "Moose", "Turnip", "Kevin", "Beans"];
function sillyName(): string {
  return `${NAME_ADJ[Math.floor(Math.random() * NAME_ADJ.length)]} ${NAME_NOUN[Math.floor(Math.random() * NAME_NOUN.length)]}`;
}
import { GameState, Player, Item } from "../schema/GameState.js";
import { NavMap } from "../ai/NavMap.js";
import { CaretakerAI } from "../ai/Caretaker.js";

/** A movement update sent by a client (its locally-simulated pose). */
interface MoveMsg {
  x: number;
  y: number; // feet height (0 = floor; >0 when jumping / atop a box)
  z: number;
  ry: number; // yaw
  crouch?: boolean;
  hidden?: boolean; // hiding in a locker
  light?: boolean; // flashlight currently ON
  climb?: boolean; // Hunter clinging to a wall (visual state; y is still clamped)
}

// Max horizontal speed any player can legitimately reach (searcher run), plus a
// margin for network jitter. Used to reject teleport / speed cheats.
const MAX_SPEED = CONFIG.SEARCHER_RUN;
const SPEED_TOLERANCE = 1.6;
// World clamp derived from the data-driven map bounds (+ a small margin).
const HALF_W = DEFAULT_MAP.bounds.w / 2 + 1;
const HALF_D = DEFAULT_MAP.bounds.d / 2 + 1;
const MAX_Y = 6;
const PAD = DEFAULT_MAP.pad;
const EXIT = DEFAULT_MAP.exit;

function inZone(x: number, z: number, zone: { x: number; z: number; w: number; d: number }): boolean {
  return Math.abs(x - zone.x) <= zone.w / 2 && Math.abs(z - zone.z) <= zone.d / 2;
}

/**
 * The single game room. Authoritative over positions (Phase 3) and now the
 * lobby/roles (Phase 5): the host configures how the Hunter is chosen (pick a
 * player or rotate each round) and whether the Hunter is hidden, then starts the
 * match. Roles are assigned server-side; each client is told its own role
 * privately so a hidden Hunter can't be sniffed from shared state.
 */
export class BlackoutRoom extends Room<GameState> {
  maxClients = CONFIG.MAX_PLAYERS;

  /** Server timestamp of each player's last accepted move, for speed checks. */
  private lastMoveAt = new Map<string, number>();
  /** Per-player recent speed flag (running = loud), with freshness timestamp. */
  private running = new Map<string, { running: boolean; at: number }>();
  /** Authoritative roles (source of truth; shared state may conceal them). */
  private roles = new Map<string, Role>();
  /** Cursor for rotate-each-round Hunter selection. */
  private rotateIndex = 0;
  /** Solo (1 player vs AI Caretaker) vs multiplayer (a human is the Hunter). */
  private solo = true;
  /** Per-hunter melee cooldown timestamps. */
  private lastMelee = new Map<string, number>();
  private lastAxe = new Map<string, number>();
  /** Axes remaining this match (scarce pool, reset each round). */
  private axesLeft: number = CONFIG.AXE_POOL;
  /** Items the human Hunter still needs to place during HIDE (MP). */
  private pending: Array<{ id: string; kind: string; x: number; z: number }> = [];
  /** When each locked door auto-reopens (epoch ms). */
  private doorExpiry = new Map<string, number>();
  /** Last use timestamp per sabotage kind (for cooldowns). */
  private lastSab = new Map<string, number>();
  /** Last taunt timestamp per player (Caretaker taunt cooldown). */
  private lastTaunt = new Map<string, number>();
  /** Next time the AI Caretaker taunts on its own (0 = timer not armed yet). */
  private nextAiTauntAt = 0;
  /** AI Caretaker sabotage cooldowns (kill-lights, door-slam). */
  private aiLastLights = 0;
  private aiLastDoor = 0;
  /** Last drain timestamp per traitor (Drain the Light cooldown). */
  private lastDrain = new Map<string, number>();
  /** Last mark timestamp per traitor (Mark cooldown). */
  private lastMark = new Map<string, number>();
  /** Session ids that have used their one accusation this match. */
  private hasAccused = new Set<string>();
  /** True while an accusation hearing is mid-beat (one at a time). */
  private hearingActive = false;
  /** Traitor mode: who secretly carries the door key (latent until exposed). */
  private keyHolderId = "";
  /** Slam the Door finisher: one-shot, the trapped slammer, and who was inside. */
  private slamUsed = false;
  private slamTrappedId = ""; // the slammer forfeits their own escape
  private slamInsideIds: string[] = []; // searchers inside at slam time (for the shutout tally)
  /** Throttles for the automatic contextual stings. */
  private lastSting = 0;
  private lastRoar = 0;
  /** Previous AI state, to detect the Caretaker FIRST spotting a searcher. */
  private prevAiState = "idle";
  /** roomId → its doorway ids (for the never-fully-seal-a-room rule). */
  private roomDoors = new Map<string, string[]>();
  /** session ids with proximity voice enabled. */
  private voiceOn = new Set<string>();
  /** Night Report — per-round movement/hiding tallies + catch/escape order. */
  private nightRun = new Map<string, number>(); // seconds spent running
  private nightHidden = new Map<string, number>(); // seconds spent in lockers
  private nightMoveAt = new Map<string, number>(); // last tally timestamp
  private caughtOrder: string[] = [];
  private escapeTimes = new Map<string, number>(); // sessionId → seconds after blackout
  private blackoutAt = 0; // epoch ms when the blackout began
  /** Last troll timestamp per downed player (cooldown). */
  private lastTroll = new Map<string, number>();
  /** Report throttle per player. */
  private lastReport = new Map<string, number>();

  private nav = new NavMap();
  private ai = new CaretakerAI(this.nav);

  onCreate(options: { code?: string }) {
    const code = (options.code ?? "").toUpperCase();
    this.setState(new GameState());
    this.state.code = code;
    this.state.hunterMode = HunterMode.ROTATE;
    this.state.hiddenHunter = false; // the Hunter is shown from the start (no hidden-hunter mode)
    this.syncMetadata();
    this.setPatchRate(1000 / CONFIG.PATCH_RATE_HZ);

    this.onMessage("move", (client, msg: MoveMsg) => this.handleMove(client, msg));

    // Phase clock: tick once a second, advancing timed phases.
    this.clock.setInterval(() => this.tickPhase(), 1000);
    // Sabotage upkeep: expire locked doors + the kill-lights timer.
    this.clock.setInterval(() => this.tickSabotage(), 1000);

    // Map roomId → its doorways (for the never-seal-a-room rule).
    for (const d of DEFAULT_MAP.doors) {
      for (const r of d.rooms) {
        const a = this.roomDoors.get(r) ?? [];
        a.push(d.id);
        this.roomDoors.set(r, a);
      }
    }

    // Simulation loop: drives the AI Caretaker.
    this.setSimulationInterval((deltaMs) => this.simulate(deltaMs), 1000 / CONFIG.SIM_RATE_HZ);

    // ---- Host-only lobby controls ----
    this.onMessage("setHunterMode", (client, msg: { mode?: string }) => {
      if (!this.isHost(client) || this.state.phase !== Phase.LOBBY) return;
      if (msg?.mode === HunterMode.PICK || msg?.mode === HunterMode.ROTATE) {
        this.state.hunterMode = msg.mode;
      }
    });
    this.onMessage("pickHunter", (client, msg: { playerId?: string }) => {
      if (!this.isHost(client) || this.state.phase !== Phase.LOBBY) return;
      if (msg?.playerId && this.state.players.has(msg.playerId)) {
        this.state.pickedHunterId = msg.playerId;
      }
    });
    this.onMessage("setTraitorMode", (client, msg: { value?: boolean }) => {
      if (!this.isHost(client) || this.state.phase !== Phase.LOBBY) return;
      this.state.traitorMode = !!msg?.value;
    });
    this.onMessage("setAxeThrows", (client, msg: { value?: boolean }) => {
      if (!this.isHost(client) || this.state.phase !== Phase.LOBBY) return;
      this.state.axeThrows = !!msg?.value;
    });
    this.onMessage("setFlashlights", (client, msg: { scarcity?: boolean }) => {
      if (!this.isHost(client) || this.state.phase !== Phase.LOBBY) return;
      this.state.flashlightScarcity = !!msg?.scarcity;
    });
    this.onMessage("setAiHunter", (client, msg: { value?: boolean }) => {
      if (!this.isHost(client) || this.state.phase !== Phase.LOBBY) return;
      this.state.aiHunter = !!msg?.value;
    });
    this.onMessage("setGlobalVoice", (client, msg: { value?: boolean }) => {
      if (!this.isHost(client) || this.state.phase !== Phase.LOBBY) return;
      this.state.globalVoice = !!msg?.value;
    });
    this.onMessage("setHunterRadar", (client, msg: { value?: boolean }) => {
      if (!this.isHost(client) || this.state.phase !== Phase.LOBBY) return;
      this.state.hunterRadar = !!msg?.value;
    });
    this.onMessage("setPublic", (client, msg: { value?: boolean }) => {
      if (!this.isHost(client) || this.state.phase !== Phase.LOBBY) return;
      this.state.isPublic = !!msg?.value;
      this.syncMetadata();
    });
    this.onMessage("setName", (client, msg: { name?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const n = (msg?.name ?? "").trim().slice(0, 16);
      if (n) p.name = n; // ignore blanks so a player keeps a usable name
    });
    // Cosmetic mask — whitelist-validated ("" clears). Unlock progress is
    // client-side (no accounts); masks are cosmetic, so that trust is fine.
    this.onMessage("setMask", (client, msg: { mask?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const m = msg?.mask ?? "";
      if (m === "" || (MASK_IDS as readonly string[]).includes(m)) p.mask = m;
    });
    this.onMessage("setTitle", (client, msg: { title?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const t = msg?.title ?? "";
      if (t === "" || (TITLE_IDS as readonly string[]).includes(t)) p.title = t;
    });
    // Character outfit — format-validated JSON (cosmetic; see sanitizeOutfit).
    this.onMessage("setOutfit", (client, msg: { outfit?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.outfit = sanitizeOutfit(msg?.outfit ?? "");
    });
    this.onMessage("setRoomName", (client, msg: { name?: string }) => {
      if (!this.isHost(client) || this.state.phase !== Phase.LOBBY) return;
      this.state.roomName = (msg?.name ?? "").trim().slice(0, 24);
      this.syncMetadata();
    });
    // Searcher whistle taunt → reveal their spot to the Hunter for 5s + everyone hears it.
    this.onMessage("whistle", (client) => {
      if (this.roles.get(client.sessionId) === Role.HUNTER) return;
      const ph = this.state.phase;
      if (ph !== Phase.BLACKOUT && ph !== Phase.ESCAPE) return;
      const p = this.state.players.get(client.sessionId);
      if (!p || p.downed || p.escaped) return;
      this.clients
        .find((c) => this.roles.get(c.sessionId) === Role.HUNTER)
        ?.send("ping", { x: p.x, z: p.z });
      // Positional: everyone hears WHERE the whistle came from (distance falloff
      // client-side) — it's a location taunt, not a global jingle.
      this.broadcast("whistle", { x: p.x, z: p.z }, { except: client });
    });
    this.onMessage("traitorPing", (client) => {
      if (this.roles.get(client.sessionId) !== Role.TRAITOR) return;
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      this.clients
        .find((c) => this.roles.get(c.sessionId) === Role.HUNTER)
        ?.send("ping", { x: p.x, z: p.z });
      this.traitorWhisper(p); // any traitor power → quiet positional tell
    });
    this.onMessage("setTimers", (client, msg: { hide?: number; lightsOn?: number; round?: number }) => {
      if (!this.isHost(client) || this.state.phase !== Phase.LOBBY) return;
      if (isFiniteNum(msg?.hide)) this.state.hideTime = clamp(Math.round(msg.hide!), 30, 300);
      if (isFiniteNum(msg?.lightsOn)) this.state.lightsOnTime = clamp(Math.round(msg.lightsOn!), 10, 90);
      if (isFiniteNum(msg?.round)) this.state.roundTime = clamp(Math.round(msg.round!), 60, 600);
    });
    this.onMessage("startMatch", (client) => {
      if (!this.isHost(client) || this.state.phase !== Phase.LOBBY) return;
      this.startMatch();
    });
    this.onMessage("rematch", (client) => {
      if (!this.isHost(client) || this.state.phase !== Phase.CAMPFIRE) return;
      this.startMatch(); // instant rematch — roles rotate
    });
    // ---- Proximity voice: WebRTC signaling relay + presence ----
    this.onMessage("signal", (client, msg: { to?: string; kind?: string; payload?: unknown }) => {
      if (!msg?.to) return;
      this.clients
        .find((c) => c.sessionId === msg.to)
        ?.send("signal", { from: client.sessionId, kind: msg.kind, payload: msg.payload });
    });
    this.onMessage("voiceState", (client, msg: { on?: boolean }) => {
      if (msg?.on) {
        client.send("voicePeers", { ids: [...this.voiceOn] }); // who's already talking
        this.voiceOn.add(client.sessionId);
      } else {
        this.voiceOn.delete(client.sessionId);
      }
      this.broadcast("voiceState", { id: client.sessionId, on: !!msg?.on }, { except: client });
    });

    this.onMessage("melee", (client) => this.handleMelee(client));
    this.onMessage("throwAxe", (client) => this.handleAxe(client));
    this.onMessage("taunt", (client, msg: { index?: number }) => this.handleTaunt(client, msg?.index));
    this.onMessage("sabotage", (client, msg: { kind?: string }) => this.handleSabotage(client, msg?.kind));
    this.onMessage("drain", (client) => this.handleDrain(client));
    this.onMessage("mark", (client) => this.handleMark(client));
    this.onMessage("accuse", (client, msg: { targetId?: string }) => this.handleAccuse(client, msg?.targetId));
    this.onMessage("slam", (client) => this.handleSlam(client));
    this.onMessage("emote", (client, msg: { emoji?: string }) => {
      const e = msg?.emoji;
      if (!e || e.length > 8) return;
      this.broadcast("emote", { id: client.sessionId, emoji: e }, { except: client });
    });
    this.onMessage("troll", (client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !p.downed) return; // only the dead can troll
      const now = Date.now();
      if (now - (this.lastTroll.get(client.sessionId) ?? -1e9) < CONFIG.DEAD_TROLL_COOLDOWN_S * 1000) return;
      this.lastTroll.set(client.sessionId, now);
      this.broadcast("troll", { x: p.x, z: p.z }, { except: client });
    });
    this.onMessage("placeItem", (client, msg: { x?: number; z?: number }) => {
      if (this.roles.get(client.sessionId) !== Role.HUNTER) return;
      if (this.state.phase !== Phase.HIDE || this.pending.length === 0) return;
      if (!isFiniteNum(msg?.x) || !isFiniteNum(msg?.z)) return;
      const next = this.pending.shift()!;
      this.addItem(next.id, next.kind, clamp(msg.x!, -HALF_W, HALF_W), clamp(msg.z!, -HALF_D, HALF_D));
      this.sendPlacement(client);
    });
    // Hunter is done hiding early → skip the rest of the HIDE timer. Anything
    // left unplaced auto-places (same path as the timer running out).
    this.onMessage("endHide", (client) => {
      if (this.roles.get(client.sessionId) !== Role.HUNTER) return;
      if (this.state.phase !== Phase.HIDE) return;
      this.state.timeLeft = 0;
      this.advancePhase();
    });
    // Hunter picks a placed item back up during HIDE to reposition it.
    this.onMessage("pickUpItem", (client, msg: { x?: number; z?: number }) => {
      if (this.roles.get(client.sessionId) !== Role.HUNTER) return;
      if (this.state.phase !== Phase.HIDE) return;
      if (!isFiniteNum(msg?.x) || !isFiniteNum(msg?.z)) return;
      let best: Item | undefined;
      let bestD = 3; // grab the placed item nearest your aim point
      this.state.items.forEach((it) => {
        if (it.deposited || it.carriedBy) return;
        const d = Math.hypot(it.x - msg.x!, it.z - msg.z!);
        if (d < bestD) {
          bestD = d;
          best = it;
        }
      });
      if (!best) return;
      this.state.items.delete(best.id);
      this.pending.unshift({ id: best.id, kind: best.kind, x: best.x, z: best.z }); // re-place next
      this.sendPlacement(client);
    });
    this.onMessage("pickup", (client, msg: { itemId?: string }) => {
      if (this.roles.get(client.sessionId) === Role.HUNTER) return; // hunter can't loot
      const item = msg?.itemId ? this.state.items.get(msg.itemId) : undefined;
      if (!item || item.carriedBy || item.deposited) return;
      // Loot only exists to the searchers during the hunt. One exception:
      // flashlights sit at the spawn and may be grabbed while the lights are
      // still on (nobody should fumble for their own light in the dark).
      const ph = this.state.phase;
      const hunting = ph === Phase.BLACKOUT || ph === Phase.ESCAPE;
      if (!hunting && !(ph === Phase.LIGHTS_ON && item.kind === "flashlight")) return;
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (Math.hypot(p.x - item.x, p.z - item.z) > CONFIG.PICKUP_RADIUS + 0.7) return;
      if (item.kind === "door_key") {
        // Route 2 (§3/§5): grabbing the dropped traitor key unlocks the front
        // doors server-side and starts the dash. The key is consumed.
        this.state.items.delete(item.id);
        if (!this.state.doorsOpen) {
          this.state.doorsOpen = true;
          console.log(`[BlackoutRoom] ${p.name} took the traitor's key — doors unlocked`);
          this.broadcast("sound", { soundId: "door_unlock", x: EXIT.x, z: EXIT.z });
        }
        return;
      }
      item.carriedBy = client.sessionId;
    });
    this.onMessage("returnToLobby", (client) => {
      if (!this.isHost(client)) return;
      this.returnToLobby();
    });
    // Player report — logged server-side (visible in Colyseus Cloud logs), which
    // is the moderation paper-trail the app stores require. Throttled.
    this.onMessage("report", (client, msg: { targetId?: string; reason?: string }) => {
      const now = Date.now();
      if (now - (this.lastReport.get(client.sessionId) ?? 0) < 10_000) return;
      this.lastReport.set(client.sessionId, now);
      const reporter = this.state.players.get(client.sessionId);
      const target = msg?.targetId ? this.state.players.get(msg.targetId) : undefined;
      if (!reporter || !target || target.id === client.sessionId) return;
      const reason = String(msg?.reason ?? "").slice(0, 140);
      console.warn(
        `[REPORT] room=${this.state.code} ${reporter.name}(${client.sessionId}) → ${target.name}(${target.id}): ${reason || "(no reason)"}`,
      );
      client.send("reported", {});
    });
    this.onMessage("revive", (client) => {
      const reviver = this.state.players.get(client.sessionId);
      if (!reviver || reviver.downed || reviver.escaped) return;
      let brick: Item | undefined;
      this.state.items.forEach((it) => {
        if (it.carriedBy === client.sessionId && it.kind === "golden_brick") brick = it;
      });
      if (!brick) return;
      let target: Player | undefined;
      this.state.players.forEach((p) => {
        if (p.id === client.sessionId || !p.downed || p.escaped) return;
        if (Math.hypot(p.x - reviver.x, p.z - reviver.z) <= CONFIG.REVIVE_RANGE + 0.6) target = p;
      });
      if (!target) return;
      target.downed = false;
      this.state.items.delete(brick.id); // consumed
      client.send("revived", {}); // ack → the reviver's profile stats
      console.log(`[BlackoutRoom] ${reviver.name} revived ${target.name}`);
    });

    console.log(`[BlackoutRoom] created code=${code} (${this.roomId})`);
  }

  onJoin(
    client: Client,
    options: { name?: string; spawn?: { x: number; z: number; ry: number }; protocol?: number },
  ) {
    // Version handshake: client + server deploy separately; a stale client gets
    // a clear error instead of undebuggable schema-decode weirdness.
    if ((options.protocol ?? 0) !== CONFIG.PROTOCOL_VERSION) {
      throw new Error("Update required — your game version doesn't match the server.");
    }
    // No mid-match joins: a joiner during a live round would have no role — an
    // un-downable "ghost" that can still loot and win. Lobby/campfire only.
    const ph = this.state.phase;
    if (ph !== Phase.LOBBY && ph !== Phase.CAMPFIRE) {
      throw new Error("Match in progress — try again when the round ends.");
    }
    const player = new Player();
    player.id = client.sessionId;
    player.name = options.name?.slice(0, 16) || sillyName();
    if (options.spawn) {
      player.x = options.spawn.x;
      player.z = options.spawn.z;
      player.ry = options.spawn.ry;
    }
    this.state.players.set(client.sessionId, player);
    this.lastMoveAt.set(client.sessionId, Date.now());

    // First player in becomes host.
    if (!this.state.hostId) this.state.hostId = client.sessionId;

    this.syncMetadata();
    console.log(
      `[BlackoutRoom] ${player.name} joined (${this.state.players.size}/${this.maxClients})`,
    );
  }

  async onLeave(client: Client, consented: boolean) {
    // Reconnection grace: a wifi blip or refresh during a live round should be a
    // 30-second hiccup, not a deleted player. The body is kept (flagged
    // disconnected → clients hide it, the Caretaker ignores it); on return the
    // client is re-sent its role + current pose so its camera snaps back.
    const graceP = this.state.players.get(client.sessionId);
    const graceLive = (() => {
      const ph = this.state.phase;
      return ph === Phase.HIDE || ph === Phase.LIGHTS_ON || ph === Phase.BLACKOUT || ph === Phase.ESCAPE;
    })();
    if (!consented && graceLive && graceP) {
      graceP.connected = false;
      console.log(`[BlackoutRoom] ${graceP.name} lost connection — holding a 30s seat`);
      try {
        await this.allowReconnection(client, 30);
        graceP.connected = true;
        // Re-send the private role + current pose a beat later — the reconnected
        // client needs a moment to re-register its message handlers, and this
        // snap puts its camera back on its (server-kept) body.
        this.clock.setTimeout(() => {
          client.send("yourRole", {
            role: this.roles.get(client.sessionId) ?? Role.SEARCHER,
            spawn: { x: graceP.x, y: graceP.y, z: graceP.z, ry: graceP.ry },
          });
        }, 400);
        console.log(`[BlackoutRoom] ${graceP.name} reconnected`);
        return;
      } catch {
        // Grace expired — fall through to the permanent removal below.
      }
    }

    const leaving = this.state.players.get(client.sessionId);
    const leavingRole = this.roles.get(client.sessionId);
    const ph = this.state.phase;
    const live =
      ph === Phase.HIDE || ph === Phase.LIGHTS_ON || ph === Phase.BLACKOUT || ph === Phase.ESCAPE;
    // Drop anything they were carrying back onto the floor where they stood.
    this.state.items.forEach((item) => {
      if (item.carriedBy === client.sessionId) {
        item.carriedBy = "";
        if (leaving) {
          item.x = leaving.x;
          item.z = leaving.z;
        }
      }
    });
    // The traitor bailed mid-round: the door key falls where they stood so the
    // deduction route isn't silently dead (and accusations aren't guaranteed-wrong).
    if (live && leavingRole === Role.TRAITOR && this.keyHolderId === client.sessionId && leaving) {
      this.addItem("door_key", "door_key", leaving.x, leaving.z);
      this.keyHolderId = "";
      this.broadcast("hearing", { text: `${leaving.name} vanished — something metallic hit the floor…` });
    }
    this.state.players.delete(client.sessionId);
    this.lastMoveAt.delete(client.sessionId);
    this.running.delete(client.sessionId);
    this.lastMelee.delete(client.sessionId);
    this.lastAxe.delete(client.sessionId);
    this.voiceOn.delete(client.sessionId);
    this.lastTroll.delete(client.sessionId);
    this.roles.delete(client.sessionId);

    // Reassign host if the host left.
    if (this.state.hostId === client.sessionId) {
      const next = this.state.players.keys().next();
      this.state.hostId = next.done ? "" : next.value;
    }

    if (live) {
      if (leavingRole === Role.HUNTER && !this.solo) {
        // The human Hunter dropped: without a monster there is no round (and
        // during HIDE everyone would sit frozen). Searchers take the night.
        this.broadcast("hearing", { text: "The Hunter has fled the building — the searchers win the night." });
        this.endRound("searchers");
      } else {
        // If no searchers remain (everyone but the Hunter left), stop the round.
        let searchersLeft = 0;
        this.state.players.forEach((p) => {
          if (this.roles.get(p.id) === Role.SEARCHER || this.roles.get(p.id) === Role.TRAITOR) searchersLeft++;
        });
        if (searchersLeft === 0) this.returnToLobby();
        else this.checkRoundEnd(); // the leaver may have been the last one still inside
      }
    }

    this.syncMetadata();
    console.log(
      `[BlackoutRoom] ${client.sessionId} left (${this.state.players.size}/${this.maxClients})`,
    );
  }

  // ---- Lobby / roles ----

  private isHost(client: Client): boolean {
    return client.sessionId === this.state.hostId;
  }

  /** Mirror browse-relevant fields into room metadata (drives GET /lobbies). */
  private syncMetadata() {
    void this.setMetadata({
      code: this.state.code,
      public: this.state.isPublic,
      name: this.state.roomName,
      phase: this.state.phase,
    });
  }

  private startMatch() {
    const ids = [...this.state.players.keys()];
    if (ids.length === 0) return;

    // AI Caretaker hunts when playing solo OR when the host picked co-op vs AI;
    // otherwise a human plays the Hunter. (`solo` = "the AI is the Hunter".)
    this.solo = ids.length < 2 || this.state.aiHunter;

    // Choose the Hunter. When the AI hunts, every human is a Searcher.
    let hunterId = "";
    if (!this.solo) {
      if (this.state.hunterMode === HunterMode.PICK) {
        hunterId =
          this.state.pickedHunterId && this.state.players.has(this.state.pickedHunterId)
            ? this.state.pickedHunterId
            : ids[Math.floor(Math.random() * ids.length)];
      } else {
        hunterId = ids[this.rotateIndex % ids.length];
        this.rotateIndex++;
      }
    }

    // Fresh round: clear any downed / escaped / outcome / pad / sabotage state.
    this.state.outcome = "";
    this.state.deposited = 0;
    this.state.doorsOpen = false;
    this.axesLeft = CONFIG.AXE_POOL;
    // Tonight's Dare: usually one, sometimes a quiet night (keeps it special).
    this.state.dare = Math.random() < 0.65 ? DARE_IDS[Math.floor(Math.random() * DARE_IDS.length)] : "";
    // Fresh Night Report ledger.
    this.nightRun.clear();
    this.nightHidden.clear();
    this.nightMoveAt.clear();
    this.caughtOrder = [];
    this.escapeTimes.clear();
    this.blackoutAt = 0;
    this.clearSabotage();
    this.state.players.forEach((p) => {
      p.downed = false;
      p.escaped = false;
      p.hidden = false;
    });

    // Assign authoritative roles.
    this.roles.clear();
    for (const id of ids) {
      this.roles.set(id, id === hunterId ? Role.HUNTER : Role.SEARCHER);
    }

    // Respawn everyone at their match-start spots. Without this, rematches
    // resume from wherever players ended up — escapees OUTSIDE the building,
    // downed spectators wherever their free-fly camera floated.
    const spawns = DEFAULT_MAP.searcherSpawns;
    const spawnFor = new Map<string, { x: number; y: number; z: number; ry: number }>();
    let si = 0;
    for (const id of ids) {
      const p = this.state.players.get(id)!;
      let sp: { x: number; y: number; z: number; ry: number };
      if (id === hunterId) {
        sp = { x: DEFAULT_MAP.hunterSpawn.x, y: 0, z: DEFAULT_MAP.hunterSpawn.z, ry: 0 };
      } else {
        const s = spawns[si++ % spawns.length];
        sp = { x: s.x, y: 0, z: s.z, ry: Math.PI };
      }
      p.x = sp.x;
      p.y = sp.y;
      p.z = sp.z;
      p.ry = sp.ry;
      spawnFor.set(id, sp);
      // Fresh movement clock, so the first post-spawn move isn't judged against
      // a stale timestamp (a huge dt makes the speed clamp vacuous).
      this.lastMoveAt.set(id, Date.now());
    }

    // Traitor mode: secretly flip one searcher (needs ≥2 searchers so a real one remains).
    const searchers = ids.filter((id) => this.roles.get(id) === Role.SEARCHER);
    let traitorId = "";
    if (this.state.traitorMode && searchers.length >= 2) {
      traitorId = searchers[Math.floor(Math.random() * searchers.length)];
      this.roles.set(traitorId, Role.TRAITOR);
      this.keyHolderId = traitorId; // the traitor secretly carries the door key (§2/§3)
    }

    // Reflect into shared state (concealed: Hunter if hidden-Hunter; Traitor always).
    this.applyRoles("start");

    // Tell each client its OWN role privately (works even when concealed), plus
    // its authoritative spawn so the local camera snaps to the round start.
    for (const c of this.clients) {
      c.send("yourRole", {
        role: this.roles.get(c.sessionId) ?? Role.SEARCHER,
        spawn: spawnFor.get(c.sessionId),
      });
    }
    // Let the Hunter know their secret ally.
    if (traitorId) {
      this.clients.find((c) => c.sessionId === hunterId)?.send("traitor", { id: traitorId });
    }

    const searcherCount = ids.filter((id) => this.roles.get(id) !== Role.HUNTER).length;
    // Always need all 3 escape items, whatever the team size.
    this.state.requiredItems = CONFIG.REQUIRED_ITEMS;
    this.state.items.clear();
    // Flashlights: ALWAYS auto-placed in view of the spawn (never Hunter-placed).
    // Default = one per searcher; "buddy-up" scarcity (host option) = one fewer,
    // so somebody has to share.
    const flashlights = this.state.flashlightScarcity
      ? CONFIG.flashlightsFor(searcherCount)
      : searcherCount;
    this.placeFlashlights(flashlights);
    // The rest (required items + golden brick): solo auto-places; multiplayer has
    // the Hunter place it during HIDE.
    if (this.solo) {
      // Solo: randomize each required item + the golden brick among candidate
      // rooms so the hunt isn't the same every game.
      for (const l of this.buildSoloLoot()) this.addItem(l.id, l.kind, l.x, l.z);
      this.pending = [];
    } else {
      const loot = this.buildLoot();
      this.pending = loot;
      const hunterClient = this.clients.find((c) => this.roles.get(c.sessionId) === Role.HUNTER);
      if (hunterClient) this.sendPlacement(hunterClient);
    }

    // SOLO auto-places loot, so skip the human HIDE phase and go straight to
    // LIGHTS ON. Multiplayer keeps HIDE (hunter-only) before searchers spawn.
    if (this.solo) {
      this.state.phase = Phase.LIGHTS_ON;
      this.state.timeLeft = this.state.lightsOnTime;
    } else {
      this.state.phase = Phase.HIDE;
      this.state.timeLeft = this.state.hideTime;
    }
    this.syncMetadata(); // drop off the public browser while the match runs
    console.log(
      `[BlackoutRoom] match started — ${this.solo ? "solo/AI" : "MP hunter=" + hunterId} searchers=${searcherCount} items=${this.state.items.size}`,
    );
  }

  /**
   * Push roles into shared state at the right secrecy level:
   *  - "start":    Hunter concealed if hidden-Hunter; Traitor concealed.
   *  - "blackout": Hunter revealed (renders as the Caretaker); Traitor still concealed.
   *  - "end":      everything revealed — the "IT WAS YOU?!" moment.
   */
  /** Hide/show the Hunter's avatar for everyone (used to make the frozen
   *  lights-on Caretaker invisible). The local Hunter is first-person, so this
   *  only affects how OTHER clients render them. */
  private setHunterHidden(v: boolean) {
    this.state.players.forEach((p, id) => {
      if (this.roles.get(id) === Role.HUNTER) p.hidden = v;
    });
  }

  private applyRoles(stage: "start" | "blackout" | "end") {
    this.state.players.forEach((p, id) => {
      const actual = this.roles.get(id) ?? Role.SEARCHER;
      if (actual === Role.HUNTER) {
        p.role = stage === "start" && this.state.hiddenHunter ? Role.SEARCHER : Role.HUNTER;
      } else if (actual === Role.TRAITOR) {
        p.role = stage === "end" ? Role.TRAITOR : Role.SEARCHER;
      } else {
        p.role = Role.SEARCHER;
      }
    });
  }

  /** Decrement the phase timer and advance when it hits zero. */
  private tickPhase() {
    const s = this.state;
    const timed =
      s.phase === Phase.HIDE ||
      s.phase === Phase.LIGHTS_ON ||
      s.phase === Phase.BLACKOUT ||
      s.phase === Phase.ENDED ||
      s.phase === Phase.CAMPFIRE;
    if (!timed) return;
    if (s.timeLeft > 0) s.timeLeft--;
    if (s.timeLeft <= 0) this.advancePhase();
  }

  private advancePhase() {
    const s = this.state;
    if (s.phase === Phase.HIDE) {
      this.autoPlaceRemaining(); // anything the Hunter didn't place lands on defaults
      s.phase = Phase.LIGHTS_ON;
      s.timeLeft = s.lightsOnTime;
      // The Caretaker is frozen with the lights on — make it invisible to the
      // searchers entirely (its avatar hides; identity isn't leaked).
      this.setHunterHidden(true);
    } else if (s.phase === Phase.LIGHTS_ON) {
      s.phase = Phase.BLACKOUT;
      s.timeLeft = s.roundTime;
      this.blackoutAt = Date.now(); // Night Report escape-time baseline
      this.setHunterHidden(false); // the hunt begins — the Caretaker reappears
      this.applyRoles("blackout"); // the Hunter's identity is exposed at blackout
    } else if (s.phase === Phase.BLACKOUT) {
      // Timed out — survivors still inside count as caught: the night ran out on
      // them. Run the same escape quota as any other ending so a winner is set.
      this.resolveTimeout();
      return; // endRound already advanced the phase + set the timer
    } else if (s.phase === Phase.ENDED) {
      s.phase = Phase.CAMPFIRE; // regroup
      s.timeLeft = CONFIG.CAMPFIRE_S;
    } else if (s.phase === Phase.CAMPFIRE) {
      this.startMatch(); // auto-rematch when the campfire timer runs out
      return;
    }
    this.syncMetadata();
    console.log(`[BlackoutRoom] phase → ${s.phase}`);
  }

  /** Per-frame simulation: release & drive the Caretaker during the hunt. */
  private simulate(deltaMs: number) {
    const dt = deltaMs / 1000;
    const s = this.state;
    const hunting = s.phase === Phase.BLACKOUT || s.phase === Phase.ESCAPE;

    if (hunting) {
      // AI Caretaker only in solo; in multiplayer a human is the Hunter.
      if (this.solo) {
        if (!s.caretaker.active) this.ai.activate(s, DEFAULT_MAP.hunterSpawn);
        this.ai.update(
          dt,
          s,
          (id) => this.isRunning(id),
          (id) => this.onCatch(id),
          // Co-op + traitor: the AI never hunts its own ally (the human Hunter
          // can't melee the traitor either) — nor a body in reconnection grace.
          (id) =>
            this.roles.get(id) !== Role.TRAITOR &&
            (this.state.players.get(id)?.connected ?? true),
        );
        // First sighting: the Caretaker roars when it acquires a target (a
        // transition into chase/attack from a calmer state). Throttled.
        const now = Date.now();
        const alerted = s.caretaker.aiState === "chase" || s.caretaker.aiState === "attack";
        const wasCalm = this.prevAiState !== "chase" && this.prevAiState !== "attack";
        if (alerted && wasCalm && now - this.lastRoar > ROAR_THROTTLE_MS) {
          this.lastRoar = now;
          this.emitSting("alert_roar", { x: s.caretaker.x, z: s.caretaker.z });
        }
        this.prevAiState = s.caretaker.aiState;
        // The AI works the taunt wheel too: an occasional positional growl-line
        // from wherever he is — the searchers get the same dread a chatty human
        // Hunter deals out. (First check only arms the timer; no boot-up taunt.)
        if (now >= this.nextAiTauntAt) {
          if (this.nextAiTauntAt !== 0 && s.caretaker.active) {
            const i = Math.floor(Math.random() * (TAUNT_SOUNDS.length - 1)); // skip sting_no
            this.broadcast("sound", { soundId: TAUNT_SOUNDS[i], x: s.caretaker.x, z: s.caretaker.z });
          }
          this.nextAiTauntAt = now + 20_000 + Math.random() * 10_000;
        }
        this.aiSabotage(now); // kill-lights + door-slam, on their own cooldowns
      }
      this.checkRoundEnd(); // resolves caught / escaped outcomes
    } else if (s.caretaker.active) {
      this.ai.deactivate(s);
    }
  }

  /** The Caretaker landed a hit: golden brick saves you once, else you're downed. */
  private onCatch(id: string) {
    const p = this.state.players.get(id);
    if (!p || p.downed || p.escaped) return;
    // The Caretaker landed an attack — it roars (positional, heard by all).
    this.lastRoar = Date.now();
    this.emitSting("alert_roar", { x: p.x, z: p.z });
    let brick: Item | undefined;
    this.state.items.forEach((it) => {
      if (it.carriedBy === id && it.kind === "golden_brick") brick = it;
    });
    if (brick) {
      this.state.items.delete(brick.id); // consumed
      this.clients.find((c) => c.sessionId === id)?.send("saved");
      console.log(`[BlackoutRoom] ${p.name} was saved by the golden brick`);
      return;
    }
    p.downed = true;
    // Drop everything they carried where they fell — the loot must stay
    // recoverable. A dead carrier otherwise keeps items "in hand" forever:
    // the deposit quota can become unwinnable, and the client renders the
    // ghost's flashlight/loot as phantom items.
    this.state.items.forEach((it) => {
      if (it.carriedBy === id) {
        it.carriedBy = "";
        it.x = p.x;
        it.z = p.z;
      }
    });
    if (!this.caughtOrder.includes(id)) this.caughtOrder.push(id); // Night Report: "The Bait"
  }

  private isRunning(id: string): boolean {
    const r = this.running.get(id);
    return !!r && r.running && Date.now() - r.at < 400;
  }

  /** BLACKOUT timer expiry: anyone still inside is counted as caught, then the
   *  usual quota decides the night (≥ half escaped → searchers). */
  private resolveTimeout() {
    let total = 0;
    let escaped = 0;
    this.state.players.forEach((p) => {
      if (this.roles.get(p.id) !== Role.SEARCHER) return;
      total++;
      if (p.escaped) escaped++;
    });
    this.endRound(total > 0 && escaped * 2 >= total ? "searchers" : "hunter");
  }

  private endRound(outcome: "hunter" | "searchers") {
    if (this.state.phase === Phase.ENDED || this.state.phase === Phase.CAMPFIRE) return;
    this.state.outcome = outcome;
    this.state.phase = Phase.ENDED;
    this.state.timeLeft = CONFIG.ROUND_END_S; // result splash, then → campfire
    this.applyRoles("end"); // reveal the Traitor at the end
    this.ai.deactivate(this.state);
    this.broadcast("nightReport", { lines: this.buildNightReport() });
    this.syncMetadata();
    console.log(`[BlackoutRoom] round over — ${outcome} win`);
  }

  /** Night Report — end-of-round superlatives (the campfire's comedy beat).
   *  Computed from server-side tallies so every client sees the same report. */
  private buildNightReport(): Array<{ title: string; name: string; detail: string }> {
    const lines: Array<{ title: string; name: string; detail: string }> = [];
    const nameOf = (id: string) => this.state.players.get(id)?.name ?? "someone";
    const nonHunters = [...this.state.players.values()].filter(
      (p) => this.roles.get(p.id) !== Role.HUNTER,
    );
    const top = (m: Map<string, number>, floor: number): { id: string; v: number } | null => {
      let bi = "";
      let bv = floor;
      for (const p of nonHunters) {
        const v = m.get(p.id) ?? 0;
        if (v > bv) {
          bv = v;
          bi = p.id;
        }
      }
      return bi ? { id: bi, v: bv } : null;
    };

    const run = top(this.nightRun, 6);
    if (run) lines.push({ title: "Loudest Sneaker", name: nameOf(run.id), detail: `${Math.round(run.v)}s of sprinting` });
    const hid = top(this.nightHidden, 8);
    if (hid) lines.push({ title: "The Ghost", name: nameOf(hid.id), detail: `${Math.round(hid.v)}s in lockers` });
    if (this.caughtOrder.length > 0) {
      lines.push({ title: "The Bait", name: nameOf(this.caughtOrder[0]), detail: "first one caught" });
    }
    let fid = "";
    let fv = Infinity;
    for (const [id, t] of this.escapeTimes) {
      if (t < fv) {
        fv = t;
        fid = id;
      }
    }
    if (fid) lines.push({ title: "Track Star", name: nameOf(fid), detail: `out in ${fv.toFixed(1)}s` });
    if (nonHunters.length >= 3) {
      let qi = "";
      let qv = Infinity;
      for (const p of nonHunters) {
        const v = this.nightRun.get(p.id) ?? 0;
        if (v < qv) {
          qv = v;
          qi = p.id;
        }
      }
      if (qi && qv < 3) lines.push({ title: "Quietest Feet", name: nameOf(qi), detail: "barely made a sound" });
    }
    return lines.slice(0, 4);
  }

  /** Hunter-/auto-placed loot: required items + golden brick (NOT flashlights). */
  private buildLoot(): Array<{ id: string; kind: string; x: number; z: number }> {
    const m = DEFAULT_MAP;
    const list: Array<{ id: string; kind: string; x: number; z: number }> = [];
    for (const l of m.requiredLoot) list.push({ id: l.id, kind: l.id, x: l.x, z: l.z });
    list.push({ id: "golden_brick", kind: "golden_brick", x: m.goldenBrick.x, z: m.goldenBrick.z });
    return list;
  }

  /** Solo loot: pick a random candidate room per item each game (falling back to
   *  the fixed anchor if a room is missing), so spots vary between solo rounds. */
  private buildSoloLoot(): Array<{ id: string; kind: string; x: number; z: number }> {
    const m = DEFAULT_MAP;
    const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
    const spotFor = (kind: string, fallback: { x: number; z: number }) => {
      const rooms = SOLO_LOOT_ROOMS[kind];
      const s = rooms && rooms.length ? roomSpot(pick(rooms), 0.6) : null;
      return s ?? fallback;
    };
    const list: Array<{ id: string; kind: string; x: number; z: number }> = [];
    for (const l of m.requiredLoot) {
      const s = spotFor(l.id, { x: l.x, z: l.z });
      list.push({ id: l.id, kind: l.id, x: s.x, z: s.z });
    }
    const gb = spotFor("golden_brick", { x: m.goldenBrick.x, z: m.goldenBrick.z });
    list.push({ id: "golden_brick", kind: "golden_brick", x: gb.x, z: gb.z });
    return list;
  }

  /** One flashlight per searcher, clustered at the lobby spawn points (in view). */
  private placeFlashlights(count: number) {
    const spawns = DEFAULT_MAP.searcherSpawns;
    for (let i = 0; i < Math.max(1, count); i++) {
      const s = spawns[i % spawns.length];
      const ring = Math.floor(i / spawns.length); // extra rows if >spawns players
      const x = s.x + (ring ? (i % 2 ? 1.3 : -1.3) : 0);
      const z = s.z + ring * 1.3;
      this.addItem(`flashlight_${i}`, "flashlight", x, z);
    }
  }

  private addItem(id: string, kind: string, x: number, z: number) {
    const it = new Item();
    it.id = id;
    it.kind = kind;
    it.x = x;
    it.y = 0;
    it.z = z;
    this.state.items.set(id, it);
  }

  /** Tell the Hunter what to place next and how many remain. */
  private sendPlacement(client: Client) {
    client.send("placement", { kind: this.pending[0]?.kind ?? "", remaining: this.pending.length });
  }

  /** Drop any items the Hunter didn't place at their default anchors. */
  private autoPlaceRemaining() {
    for (const l of this.pending) this.addItem(l.id, l.kind, l.x, l.z);
    this.pending = [];
  }

  private returnToLobby() {
    this.state.phase = Phase.LOBBY;
    this.state.timeLeft = 0;
    this.state.outcome = "";
    this.state.dare = "";
    this.state.deposited = 0;
    this.state.doorsOpen = false;
    this.roles.clear();
    this.state.players.forEach((p) => {
      p.role = Role.UNASSIGNED;
      p.downed = false;
      p.escaped = false;
    });
    this.state.items.clear();
    this.pending = [];
    this.clearSabotage();
    this.ai.deactivate(this.state);
    this.syncMetadata();
    console.log(`[BlackoutRoom] returned to lobby`);
  }

  // ---- Movement ----

  private handleMove(client: Client, msg: MoveMsg) {
    if (!msg) return; // a payload-less "move" must not throw in the room
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    if (player.downed || player.escaped) return; // out of the round
    if (!isFiniteNum(msg.x) || !isFiniteNum(msg.y) || !isFiniteNum(msg.z) || !isFiniteNum(msg.ry)) {
      return;
    }

    // Phase freeze: the Hunter is frozen during LIGHTS ON while searchers scout.
    // (Searchers roam during HIDE too — disoriented, items/Hunter unseen.)
    const role = this.roles.get(client.sessionId);
    const ph = this.state.phase;
    if (role === Role.HUNTER && ph === Phase.LIGHTS_ON) return;

    const now = Date.now();
    const last = this.lastMoveAt.get(client.sessionId) ?? now;
    const dt = Math.max(0.001, (now - last) / 1000);
    this.lastMoveAt.set(client.sessionId, now);

    player.light = !!msg.light;

    // Night Report tally clock (searchers only; capped so gaps don't spike it).
    const tallyDt =
      role !== Role.HUNTER
        ? Math.min(0.25, (now - (this.nightMoveAt.get(client.sessionId) ?? now)) / 1000)
        : 0;
    if (role !== Role.HUNTER) this.nightMoveAt.set(client.sessionId, now);

    // Hiding in a locker: hold position, just record facing + hidden flag.
    player.hidden = !!msg.hidden;
    if (player.hidden) {
      player.ry = msg.ry;
      this.running.set(client.sessionId, { running: false, at: now });
      this.nightHidden.set(client.sessionId, (this.nightHidden.get(client.sessionId) ?? 0) + tallyDt);
      return;
    }

    // Clamp the requested target inside the world.
    const tx = clamp(msg.x, -HALF_W, HALF_W);
    const tz = clamp(msg.z, -HALF_D, HALF_D);

    // Running = loud: flag it for the Caretaker's hearing.
    const reqSpeed = Math.hypot(tx - player.x, tz - player.z) / dt;
    const isRunning = reqSpeed > CONFIG.SEARCHER_WALK + 1;
    this.running.set(client.sessionId, { running: isRunning, at: now });
    if (isRunning && role !== Role.HUNTER && this.state.phase === Phase.BLACKOUT) {
      this.nightRun.set(client.sessionId, (this.nightRun.get(client.sessionId) ?? 0) + tallyDt);
    }

    // Anti-cheat: limit horizontal displacement to the max legal speed.
    const maxStep = MAX_SPEED * dt * SPEED_TOLERANCE + 0.05;
    const dx = tx - player.x;
    const dz = tz - player.z;
    const dist = Math.hypot(dx, dz);
    if (dist > maxStep) {
      const s = maxStep / dist;
      player.x += dx * s;
      player.z += dz * s;
    } else {
      player.x = tx;
      player.z = tz;
    }

    player.y = clamp(msg.y, 0, MAX_Y);
    player.ry = msg.ry;
    // Wall-climb is a Hunter ability — searchers can't spoof the pose flag.
    player.climbing = role === Role.HUNTER && !!msg.climb;

    // Only searchers interact with items / the pad / the exit — and objective
    // progress only counts during the hunt. LIGHTS_ON is for scouting; HIDE is
    // for wandering lost. Without this gate a team could deposit (or even
    // escape) before the Caretaker is ever released.
    const hunting = ph === Phase.BLACKOUT || ph === Phase.ESCAPE;
    if (role !== Role.HUNTER && hunting) {
      this.tryDeposit(player);
      // The slam temporarily bars the exit; the slammer can never escape (trapped).
      const escapeOpen = this.state.slamFor <= 0 && player.id !== this.slamTrappedId;
      if (escapeOpen && this.state.doorsOpen && !player.escaped && inZone(player.x, player.z, EXIT)) {
        player.escaped = true;
        if (this.blackoutAt > 0) {
          this.escapeTimes.set(player.id, Math.round((Date.now() - this.blackoutAt) / 100) / 10);
        }
        console.log(`[BlackoutRoom] ${player.name} escaped!`);
        // Real-time moment (§9): escapee gets "You made it", others a "[Name] escaped" toast.
        this.broadcast("escaped", { id: player.id, name: player.name });
        this.maybeStingNo({ x: player.x, z: player.z }); // the Caretaker's frustrated "no"
        this.checkRoundEnd();
      }
    }
  }

  /** Sabotage: Hunter (door + lights) or Traitor (door only). Scare was replaced
   *  by the Caretaker taunt wheel. */
  private handleSabotage(client: Client, kind?: string) {
    const role = this.roles.get(client.sessionId);
    const isHunter = role === Role.HUNTER;
    const isTraitor = role === Role.TRAITOR;
    if (!isHunter && !isTraitor) return;
    if (isTraitor && kind === "lights") return; // traitor: door only
    const ph = this.state.phase;
    if (ph !== Phase.BLACKOUT && ph !== Phase.ESCAPE) return;
    const h = this.state.players.get(client.sessionId);
    if (!h) return;
    const cd = kind === "door" ? CONFIG.HUNTER_DOOR_LOCK_CD_S : kind === "lights" ? CONFIG.HUNTER_BLACKOUT_CD_S : 0;
    if (!cd) return;
    const now = Date.now();
    const cdKey = `${client.sessionId}:${kind}`;
    if (now - (this.lastSab.get(cdKey) ?? -1e9) < cd * 1000) return;

    if (kind === "door") {
      if (!this.lockDoorFacing(h.x, h.z, h.ry)) {
        client.send("sab", { kind, fail: "Face a door to slam it" });
        return; // don't start the cooldown
      }
    } else if (kind === "lights") {
      this.state.lightsOutFor = KILL_LIGHTS_S;
    }
    this.lastSab.set(cdKey, now);
    client.send("sab", { kind }); // confirm → starts the client cooldown
    if (isTraitor) this.traitorWhisper(h); // any traitor power → quiet positional tell
  }

  /** Lock the lockable door best aligned with (x,z,ry): facing dominates,
   *  distance breaks ties. Returns false if none is reachable + in front.
   *  Shared by the human Hunter's slam and the AI Caretaker. */
  private lockDoorFacing(x: number, z: number, ry: number, maxDist = 11, maxAng = 1.2): boolean {
    let best: DoorGap | undefined;
    let bestScore = Infinity;
    for (const d of DEFAULT_MAP.doors) {
      if (this.state.lockedDoors.includes(d.id)) continue;
      if (!this.canLock(d)) continue; // never seal a room off completely
      const px = d.axis === "v" ? d.line : d.center;
      const pz = d.axis === "v" ? d.center : d.line;
      const dist = Math.hypot(px - x, pz - z);
      if (dist > maxDist) continue;
      const toAng = Math.atan2(-(px - x), -(pz - z));
      const ang = Math.abs(angleDiff(ry, toAng));
      if (ang > maxAng) continue; // roughly in front
      const score = ang + dist * 0.06;
      if (score < bestScore) {
        bestScore = score;
        best = d;
      }
    }
    if (!best) return false;
    this.state.lockedDoors.push(best.id);
    this.doorExpiry.set(best.id, Date.now() + DOOR_LOCK_S * 1000);
    const dpx = best.axis === "v" ? best.line : best.center;
    const dpz = best.axis === "v" ? best.center : best.line;
    this.broadcast("sound", { soundId: "door_slam", x: dpx, z: dpz });
    return true;
  }

  /** The AI Caretaker works its sabotage tools during a hunt: kills the lights
   *  when it has a target cornered/fleeing, and slams a door it's bearing down
   *  on to cut off a runner. Own cooldowns; called from the sim loop. */
  private aiSabotage(now: number) {
    const c = this.state.caretaker;
    const chasing = c.aiState === "chase" || c.aiState === "attack";
    // Lights-off: strongest while actively chasing (blinds the fleeing searcher).
    if (chasing && this.state.lightsOutFor <= 0 &&
        now - this.aiLastLights > CONFIG.HUNTER_BLACKOUT_CD_S * 1000) {
      this.aiLastLights = now;
      this.state.lightsOutFor = KILL_LIGHTS_S;
    }
    // Door-slam: cut off a runner by slamming a door he's bearing toward. A
    // wider facing cone than the human's — the AI "commits" to the doorway.
    if (chasing && now - this.aiLastDoor > CONFIG.HUNTER_DOOR_LOCK_CD_S * 1000) {
      if (this.lockDoorFacing(c.x, c.z, c.ry, 9, 1.6)) this.aiLastDoor = now;
    }
  }

  /**
   * Universal traitor tell: whenever the traitor uses ANY power, the server emits
   * a quiet positional "whisper" at their location (small radius — see the BANK
   * tuning client-side), reusing the same sound-event pipeline as the Caretaker
   * taunts. Future power slices (Drain / Mark / Slam) call this too.
   */
  private traitorWhisper(p: Player) {
    this.broadcast("sound", { soundId: "whisper", x: p.x, z: p.z });
  }

  /**
   * Traitor "Drain the Light": zero a nearby searcher's flashlight battery,
   * blinding them. Server validates role + phase + range + cooldown, tells the
   * victim to kill their light, emits the flicker/sound cue + the whisper.
   */
  private handleDrain(client: Client) {
    if (this.roles.get(client.sessionId) !== Role.TRAITOR) return;
    const ph = this.state.phase;
    if (ph !== Phase.BLACKOUT && ph !== Phase.ESCAPE) return;
    const t = this.state.players.get(client.sessionId);
    if (!t) return;
    const now = Date.now();
    if (now - (this.lastDrain.get(client.sessionId) ?? -1e9) < CONFIG.TRAITOR_DRAIN_CD_S * 1000) return;

    // Who's carrying a flashlight (a battery to drain)?
    const carriers = new Set<string>();
    this.state.items.forEach((it) => {
      if (it.kind === "flashlight" && it.carriedBy) carriers.add(it.carriedBy);
    });

    // Nearest eligible searcher within close range.
    let victim: Player | undefined;
    let bestD: number = CONFIG.TRAITOR_DRAIN_RANGE;
    this.state.players.forEach((p) => {
      if (this.roles.get(p.id) !== Role.SEARCHER) return; // not the traitor/hunter
      if (p.downed || p.escaped || p.hidden || !carriers.has(p.id)) return;
      const d = Math.hypot(p.x - t.x, p.z - t.z);
      if (d <= bestD) {
        bestD = d;
        victim = p;
      }
    });

    if (!victim) {
      client.send("sab", { kind: "drain", fail: "No lit searcher in reach" });
      return; // no valid target → no cooldown
    }

    this.lastDrain.set(client.sessionId, now);
    // Kill the victim's flashlight (client zeroes its battery for the blind window).
    this.clients
      .find((c) => c.sessionId === victim!.id)
      ?.send("drained", { ms: CONFIG.TRAITOR_DRAIN_BLIND_S * 1000 });
    // Flicker + dying-light sound at the victim, heard/seen by nearby clients.
    this.broadcast("sound", { soundId: "drain", x: victim.x, z: victim.z });
    this.traitorWhisper(t); // universal tell
    client.send("sab", { kind: "drain" }); // confirm → starts the traitor's client cooldown
  }

  /**
   * Traitor "Mark": flag a nearby searcher so the Caretaker sees them outlined
   * for a few seconds. Server validates role + phase + range + cooldown, tells
   * ONLY the Hunter to outline them, notifies the victim, and whispers.
   */
  private handleMark(client: Client) {
    if (this.roles.get(client.sessionId) !== Role.TRAITOR) return;
    const ph = this.state.phase;
    if (ph !== Phase.BLACKOUT && ph !== Phase.ESCAPE) return;
    const t = this.state.players.get(client.sessionId);
    if (!t) return;
    const now = Date.now();
    if (now - (this.lastMark.get(client.sessionId) ?? -1e9) < CONFIG.TRAITOR_MARK_CD_S * 1000) return;

    // Nearest eligible searcher within proximity.
    let victim: Player | undefined;
    let bestD: number = CONFIG.TRAITOR_MARK_RANGE;
    this.state.players.forEach((p) => {
      if (this.roles.get(p.id) !== Role.SEARCHER) return;
      if (p.downed || p.escaped || p.hidden) return;
      const d = Math.hypot(p.x - t.x, p.z - t.z);
      if (d <= bestD) {
        bestD = d;
        victim = p;
      }
    });

    if (!victim) {
      client.send("sab", { kind: "mark", fail: "No searcher to mark nearby" });
      return; // no valid target → no cooldown
    }

    this.lastMark.set(client.sessionId, now);
    const ms = CONFIG.TRAITOR_MARK_S * 1000;
    // ONLY the Hunter is told (so the outline is Caretaker-only — no state leak).
    this.clients
      .find((c) => this.roles.get(c.sessionId) === Role.HUNTER)
      ?.send("markTarget", { id: victim.id, ms });
    // The victim gets the urgent notification.
    this.clients.find((c) => c.sessionId === victim!.id)?.send("marked", {});
    this.traitorWhisper(t); // universal tell
    client.send("sab", { kind: "mark" }); // confirm → starts the traitor's client cooldown
  }

  /**
   * Accusation / public hearing (spec §5). One per player per match. Runs an
   * ANONYMOUS hearing (no accuser/target shown), a dramatic beat, then resolves:
   *   correct → traitor exposed + dies, Caretaker shown on the minimap 45s;
   *   wrong   → the accuser becomes visible to the Caretaker for the rest of the match.
   * Fully server-authoritative.
   */
  private handleAccuse(client: Client, targetId?: string) {
    if (!this.state.traitorMode) return; // no traitor → no hearings
    const role = this.roles.get(client.sessionId);
    if (role !== Role.SEARCHER && role !== Role.TRAITOR) return; // hunter can't accuse
    const ph = this.state.phase;
    if (ph !== Phase.BLACKOUT && ph !== Phase.ESCAPE) return;
    if (this.hearingActive) return; // one hearing at a time
    if (this.hasAccused.has(client.sessionId)) return; // one accusation per player
    const accuser = this.state.players.get(client.sessionId);
    if (!accuser || accuser.downed || accuser.escaped) return;
    if (!targetId || targetId === client.sessionId) return;
    const target = this.state.players.get(targetId);
    const tRole = this.roles.get(targetId);
    if (!target || (tRole !== Role.SEARCHER && tRole !== Role.TRAITOR)) return; // must accuse a non-hunter
    if (target.downed || target.escaped) return;

    this.hasAccused.add(client.sessionId);
    this.hearingActive = true;

    // Opener names the accuser (not the target).
    this.broadcast("hearing", { text: `${accuser.name} accused someone of being the traitor.` });

    // …a held breath, then the verdict.
    this.clock.setTimeout(() => {
      this.resolveAccusation(client.sessionId, targetId);
      this.hearingActive = false;
    }, Math.round(CONFIG.ACCUSE_BEAT_S * 1000));
  }

  private resolveAccusation(accuserId: string, targetId: string) {
    const accuser = this.state.players.get(accuserId);
    if (!accuser) return;
    const accuserName = accuser.name;
    const correct = this.roles.get(targetId) === Role.TRAITOR;
    // Private ack → the accuser's profile stats (name-matching the broadcast is fragile).
    this.clients.find((c) => c.sessionId === accuserId)?.send("accuseResult", { correct });

    if (correct) {
      const traitor = this.state.players.get(targetId);
      const traitorName = traitor?.name ?? "someone";
      // The traitor's KEY DROPS at their location (route 2 opens): a searcher
      // grabs it → doors unlock → the dash. Spawn before downing so we have a pos.
      if (traitor && this.keyHolderId === targetId) {
        this.addItem("door_key", "door_key", traitor.x, traitor.z);
        this.keyHolderId = "";
      }
      if (traitor) traitor.downed = true; // exposed and dies; round continues
      // Caretaker is revealed on the searchers' minimap for the dash window.
      this.state.caretakerRevealFor = CONFIG.ACCUSE_MINIMAP_REVEAL_S;
      this.broadcast("hearing", { text: `${accuserName} guessed right — the traitor was ${traitorName}.` });
      this.checkRoundEnd();
    } else {
      // Wrong: the false accuser becomes visible to the Caretaker (Hunter sees them).
      this.clients
        .find((c) => this.roles.get(c.sessionId) === Role.HUNTER)
        ?.send("markTarget", { id: accuserId, ms: CONFIG.ACCUSE_FALSE_PENALTY_S * 1000 });
      this.broadcast("hearing", { text: `${accuserName} guessed wrong — the traitor is still among us.` });
    }
  }

  /**
   * Slam the Door (§3/§4) — the traitor's endgame finisher. Only once the doors
   * are unlocked (escape phase). Bars the EXIT for TRAITOR_SLAM_S, reveals the
   * traitor, and TRAPS them (they forfeit their own escape). At window end the
   * server tallies who was caught: shutout → outright traitor win; some → counts
   * toward the Caretaker's night (round end); none → exposed, trapped, loses.
   * One-shot per match.
   */
  private handleSlam(client: Client) {
    if (this.roles.get(client.sessionId) !== Role.TRAITOR) return;
    const ph = this.state.phase;
    if (ph !== Phase.BLACKOUT && ph !== Phase.ESCAPE) return;
    if (!this.state.doorsOpen) return; // only after the doors unlock
    if (this.slamUsed) return; // one-shot finisher
    const t = this.state.players.get(client.sessionId);
    if (!t) return;

    this.slamUsed = true;
    this.slamTrappedId = client.sessionId; // committed — the slammer can't escape now
    // Record who's still inside (alive, not escaped) for the shutout tally.
    this.slamInsideIds = [];
    this.state.players.forEach((p) => {
      if (this.roles.get(p.id) !== Role.SEARCHER) return; // count the real searchers
      if (p.downed || p.escaped) return;
      this.slamInsideIds.push(p.id);
    });
    this.state.slamFor = CONFIG.TRAITOR_SLAM_S; // bar the exit (escape suppressed in handleMove)

    this.broadcast("hearing", { text: `${t.name} slammed the door — the traitor reveals themselves!` });
    this.broadcast("sound", { soundId: "door_slam", x: EXIT.x, z: EXIT.z });

    this.clock.setTimeout(() => this.resolveSlam(), CONFIG.TRAITOR_SLAM_S * 1000);
  }

  private resolveSlam() {
    this.state.slamFor = 0; // the exit reopens
    const inside = this.slamInsideIds;
    this.slamInsideIds = [];
    if (inside.length === 0) return;
    const caught = inside.filter((id) => this.state.players.get(id)?.downed).length;
    if (caught >= inside.length) {
      // Shutout — everyone trapped inside was caught: outright (flawless) traitor win.
      this.broadcast("hearing", { text: "A flawless finish — no one escaped the slam." });
      this.endRound("hunter");
    } else if (caught > 0) {
      this.broadcast("hearing", { text: `The slam caught ${caught} — the rest slipped out.` });
      // counts toward the Caretaker's night; the round resolves normally at its end.
    } else {
      this.broadcast("hearing", { text: "The slam caught no one — the traitor is exposed and trapped." });
    }
  }

  /** A door can be locked only if it won't leave an adjacent room with no way out. */
  private canLock(d: DoorGap): boolean {
    for (const r of d.rooms) {
      const openOthers = (this.roomDoors.get(r) ?? []).filter(
        (id) => id !== d.id && !this.state.lockedDoors.includes(id),
      );
      if (openOthers.length < 1) return false;
    }
    return true;
  }

  private tickSabotage() {
    if (this.state.lightsOutFor > 0) this.state.lightsOutFor--;
    if (this.state.caretakerRevealFor > 0) this.state.caretakerRevealFor--;
    if (this.state.slamFor > 0) this.state.slamFor--;
    const now = Date.now();
    for (const [id, exp] of [...this.doorExpiry]) {
      if (now >= exp) {
        this.doorExpiry.delete(id);
        const i = this.state.lockedDoors.indexOf(id);
        if (i >= 0) this.state.lockedDoors.splice(i, 1);
      }
    }
  }

  private clearSabotage() {
    this.doorExpiry.clear();
    this.lastSab.clear();
    this.lastDrain.clear();
    this.lastMark.clear();
    this.state.lightsOutFor = 0;
    this.state.caretakerRevealFor = 0;
    this.hasAccused.clear();
    this.hearingActive = false;
    this.keyHolderId = "";
    this.slamUsed = false;
    this.slamTrappedId = "";
    this.slamInsideIds = [];
    this.state.slamFor = 0;
    if (this.state.lockedDoors.length) this.state.lockedDoors.splice(0, this.state.lockedDoors.length);
  }

  /** Human Hunter melee: down the nearest searcher in front, within range. */
  /** Where the Caretaker currently "is" for positional sounds: the AI in solo,
   *  else the human Hunter's position. Null if neither is available. */
  private caretakerPos(): { x: number; z: number } | null {
    if (this.solo && this.state.caretaker.active) {
      return { x: this.state.caretaker.x, z: this.state.caretaker.z };
    }
    const hunter = this.clients.find((c) => this.roles.get(c.sessionId) === Role.HUNTER);
    const h = hunter && this.state.players.get(hunter.sessionId);
    return h ? { x: h.x, z: h.z } : null;
  }

  /** A canned Caretaker sting, broadcast positionally to every client. NOT routed
   *  through the WebRTC voice mesh — it's a clip, not live mic. */
  private emitSting(soundId: string, pos: { x: number; z: number } | null) {
    if (!pos) return;
    this.broadcast("sound", { soundId, x: pos.x, z: pos.z });
  }

  /** sting_no on survivor progress (escape / deposit), throttled against spam. */
  private maybeStingNo(pos: { x: number; z: number }) {
    const now = Date.now();
    if (now - this.lastSting < STING_THROTTLE_MS) return;
    this.lastSting = now;
    this.emitSting("sting_no", pos);
  }

  /** Hunter-only Caretaker taunt: validate role/phase/index, enforce the per-
   *  player cooldown, then broadcast a positional sound at the Hunter. */
  private handleTaunt(client: Client, index?: number) {
    if (this.roles.get(client.sessionId) !== Role.HUNTER) return;
    const ph = this.state.phase;
    if (ph !== Phase.BLACKOUT && ph !== Phase.ESCAPE) return; // only during the hunt
    const i = Math.floor(Number(index));
    if (!(i >= 0 && i < TAUNT_SOUNDS.length)) return;
    const h = this.state.players.get(client.sessionId);
    if (!h) return;
    const now = Date.now();
    if (now - (this.lastTaunt.get(client.sessionId) ?? 0) < TAUNT_COOLDOWN_MS) return;
    this.lastTaunt.set(client.sessionId, now);
    this.broadcast("sound", { soundId: TAUNT_SOUNDS[i], x: h.x, z: h.z });
  }

  private handleMelee(client: Client) {
    if (this.roles.get(client.sessionId) !== Role.HUNTER) return;
    const ph = this.state.phase;
    if (ph !== Phase.BLACKOUT && ph !== Phase.ESCAPE) return;
    const h = this.state.players.get(client.sessionId);
    if (!h) return;
    const now = Date.now();
    if (now - (this.lastMelee.get(client.sessionId) ?? 0) < 700) return;
    this.lastMelee.set(client.sessionId, now);

    let best: Player | undefined;
    let bestD = CONFIG.MELEE_RANGE + 0.7;
    this.state.players.forEach((p) => {
      if (this.roles.get(p.id) !== Role.SEARCHER) return;
      if (p.downed || p.escaped || p.hidden || !p.connected) return;
      if (Math.abs(p.y - h.y) > CONFIG.MELEE_MAX_DY) return; // no hits through the booth floor
      const dx = p.x - h.x;
      const dz = p.z - h.z;
      const d = Math.hypot(dx, dz);
      if (d > bestD) return;
      const toAng = Math.atan2(-dx, -dz);
      if (Math.abs(angleDiff(h.ry, toAng)) > Math.PI * 0.6) return; // ~front cone
      bestD = d;
      best = p;
    });
    if (best) this.onCatch(best.id);
  }

  // Optional axe throw: long-range but wildly inaccurate — even with a searcher
  // lined up it's a coin flip. A SCARCE gamble: AXE_POOL throws per match total,
  // on a recharge between throws. Host-toggled via state.axeThrows.
  private handleAxe(client: Client) {
    if (!this.state.axeThrows) return;
    if (this.roles.get(client.sessionId) !== Role.HUNTER) return;
    const ph = this.state.phase;
    if (ph !== Phase.BLACKOUT && ph !== Phase.ESCAPE) return;
    if (this.axesLeft <= 0) return; // out of axes for the night
    const h = this.state.players.get(client.sessionId);
    if (!h) return;
    const now = Date.now();
    if (now - (this.lastAxe.get(client.sessionId) ?? 0) < CONFIG.AXE_COOLDOWN_S * 1000) return;
    this.lastAxe.set(client.sessionId, now);
    this.axesLeft--;

    // Acquire the nearest searcher in the throw arc.
    let best: Player | undefined;
    let bestD: number = CONFIG.AXE_RANGE;
    this.state.players.forEach((p) => {
      if (this.roles.get(p.id) !== Role.SEARCHER) return;
      if (p.downed || p.escaped || p.hidden || !p.connected) return;
      if (Math.abs(p.y - h.y) > CONFIG.MELEE_MAX_DY) return; // no throws through the booth floor
      const dx = p.x - h.x;
      const dz = p.z - h.z;
      const d = Math.hypot(dx, dz);
      if (d > bestD) return;
      const toAng = Math.atan2(-dx, -dz);
      if (Math.abs(angleDiff(h.ry, toAng)) > Math.PI * 0.5) return; // ~front arc
      bestD = d;
      best = p;
    });

    const hit = !!best && Math.random() < CONFIG.AXE_HIT_CHANCE; // 50/50
    if (hit && best) this.onCatch(best.id); // checkRoundEnd runs on the next tick
    client.send("axe", { hit, hadTarget: !!best, left: this.axesLeft });
    // MP-consistent world sound: the whoosh/thud at the thrower's position.
    this.broadcast("sound", { soundId: "axe", x: h.x, z: h.z });
  }

  private tryDeposit(player: Player) {
    if (!inZone(player.x, player.z, PAD)) return;
    let changed = false;
    this.state.items.forEach((it) => {
      if (it.carriedBy === player.id && REQUIRED_ITEM_KINDS.includes(it.kind as ItemKind)) {
        it.carriedBy = "";
        it.deposited = true;
        it.x = PAD.x + (Math.random() - 0.5) * 1.4;
        it.z = PAD.z + (Math.random() - 0.5) * 1.0;
        changed = true;
      }
    });
    if (!changed) return;

    let d = 0;
    this.state.items.forEach((it) => {
      if (it.deposited && REQUIRED_ITEM_KINDS.includes(it.kind as ItemKind)) d++;
    });
    this.state.deposited = d;
    this.maybeStingNo({ x: PAD.x, z: PAD.z }); // progress against the Caretaker → "no"
    if (d >= this.state.requiredItems && !this.state.doorsOpen) {
      this.state.doorsOpen = true;
      console.log(`[BlackoutRoom] all items deposited — front doors unlocked`);
      // MP-consistent world sound: the front doors unlocking, heard by everyone.
      this.broadcast("sound", { soundId: "door_unlock", x: EXIT.x, z: EXIT.z });
    }
  }

  /** End the round once every searcher has escaped or been caught. */
  private checkRoundEnd() {
    const live = this.state.phase;
    if (live !== Phase.BLACKOUT && live !== Phase.ESCAPE && live !== Phase.LIGHTS_ON) return;
    let total = 0;
    let done = 0;
    let escaped = 0;
    this.state.players.forEach((p) => {
      if (this.roles.get(p.id) !== Role.SEARCHER) return;
      total++;
      if (p.escaped) {
        done++;
        escaped++;
      } else if (p.downed) {
        done++;
      }
    });
    // The Caretaker's side wins the night if FEWER THAN HALF the searchers escape
    // (§3). Individual escapees still "won by escaping" regardless (results screen).
    if (total > 0 && done === total) this.endRound(escaped * 2 >= total ? "searchers" : "hunter");
  }

  /** Contain handler exceptions: a malformed message must never take down the
   *  room (or the process hosting every other match). */
  onUncaughtException(err: Error, methodName: string) {
    console.error(`[BlackoutRoom] uncaught exception in ${methodName}:`, err);
  }

  onDispose() {
    console.log(`[BlackoutRoom] disposed (${this.roomId})`);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function angleDiff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
