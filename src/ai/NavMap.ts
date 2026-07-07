import { CONFIG } from "../shared/config";
import { DEFAULT_MAP } from "../shared/map";

/**
 * Server-side navigation + line-of-sight, built from the shared map data. This is
 * the "load the map server-side" prerequisite for authoritative AI (and later
 * combat). No Three.js — plain math over axis-aligned boxes.
 *
 * Pathfinding is grid-based A* (robust through the data-driven doorways), with
 * string-pulling to smooth the path. losClear() does segment-vs-AABB for
 * perception. nodeList() exposes room-centre points used as patrol destinations.
 */

export interface AABB {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}
export interface Pt {
  x: number;
  z: number;
}

const W = (x: number) => x - 36;
const Wz = (z: number) => z - 26;
// Room-centre / junction points used as patrol destinations.
const NODES: Pt[] = [
  { x: W(14), z: Wz(4) }, // green
  { x: W(34), z: Wz(4) }, // masks
  { x: W(35), z: Wz(16) }, // stage
  { x: W(35), z: Wz(28) }, // theatre
  { x: W(11), z: Wz(23) }, // dressing
  { x: W(11), z: Wz(39) }, // kitchen
  { x: W(55), z: Wz(18) }, // workshop
  { x: W(55), z: Wz(29) }, // maintenance
  { x: W(68), z: Wz(12) }, // easthall N
  { x: W(68), z: Wz(46) }, // easthall S
  { x: W(20), z: Wz(43) }, // admin
  { x: W(55), z: Wz(43) }, // gym
  { x: W(35), z: Wz(49) }, // lobby
  { x: W(10), z: Wz(10) }, // back west
  { x: W(56), z: Wz(10) }, // back east
  { x: W(19), z: Wz(47.5) }, // mens — no more AI-blind restroom pocket
  { x: W(19), z: Wz(50.5) }, // womens
  { x: W(21), z: Wz(37) }, // small hall (kitchen link)
  { x: W(32), z: Wz(43) }, // entry corridor
];

const CELL = 0.75;

export class NavMap {
  readonly aabbs: AABB[];
  private readonly wallBoxes: AABB[]; // walls only (for the climb-adjacency check)
  // Doorway openings as rectangles (climb suppression zones): `line` is the wall
  // plane, `center`/`width` the gap along it. axis "v" = wall at x=line.
  private readonly doorRects: Array<{ axis: "v" | "h"; line: number; center: number; width: number }>;
  private readonly hx: number;
  private readonly hz: number;
  private readonly nx: number;
  private readonly nz: number;
  private readonly walk: Uint8Array; // 1 = walkable

  constructor() {
    const toAabb = (b: { x: number; z: number; w: number; d: number }): AABB => ({
      minX: b.x - b.w / 2,
      maxX: b.x + b.w / 2,
      minZ: b.z - b.d / 2,
      maxZ: b.z + b.d / 2,
    });
    this.aabbs = [...DEFAULT_MAP.walls, ...DEFAULT_MAP.cover, ...DEFAULT_MAP.stagePlatform, DEFAULT_MAP.barredDoor]
      .filter((b) => b.y - b.h / 2 < 1)
      .map(toAabb);
    this.wallBoxes = DEFAULT_MAP.walls.filter((b) => b.h >= 3).map(toAabb);
    // Doorway openings: the wall-crawl is suppressed while crossing one.
    // nearWall() matches the jamb walls flanking every doorway, so without this
    // he'd mount a jamb mid-passage and the pose would flip wall-to-wall (the
    // spin). Rectangles, NOT radial bubbles: patrol routes run corridors that
    // pass doors ~1.3m to the side constantly — a radius that covers the
    // opening would suppress climbing across nearly the whole map.
    this.doorRects = DEFAULT_MAP.doors.map((d) => ({
      axis: d.axis,
      line: d.line,
      center: d.center,
      width: d.width,
    }));
    // The back-exit gap is carved without a DoorGap entry — cover it too
    // (a thin box across a horizontal wall: line = z, gap runs along x).
    this.doorRects.push({
      axis: "h",
      line: DEFAULT_MAP.barredDoor.z,
      center: DEFAULT_MAP.barredDoor.x,
      width: DEFAULT_MAP.barredDoor.w,
    });

    this.hx = DEFAULT_MAP.bounds.w / 2;
    this.hz = DEFAULT_MAP.bounds.d / 2;
    this.nx = Math.ceil(DEFAULT_MAP.bounds.w / CELL);
    this.nz = Math.ceil(DEFAULT_MAP.bounds.d / CELL);
    this.walk = new Uint8Array(this.nx * this.nz);
    const m = CONFIG.CARETAKER_RADIUS;
    for (let i = 0; i < this.nx; i++) {
      for (let j = 0; j < this.nz; j++) {
        const x = this.cx(i);
        const z = this.cz(j);
        const inside = Math.abs(x) < this.hx - 0.2 && Math.abs(z) < this.hz - 0.2;
        this.walk[j * this.nx + i] = inside && !this.blocked(x, z, m) ? 1 : 0;
      }
    }
  }

