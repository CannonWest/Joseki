import { memo, useMemo } from 'react';
import { BaseEdge, Position, getSmoothStepPath, useNodes, type EdgeProps } from 'reactflow';
import { planEdgeRoute, polylineMidpoint, polylineToPath, type RouteBox, type RouteSide } from './route';

const SIDE: Record<Position, RouteSide> = {
  [Position.Top]: 'top',
  [Position.Right]: 'right',
  [Position.Bottom]: 'bottom',
  [Position.Left]: 'left'
};

/**
 * A step edge that goes around nodes. Where React Flow's own step path has a
 * clear run it is used unchanged; where it would cut through a node — a
 * gate's fail arrow going back up the canvas — the edge is routed around.
 */
function RoutedEdgeComponent({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  markerStart,
  label,
  labelStyle,
  labelShowBg,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
  interactionWidth
}: EdgeProps) {
  const nodes = useNodes();

  // Every store change hands every edge a new nodes array. The route is
  // only redone when a node's box actually moved or resized.
  const layout = nodes
    .map((n) => {
      const p = n.positionAbsolute ?? n.position;
      return `${n.id}:${p.x},${p.y},${n.width},${n.height}`;
    })
    .join(';');

  const plan = useMemo(() => {
    const boxes: RouteBox[] = [];
    for (const n of nodes) {
      if (!n.width || !n.height) continue;
      const p = n.positionAbsolute ?? n.position;
      boxes.push({ id: n.id, x: p.x, y: p.y, width: n.width, height: n.height });
    }
    return planEdgeRoute({
      sourceId: source,
      source: { x: sourceX, y: sourceY },
      sourceSide: SIDE[sourcePosition],
      targetId: target,
      target: { x: targetX, y: targetY },
      targetSide: SIDE[targetPosition],
      boxes
    });
    // `layout` stands in for `nodes`: same information, stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition]);

  let path: string;
  let labelX: number;
  let labelY: number;
  if (plan.kind === 'routed') {
    path = polylineToPath(plan.points);
    ({ x: labelX, y: labelY } = polylineMidpoint(plan.points));
  } else {
    [path, labelX, labelY] = getSmoothStepPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition
    });
  }

  return (
    <BaseEdge
      id={id}
      path={path}
      style={style}
      markerEnd={markerEnd}
      markerStart={markerStart}
      interactionWidth={interactionWidth}
      labelX={labelX}
      labelY={labelY}
      label={label}
      labelStyle={labelStyle}
      labelShowBg={labelShowBg}
      labelBgStyle={labelBgStyle}
      labelBgPadding={labelBgPadding}
      labelBgBorderRadius={labelBgBorderRadius}
    />
  );
}

export const RoutedEdge = memo(RoutedEdgeComponent);
