import test from 'node:test';
import assert from 'node:assert/strict';
import {
  naturalPolyline,
  planEdgeRoute,
  polylineMidpoint,
  polylineToPath,
  segmentClear,
  simplify,
  type RouteBox,
  type RoutePoint,
  type RouteRequest
} from '../src/edges/route';

// The example workflow's nodes, as the browser measured them.
const EXAMPLE: RouteBox[] = [
  { id: 'input', x: 375, y: 30, width: 150, height: 97 },
  { id: 'draft', x: 345, y: 180, width: 256, height: 132 },
  { id: 'quality', x: 375, y: 375, width: 192, height: 124 },
  { id: 'revision', x: 570, y: 540, width: 256, height: 132 },
  { id: 'merge', x: 375, y: 705, width: 192, height: 84 },
  { id: 'gate', x: 375, y: 855, width: 192, height: 124 },
  { id: 'output', x: 390, y: 1005, width: 150, height: 64 }
];

const box = (id: string, x: number, y: number, width: number, height: number): RouteBox => ({ id, x, y, width, height });

/** Ids of every box whose interior some segment of the polyline crosses. */
function crossed(points: RoutePoint[], boxes: RouteBox[]): string[] {
  const hits = new Set<string>();
  for (let i = 1; i < points.length; i++) {
    for (const b of boxes) {
      if (!segmentClear(points[i - 1], points[i], [b])) hits.add(b.id);
    }
  }
  return [...hits];
}

const request = (over: Partial<RouteRequest>): RouteRequest => ({
  sourceId: 'a',
  source: { x: 0, y: 0 },
  sourceSide: 'bottom',
  targetId: 'b',
  target: { x: 0, y: 100 },
  targetSide: 'top',
  boxes: [],
  ...over
});

test('segmentClear blocks interiors and allows running along an edge', () => {
  const b = [box('b', 100, 100, 50, 50)];
  assert.equal(segmentClear({ x: 125, y: 0 }, { x: 125, y: 200 }, b), false, 'through the middle');
  assert.equal(segmentClear({ x: 100, y: 0 }, { x: 100, y: 200 }, b), true, 'along the left edge');
  assert.equal(segmentClear({ x: 0, y: 150 }, { x: 200, y: 150 }, b), true, 'along the bottom edge');
  assert.equal(segmentClear({ x: 0, y: 125 }, { x: 110, y: 125 }, b), false, 'entering from the side');
  assert.equal(segmentClear({ x: 0, y: 125 }, { x: 100, y: 125 }, b), true, 'stopping at the edge');
});

test('an edge with a clear run keeps the step path', () => {
  const plan = planEdgeRoute(
    request({
      sourceId: 'input',
      source: { x: 450, y: 130.36 },
      targetId: 'draft',
      target: { x: 473, y: 176 },
      boxes: EXAMPLE
    })
  );
  assert.deepEqual(plan, { kind: 'smoothstep' });
});

test('the step path is judged against the nodes between, not the two it connects', () => {
  // Quality Check's true handle straight down into Merge: the path ends inside
  // Merge's clearance by definition and must still count as clear.
  const plan = planEdgeRoute(
    request({
      sourceId: 'quality',
      source: { x: 432.59, y: 502.64 },
      targetId: 'merge',
      target: { x: 432.59, y: 701 },
      boxes: EXAMPLE
    })
  );
  assert.deepEqual(plan, { kind: 'smoothstep' });
});

test('handles facing away from each other never get the step path', () => {
  assert.equal(naturalPolyline(request({ source: { x: 0, y: 100 }, target: { x: 0, y: 0 } })), null);
});

