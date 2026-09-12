/**
 * Orthogonal edge routing that goes around nodes instead of under them.
 *
 * React Flow's built-in edges know only their two endpoints, so an edge whose
 * target sits behind its source — a human gate's fail arrow sending work back
 * — is drawn straight through everything in between.
 *
 * The plan for an edge is either "the plain step path is fine, use it" or a
 * polyline that goes around. Routing searches a lane grid rather than pixels:
 * the only turns worth making are level with some node's cleared edge, so the
 * candidate coordinates are exactly those, plus the edge's own endpoints. That
 * keeps the search small (a few hundred points for a canvas of this size) and
 * the result made of long straight runs instead of staircases.
 */

export interface RouteBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RoutePoint {
  x: number;
  y: number;
}

export type RouteSide = 'top' | 'right' | 'bottom' | 'left';

export interface RouteRequest {
  sourceId: string;
  source: RoutePoint;
  sourceSide: RouteSide;
  targetId: string;
  target: RoutePoint;
  targetSide: RouteSide;
  /** Every node on the canvas, including the two this edge connects. */
  boxes: RouteBox[];
}

export type EdgePlan =
  /** Nothing is in the way; the caller should draw React Flow's step path. */
  | { kind: 'smoothstep' }
  | { kind: 'routed'; points: RoutePoint[] };

/** Clearance kept from a node the edge only passes by. */
const PADDING = 12;
/** Clearance from the two nodes the edge connects — it has to reach them. */
const ENDPOINT_PADDING = 6;
/** How far an edge leaves its handle before it may turn. */
const STUB = 20;
/** Bends cost this many pixels, so the search prefers the simpler of two routes. */
const BEND_COST = 24;
/** Give up and fall back rather than search a grid this large. */
const MAX_GRID = 6000;

const HORIZONTAL = 0;
const VERTICAL = 1;
type Axis = typeof HORIZONTAL | typeof VERTICAL;

function axisOf(side: RouteSide): Axis {
  return side === 'top' || side === 'bottom' ? VERTICAL : HORIZONTAL;
}

function stepOf(side: RouteSide): RoutePoint {
  switch (side) {
    case 'top': return { x: 0, y: -1 };
    case 'bottom': return { x: 0, y: 1 };
    case 'left': return { x: -1, y: 0 };
    case 'right': return { x: 1, y: 0 };
  }
}

function inflate(box: RouteBox, padding: number): RouteBox {
  return {
    id: box.id,
    x: box.x - padding,
    y: box.y - padding,
    width: box.width + padding * 2,
    height: box.height + padding * 2
  };
}

function contains(box: RouteBox, p: RoutePoint): boolean {
  return p.x > box.x && p.x < box.x + box.width && p.y > box.y && p.y < box.y + box.height;
}

/**
 * Whether an axis-aligned segment stays out of every box. Only interiors
 * block: a segment running along a box's edge is exactly the clearance
 * distance from the node itself, which is where we want it.
 */
export function segmentClear(a: RoutePoint, b: RoutePoint, boxes: RouteBox[]): boolean {
  const vertical = a.x === b.x;
  const lo = vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x);
  const hi = vertical ? Math.max(a.y, b.y) : Math.max(a.x, b.x);

  for (const box of boxes) {
    const right = box.x + box.width;
    const bottom = box.y + box.height;
    if (vertical) {
      if (a.x <= box.x || a.x >= right) continue;
      if (hi <= box.y || lo >= bottom) continue;
    } else {
      if (a.y <= box.y || a.y >= bottom) continue;
      if (hi <= box.x || lo >= right) continue;
    }
    return false;
  }
  return true;
}

/**
 * Where the edge may first turn: `STUB` away from the handle, or short of
 * that when something is already in the way. The handle's own node never
 * counts as in the way.
 */
function stubPoint(p: RoutePoint, side: RouteSide, boxes: RouteBox[], ownId: string): RoutePoint {
  const step = stepOf(side);
  let reach = STUB;

  for (const box of boxes) {
    if (box.id === ownId) continue;
    const right = box.x + box.width;
    const bottom = box.y + box.height;
    if (step.y !== 0) {
      if (p.x <= box.x || p.x >= right) continue;
      const edge = step.y > 0 ? box.y : bottom;
      const gap = (edge - p.y) * step.y;
      if (gap >= 0) reach = Math.min(reach, gap);
    } else {
      if (p.y <= box.y || p.y >= bottom) continue;
      const edge = step.x > 0 ? box.x : right;
      const gap = (edge - p.x) * step.x;
      if (gap >= 0) reach = Math.min(reach, gap);
    }
  }

  return { x: p.x + step.x * reach, y: p.y + step.y * reach };
}