  nodeList(): Pt[] {
    return NODES;
  }

  private cx(i: number) {
    return -this.hx + (i + 0.5) * CELL;
  }
  private cz(j: number) {
    return -this.hz + (j + 0.5) * CELL;
  }
  private ci(x: number) {
    return Math.min(this.nx - 1, Math.max(0, Math.round((x + this.hx) / CELL - 0.5)));
  }
  private cj(z: number) {
    return Math.min(this.nz - 1, Math.max(0, Math.round((z + this.hz) / CELL - 0.5)));
  }
  private walkable(i: number, j: number) {
    return i >= 0 && j >= 0 && i < this.nx && j < this.nz && this.walk[j * this.nx + i] === 1;
  }

  /** Clear line of sight between two points (no wall between them)? */
  losClear(ax: number, az: number, bx: number, bz: number): boolean {
    for (const box of this.aabbs) if (segIntersectsAABB(ax, az, bx, bz, box)) return false;
    return true;
  }

  /** LOS with the obstacles inflated by `margin` — a corridor the Caretaker's
   *  BODY can actually follow, not just a zero-width sight-line. Using plain
   *  losClear for path smoothing let waypoints hug door jambs the 0.5 radius
   *  couldn't squeeze past (he'd grind on the frame). */
  losClearM(ax: number, az: number, bx: number, bz: number, margin: number): boolean {
    for (const box of this.aabbs) {
      const fat = {
        minX: box.minX - margin,
        maxX: box.maxX + margin,
        minZ: box.minZ - margin,
        maxZ: box.maxZ + margin,
      };
      if (segIntersectsAABB(ax, az, bx, bz, fat)) return false;
    }
    return true;
  }

  /** Is this point in a doorway crossing zone? (wall-crawl suppressed there.)
   *  Tight on the through-axis (±1.0 of the wall plane) so it only trips when
   *  he's actually at the opening — walking a corridor PAST a door in its side
   *  wall (~1.3m off the plane) keeps the crawl. Padded ±1.6 along the gap so
   *  crawling ALONG the wall toward the frame dismounts him well before the
   *  jamb corner (turning the corner into the door mid-crawl spun the pose). */
  nearDoor(x: number, z: number): boolean {
    for (const d of this.doorRects) {
      const perp = d.axis === "v" ? Math.abs(x - d.line) : Math.abs(z - d.line);
      const along = d.axis === "v" ? Math.abs(z - d.center) : Math.abs(x - d.center);
      if (perp < 1.0 && along < d.width / 2 + 1.6) return true;
    }
    return false;
  }

  /** Is a climbable WALL within `dist` of this point? (visual wall-crawl gate) */
  nearWall(x: number, z: number, dist: number): boolean {
    for (const b of this.wallBoxes) {
      const dx = Math.max(b.minX - x, 0, x - b.maxX);
      const dz = Math.max(b.minZ - z, 0, z - b.maxZ);
      if (dx * dx + dz * dz <= dist * dist) return true;
    }
    return false;
  }

  /** Is this point inside (or within margin of) a solid? */
  blocked(x: number, z: number, margin = 0): boolean {
    for (const b of this.aabbs) {
      if (x > b.minX - margin && x < b.maxX + margin && z > b.minZ - margin && z < b.maxZ + margin)
        return true;
    }
    return false;
  }

  private nearestWalkable(i: number, j: number): [number, number] {
    if (this.walkable(i, j)) return [i, j];
    for (let r = 1; r < 20; r++) {
      for (let di = -r; di <= r; di++) {
        for (let dj = -r; dj <= r; dj++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          if (this.walkable(i + di, j + dj)) return [i + di, j + dj];
        }
      }
    }
    return [i, j];
  }