test('a fail arrow sending work back is routed around every node in between', () => {
  const plan = planEdgeRoute(
    request({
      sourceId: 'gate',
      source: { x: 508.82, y: 981.18 },
      sourceSide: 'bottom',
      targetId: 'draft',
      target: { x: 473, y: 176 },
      targetSide: 'top',
      boxes: EXAMPLE
    })
  );
  assert.equal(plan.kind, 'routed');
  if (plan.kind !== 'routed') return;

  const { points } = plan;
  assert.deepEqual(crossed(points, EXAMPLE), [], 'no segment passes through any node');
  assert.deepEqual(points[0], { x: 508.82, y: 981.18 });
  assert.deepEqual(points[points.length - 1], { x: 473, y: 176 });
  assert.ok(points[1].x === points[0].x && points[1].y > points[0].y, 'leaves the fail handle downward');
  const last = points[points.length - 1];
  const beforeLast = points[points.length - 2];
  assert.ok(beforeLast.x === last.x && beforeLast.y < last.y, 'drops into the top handle from above');
  assert.ok(points.length <= 6, `at most four bends, got ${points.length - 2}`);
  assert.ok(Math.min(...points.map((p) => p.x)) < 345, 'goes around the outside of the column');
});

test('a forward edge whose straight path would cross a node is routed around it', () => {
  const boxes = [box('a', 0, 0, 100, 50), box('blocker', 0, 150, 100, 100), box('b', 0, 400, 100, 50)];
  const plan = planEdgeRoute(
    request({
      sourceId: 'a',
      source: { x: 50, y: 50 },
      targetId: 'b',
      target: { x: 50, y: 400 },
      boxes
    })
  );
  assert.equal(plan.kind, 'routed');
  if (plan.kind !== 'routed') return;
  assert.deepEqual(crossed(plan.points, boxes), []);
  assert.deepEqual(plan.points[0], { x: 50, y: 50 });
  assert.deepEqual(plan.points[plan.points.length - 1], { x: 50, y: 400 });
});

test('a route is preferred over a bendier one of the same length', () => {
  // Blocker sits left of centre: going around its right costs fewer pixels
  // and no more bends, so that side wins.
  const boxes = [box('a', 0, 0, 100, 50), box('blocker', -60, 150, 100, 100), box('b', 0, 400, 100, 50)];
  const plan = planEdgeRoute(
    request({ sourceId: 'a', source: { x: 50, y: 50 }, targetId: 'b', target: { x: 50, y: 400 }, boxes })
  );
  assert.equal(plan.kind, 'routed');
  if (plan.kind !== 'routed') return;
  assert.ok(Math.max(...plan.points.map((p) => p.x)) > 40, 'went around the right');
  assert.deepEqual(crossed(plan.points, boxes), []);
});

test('a target walled in on every side falls back to the step path', () => {
  const boxes = [
    box('a', 0, 0, 100, 50),
    box('top', -100, 300, 400, 20),
    box('left', -100, 300, 20, 220),
    box('right', 280, 300, 20, 220),
    box('bottom', -100, 500, 400, 20),
    box('b', 0, 400, 100, 50)
  ];
  const plan = planEdgeRoute(
    request({ sourceId: 'a', source: { x: 50, y: 50 }, targetId: 'b', target: { x: 50, y: 400 }, boxes })
  );
  assert.deepEqual(plan, { kind: 'smoothstep' });
});

test('simplify drops repeats and points on a straight run', () => {
  assert.deepEqual(
    simplify([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 50 },
      { x: 0, y: 100 },
      { x: 50, y: 100 },
      { x: 100, y: 100 }
    ]),
    [
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 100, y: 100 }
    ]
  );
});

test('polylineToPath starts at the first point, rounds each corner, ends at the last', () => {
  const d = polylineToPath([{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }], 5);
  assert.equal(d, 'M0,0 L0,95 Q0,100 5,100 L100,100');
});

test('polylineToPath shrinks the corner radius on a short segment', () => {
  const d = polylineToPath([{ x: 0, y: 0 }, { x: 0, y: 4 }, { x: 100, y: 4 }], 5);
  assert.equal(d, 'M0,0 L0,2 Q0,4 2,4 L100,4');
});

test('polylineMidpoint is halfway along the length, not the point list', () => {
  assert.deepEqual(polylineMidpoint([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]), { x: 100, y: 0 });
  assert.deepEqual(polylineMidpoint([{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 100 }]), { x: 200, y: 0 });
});