/** True when `to` lies the way the handle at `from` faces. */
function isAhead(from: RoutePoint, side: RouteSide, to: RoutePoint): boolean {
  switch (side) {
    case 'top': return to.y < from.y;
    case 'bottom': return to.y > from.y;
    case 'left': return to.x < from.x;
    case 'right': return to.x > from.x;
  }
}

/**
 * The shape React Flow's step edge draws when it has room: out of both
 * handles, one turn across the gap. Null when the handles face away from
 * each other, which is where the built-in path doubles back through
 * whatever lies between.
 */
export function naturalPolyline(req: RouteRequest): RoutePoint[] | null {
  const { source, sourceSide, target, targetSide } = req;
  if (!isAhead(source, sourceSide, target) || !isAhead(target, targetSide, source)) return null;

  const sourceAxis = axisOf(sourceSide);
  const targetAxis = axisOf(targetSide);

  if (sourceAxis === VERTICAL && targetAxis === VERTICAL) {
    const mid = (source.y + target.y) / 2;
    return [source, { x: source.x, y: mid }, { x: target.x, y: mid }, target];
  }
  if (sourceAxis === HORIZONTAL && targetAxis === HORIZONTAL) {
    const mid = (source.x + target.x) / 2;
    return [source, { x: mid, y: source.y }, { x: mid, y: target.y }, target];
  }
  const corner = sourceAxis === VERTICAL
    ? { x: source.x, y: target.y }
    : { x: target.x, y: source.y };
  return [source, corner, target];
}

function polylineClear(points: RoutePoint[], boxes: RouteBox[]): boolean {
  for (let i = 1; i < points.length; i++) {
    if (!segmentClear(points[i - 1], points[i], boxes)) return false;
  }
  return true;
}

/** Drop repeated points and points that only continue a straight run. */
export function simplify(points: RoutePoint[]): RoutePoint[] {
  const out: RoutePoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    out.push(p);
  }
  for (let i = out.length - 2; i > 0; i--) {
    const before = out[i - 1];
    const after = out[i + 1];
    if ((before.x === out[i].x && out[i].x === after.x) || (before.y === out[i].y && out[i].y === after.y)) {
      out.splice(i, 1);
    }
  }
  return out;
}

/** The smallest binary heap that does the job — keyed by cost, values are state ids. */
class Heap {
  private costs: number[] = [];
  private items: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(cost: number, item: number): void {
    this.costs.push(cost);
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.costs[parent] <= this.costs[i]) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  pop(): number {
    const top = this.items[0];
    const lastCost = this.costs.pop()!;
    const lastItem = this.items.pop()!;
    if (this.items.length) {
      this.costs[0] = lastCost;
      this.items[0] = lastItem;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let best = i;
        if (left < this.items.length && this.costs[left] < this.costs[best]) best = left;
        if (right < this.items.length && this.costs[right] < this.costs[best]) best = right;
        if (best === i) break;
        this.swap(best, i);
        i = best;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.costs[a], this.costs[b]] = [this.costs[b], this.costs[a]];
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
  }
}