  /** Waypoints from `from` to `to`: direct if walkable, else smoothed grid A*. */
  path(from: Pt, to: Pt): Pt[] {
    // Body corridor for path smoothing. MUST exceed the body radius: at 0.9×
    // a smoothed segment could legally pass 0.45 from a door jamb that the
    // 0.5-radius body can't squeeze past — he'd grind on the frame (the
    // "stuck in doorways" bug). 1.15× keeps real clearance with slack.
    const m = CONFIG.CARETAKER_RADIUS * 1.15;
    if (this.losClearM(from.x, from.z, to.x, to.z, m)) return [to];

    const [si, sj] = this.nearestWalkable(this.ci(from.x), this.cj(from.z));
    const [gi, gj] = this.nearestWalkable(this.ci(to.x), this.cj(to.z));
    const start = sj * this.nx + si;
    const goal = gj * this.nx + gi;
    if (start === goal) return [to];

    const n = this.nx * this.nz;
    const g = new Float32Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    g[start] = 0;
    const heap = new MinHeap();
    heap.push(start, this.h(si, sj, gi, gj));
    const dirs = [
      [1, 0, 1],
      [-1, 0, 1],
      [0, 1, 1],
      [0, -1, 1],
      [1, 1, 1.414],
      [1, -1, 1.414],
      [-1, 1, 1.414],
      [-1, -1, 1.414],
    ];

    let found = false;
    while (heap.size) {
      const cur = heap.pop();
      if (cur === goal) {
        found = true;
        break;
      }
      const ci = cur % this.nx;
      const cj = Math.floor(cur / this.nx);
      for (const [di, dj, cost] of dirs) {
        const ni = ci + di;
        const nj = cj + dj;
        if (!this.walkable(ni, nj)) continue;
        // No diagonal corner-cutting.
        if (di !== 0 && dj !== 0 && (!this.walkable(ci + di, cj) || !this.walkable(ci, cj + dj)))
          continue;
        const nIdx = nj * this.nx + ni;
        const t = g[cur] + cost;
        if (t < g[nIdx]) {
          g[nIdx] = t;
          came[nIdx] = cur;
          heap.push(nIdx, t + this.h(ni, nj, gi, gj));
        }
      }
    }
    if (!found) return [to];

    // Reconstruct cell centres.
    const cells: Pt[] = [];
    let c = goal;
    while (c !== -1) {
      cells.unshift({ x: this.cx(c % this.nx), z: this.cz(Math.floor(c / this.nx)) });
      c = came[c];
    }
    cells.push(to);

    // String-pull with the BODY corridor: keep a waypoint wherever the fat
    // segment would clip an (inflated) obstacle — no more door-jamb hugging.
    const out: Pt[] = [];
    let anchor = from;
    for (let k = 1; k < cells.length; k++) {
      if (!this.losClearM(anchor.x, anchor.z, cells[k].x, cells[k].z, m)) {
        out.push(cells[k - 1]);
        anchor = cells[k - 1];
      }
    }
    out.push(to);
    return out;
  }

  private h(ai: number, aj: number, bi: number, bj: number) {
    return Math.hypot(ai - bi, aj - bj);
  }
}

class MinHeap {
  private idx: number[] = [];
  private pri: number[] = [];
  get size() {
    return this.idx.length;
  }
  push(i: number, p: number) {
    this.idx.push(i);
    this.pri.push(p);
    let c = this.idx.length - 1;
    while (c > 0) {
      const parent = (c - 1) >> 1;
      if (this.pri[parent] <= this.pri[c]) break;
      this.swap(c, parent);
      c = parent;
    }
  }
  pop(): number {
    const top = this.idx[0];
    const last = this.idx.length - 1;
    this.swap(0, last);
    this.idx.pop();
    this.pri.pop();
    let c = 0;
    const n = this.idx.length;
    while (true) {
      const l = 2 * c + 1;
      const r = 2 * c + 2;
      let s = c;
      if (l < n && this.pri[l] < this.pri[s]) s = l;
      if (r < n && this.pri[r] < this.pri[s]) s = r;
      if (s === c) break;
      this.swap(c, s);
      c = s;
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.idx[a], this.idx[b]] = [this.idx[b], this.idx[a]];
    [this.pri[a], this.pri[b]] = [this.pri[b], this.pri[a]];
  }
}

/** Segment (a→b) vs axis-aligned box, in the XZ plane (slab method). */
function segIntersectsAABB(ax: number, az: number, bx: number, bz: number, box: AABB): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  let tmin = 0;
  let tmax = 1;
  if (Math.abs(dx) < 1e-9) {
    if (ax < box.minX || ax > box.maxX) return false;
  } else {
    let t1 = (box.minX - ax) / dx;
    let t2 = (box.maxX - ax) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  if (Math.abs(dz) < 1e-9) {
    if (az < box.minZ || az > box.maxZ) return false;
  } else {
    let t1 = (box.minZ - az) / dz;
    let t2 = (box.maxZ - az) / dz;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  return true;
}