function sortedUnique(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * Decide how to draw one edge. Prefers the plain step path so an edge with
 * a clear run keeps the shape it has always had; routes around only when
 * that path would cut through a node.
 */
export function planEdgeRoute(req: RouteRequest): EdgePlan {
  const { sourceId, source, sourceSide, targetId, target, targetSide, boxes } = req;
  const isEndpoint = (box: RouteBox) => box.id === sourceId || box.id === targetId;

  // The endpoints sit on their own nodes, so only the nodes in between can
  // make the plain path wrong.
  const between = boxes.filter((b) => !isEndpoint(b)).map((b) => inflate(b, PADDING));
  const natural = naturalPolyline(req);
  if (natural && polylineClear(natural, between)) return { kind: 'smoothstep' };

  const obstacles = boxes.map((b) => inflate(b, isEndpoint(b) ? ENDPOINT_PADDING : PADDING));
  const from = stubPoint(source, sourceSide, obstacles, sourceId);
  const to = stubPoint(target, targetSide, obstacles, targetId);

  // A handle hard up against another node leaves its stub inside that node's
  // clearance. Nothing can be routed around it, so let the route graze it
  // rather than give up on the whole edge.
  const blocking = obstacles.filter((b) => !contains(b, from) && !contains(b, to));

  const xs = sortedUnique([
    from.x, to.x, source.x, target.x,
    ...blocking.flatMap((b) => [b.x, b.x + b.width])
  ]);
  const ys = sortedUnique([
    from.y, to.y, source.y, target.y,
    ...blocking.flatMap((b) => [b.y, b.y + b.height])
  ]);
  if (xs.length * ys.length > MAX_GRID) return { kind: 'smoothstep' };

  const height = ys.length;
  const xIndex = new Map(xs.map((v, i) => [v, i]));
  const yIndex = new Map(ys.map((v, i) => [v, i]));
  const startCell = xIndex.get(from.x)! * height + yIndex.get(from.y)!;
  const goalCell = xIndex.get(to.x)! * height + yIndex.get(to.y)!;

  const cells = xs.length * height;
  const best = new Float64Array(cells * 2).fill(Infinity);
  const cameFrom = new Int32Array(cells * 2).fill(-1);
  const queue = new Heap();

  const startState = startCell * 2 + axisOf(sourceSide);
  best[startState] = 0;
  queue.push(0, startState);

  let goalState = -1;
  while (queue.size) {
    const state = queue.pop();
    const cost = best[state];
    const cell = state >> 1;
    const direction = state & 1;

    if (cell === goalCell) {
      goalState = state;
      break;
    }

    const cx = Math.floor(cell / height);
    const cy = cell % height;
    const here = { x: xs[cx], y: ys[cy] };

    for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]] as const) {
      if (nx < 0 || ny < 0 || nx >= xs.length || ny >= height) continue;
      const next = { x: xs[nx], y: ys[ny] };
      if (!segmentClear(here, next, blocking)) continue;

      const moveDirection: Axis = nx === cx ? VERTICAL : HORIZONTAL;
      const length = Math.abs(next.x - here.x) + Math.abs(next.y - here.y);
      const nextCell = nx * height + ny;
      // Arriving facing the way the target handle points saves the last turn.
      const arrival = nextCell === goalCell && moveDirection !== axisOf(targetSide) ? BEND_COST : 0;
      const candidate = cost + length + (moveDirection === direction ? 0 : BEND_COST) + arrival;

      const nextState = nextCell * 2 + moveDirection;
      if (candidate >= best[nextState]) continue;
      best[nextState] = candidate;
      cameFrom[nextState] = state;
      queue.push(candidate, nextState);
    }
  }

  if (goalState < 0) return { kind: 'smoothstep' };

  const path: RoutePoint[] = [];
  for (let state = goalState; state >= 0; state = cameFrom[state]) {
    const cell = state >> 1;
    path.push({ x: xs[Math.floor(cell / height)], y: ys[cell % height] });
  }
  path.reverse();

  return { kind: 'routed', points: simplify([source, ...path, target]) };
}

/** An SVG path with rounded corners, matching the step edge's own look. */
export function polylineToPath(points: RoutePoint[], radius = 5): string {
  if (points.length < 2) return '';
  let d = `M${points[0].x},${points[0].y}`;

  for (let i = 1; i < points.length - 1; i++) {
    const previous = points[i - 1];
    const corner = points[i];
    const next = points[i + 1];
    const inLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y);
    const r = Math.min(radius, inLength / 2, outLength / 2);
    if (r <= 0) {
      d += ` L${corner.x},${corner.y}`;
      continue;
    }
    const before = {
      x: corner.x + ((previous.x - corner.x) / inLength) * r,
      y: corner.y + ((previous.y - corner.y) / inLength) * r
    };
    const after = {
      x: corner.x + ((next.x - corner.x) / outLength) * r,
      y: corner.y + ((next.y - corner.y) / outLength) * r
    };
    d += ` L${before.x},${before.y} Q${corner.x},${corner.y} ${after.x},${after.y}`;
  }

  const last = points[points.length - 1];
  return `${d} L${last.x},${last.y}`;
}

/** Halfway along the polyline, for the edge label. */
export function polylineMidpoint(points: RoutePoint[]): RoutePoint {
  if (!points.length) return { x: 0, y: 0 };
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const length = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    if (walked + length >= total / 2) {
      const t = length === 0 ? 0 : (total / 2 - walked) / length;
      return {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * t
      };
    }
    walked += length;
  }
  return points[points.length - 1];
}
