import type { MapOutlineData, MapPoint } from "./mapTypes";

const BRUSH_CLOSE_DISTANCE = 14;
const BRUSH_MIN_AREA = 64;

interface Polyline {
  sourceId: string;
  points: MapPoint[];
}

interface SegmentCut {
  t: number;
  point: MapPoint;
}

interface Segment {
  sourceId: string;
  index: number;
  start: MapPoint;
  end: MapPoint;
  cuts: SegmentCut[];
}

interface GraphEdge {
  id: number;
  from: number;
  to: number;
  sourceId: string;
}

interface GraphLink {
  to: number;
  edgeId: number;
}

interface BrushGraph {
  nodes: MapPoint[];
  edges: GraphEdge[];
  adjacency: Map<number, GraphLink[]>;
}

interface CycleResult {
  points: MapPoint[];
  draftIds: string[];
  area: number;
}

export interface BrushFinishResult {
  outline: MapOutlineData | null;
  draftOutlines: MapOutlineData[];
}

export function pointDistance(a: MapPoint, b: MapPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function polygonArea(points: MapPoint[]): number {
  if (points.length < 3) return 0;
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

function clonePoint(point: MapPoint): MapPoint {
  return { x: point.x, y: point.y };
}

function pointsAlmostEqual(a: MapPoint, b: MapPoint, epsilon = 0.5): boolean {
  return pointDistance(a, b) <= epsilon;
}

function pointKey(point: MapPoint, precision = 1): string {
  return `${point.x.toFixed(precision)},${point.y.toFixed(precision)}`;
}

function removeBrushTailLoops(points: MapPoint[]): MapPoint[] {
  if (points.length < 3) return [];
  const stack: MapPoint[] = [];
  const indexByKey = new Map<string, number>();

  for (const point of points) {
    const copy = clonePoint(point);
    const key = pointKey(copy);
    const repeatedIndex = indexByKey.get(key);
    if (repeatedIndex !== undefined) {
      const simpleLoop = [...stack.slice(repeatedIndex), copy].slice(0, -1);
      if (simpleLoop.length >= 3 && Math.abs(polygonArea(simpleLoop)) >= BRUSH_MIN_AREA) {
        stack.length = 0;
        indexByKey.clear();
        for (const loopPoint of simpleLoop) {
          indexByKey.set(pointKey(loopPoint), stack.length);
          stack.push(clonePoint(loopPoint));
        }
        continue;
      }
      while (stack.length > repeatedIndex + 1) {
        const removed = stack.pop();
        if (removed) indexByKey.delete(pointKey(removed));
      }
      continue;
    }
    indexByKey.set(key, stack.length);
    stack.push(copy);
  }

  return stack;
}

function normalizePolygon(points: MapPoint[]): MapPoint[] {
  if (points.length < 3) return [];
  const cleaned: MapPoint[] = [];
  for (const point of points) {
    if (!cleaned.length || !pointsAlmostEqual(cleaned[cleaned.length - 1], point)) cleaned.push(clonePoint(point));
  }
  if (cleaned.length > 1 && pointsAlmostEqual(cleaned[0], cleaned[cleaned.length - 1])) cleaned.pop();
  const simple = removeBrushTailLoops(cleaned);
  return Math.abs(polygonArea(simple)) >= BRUSH_MIN_AREA ? simple : [];
}

function pathIntersection(a1: MapPoint, a2: MapPoint, b1: MapPoint, b2: MapPoint): { point: MapPoint; t: number; u: number } | null {
  const rx = a2.x - a1.x;
  const ry = a2.y - a1.y;
  const sx = b2.x - b1.x;
  const sy = b2.y - b1.y;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 0.0001) return null;
  const qx = b1.x - a1.x;
  const qy = b1.y - a1.y;
  const t = (qx * sy - qy * sx) / denominator;
  const u = (qx * ry - qy * rx) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { point: { x: a1.x + t * rx, y: a1.y + t * ry }, t, u };
}

function projectPointToSegment(point: MapPoint, start: MapPoint, end: MapPoint): { point: MapPoint; t: number; distance: number } {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 0.0001) return { point: clonePoint(start), t: 0, distance: pointDistance(point, start) };
  const raw = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
  const t = Math.max(0, Math.min(1, raw));
  const projected = { x: start.x + dx * t, y: start.y + dy * t };
  return { point: projected, t, distance: pointDistance(point, projected) };
}

function findSelfClosedPolygon(points: MapPoint[]): MapPoint[] | null {
  if (points.length < 4) return null;
  if (pointDistance(points[0], points[points.length - 1]) <= BRUSH_CLOSE_DISTANCE) {
    const closed = normalizePolygon(points.slice(0, -1));
    if (closed.length >= 3) return closed;
  }
  for (let currentIndex = 1; currentIndex < points.length - 1; currentIndex += 1) {
    for (let previousIndex = 0; previousIndex < currentIndex - 1; previousIndex += 1) {
      const hit = pathIntersection(points[previousIndex], points[previousIndex + 1], points[currentIndex], points[currentIndex + 1]);
      if (!hit) continue;
      const loop = [hit.point, ...points.slice(previousIndex + 1, currentIndex + 1), hit.point];
      const closed = normalizePolygon(loop);
      if (closed.length >= 3) return closed;
    }
  }
  return null;
}

function createBrushGraph(polylines: Polyline[]): BrushGraph {
  const segments: Segment[] = [];
  for (const polyline of polylines) {
    for (let index = 0; index < polyline.points.length - 1; index += 1) {
      const start = polyline.points[index];
      const end = polyline.points[index + 1];
      if (pointDistance(start, end) < 2) continue;
      segments.push({ sourceId: polyline.sourceId, index, start, end, cuts: [{ t: 0, point: start }, { t: 1, point: end }] });
    }
  }

  for (let firstIndex = 0; firstIndex < segments.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < segments.length; secondIndex += 1) {
      const first = segments[firstIndex];
      const second = segments[secondIndex];
      if (first.sourceId === second.sourceId && Math.abs(first.index - second.index) <= 1) continue;
      const hit = pathIntersection(first.start, first.end, second.start, second.end);
      if (!hit) continue;
      first.cuts.push({ t: hit.t, point: hit.point });
      second.cuts.push({ t: hit.u, point: hit.point });
    }
  }

  const endpoints = polylines.flatMap((polyline) => polyline.points.length < 2 ? [] : [
    { sourceId: polyline.sourceId, point: polyline.points[0] },
    { sourceId: polyline.sourceId, point: polyline.points[polyline.points.length - 1] },
  ]);
  for (const endpoint of endpoints) {
    for (const segment of segments) {
      if (segment.sourceId === endpoint.sourceId) continue;
      const projection = projectPointToSegment(endpoint.point, segment.start, segment.end);
      if (projection.t <= 0.001 || projection.t >= 0.999 || projection.distance > BRUSH_CLOSE_DISTANCE) continue;
      segment.cuts.push({ t: projection.t, point: projection.point });
    }
  }

  const nodes: MapPoint[] = [];
  const nodeLookup = new Map<string, number>();
  const edges: GraphEdge[] = [];
  const adjacency = new Map<number, GraphLink[]>();
  const getNodeId = (point: MapPoint): number => {
    const key = pointKey(point, 2);
    const existing = nodeLookup.get(key);
    if (existing !== undefined) return existing;
    const id = nodes.length;
    nodeLookup.set(key, id);
    nodes.push(clonePoint(point));
    adjacency.set(id, []);
    return id;
  };
  const addEdge = (from: number, to: number, sourceId: string): void => {
    if (from === to || pointDistance(nodes[from], nodes[to]) < 2) return;
    const existing = adjacency.get(from)?.some((link) => link.to === to && edges[link.edgeId]?.sourceId === sourceId);
    if (existing) return;
    const edge = { id: edges.length, from, to, sourceId };
    edges.push(edge);
    adjacency.get(from)?.push({ to, edgeId: edge.id });
    adjacency.get(to)?.push({ to: from, edgeId: edge.id });
  };

  for (const segment of segments) {
    const cuts = segment.cuts.sort((a, b) => a.t - b.t).filter((cut, index, items) => {
      const previous = items[index - 1];
      return !previous || Math.abs(previous.t - cut.t) > 0.001 || !pointsAlmostEqual(previous.point, cut.point);
    });
    for (let index = 0; index < cuts.length - 1; index += 1) addEdge(getNodeId(cuts[index].point), getNodeId(cuts[index + 1].point), segment.sourceId);
  }

  const endpointNodes = endpoints.map((endpoint) => ({ ...endpoint, nodeId: getNodeId(endpoint.point) }));
  for (let firstIndex = 0; firstIndex < endpointNodes.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < endpointNodes.length; secondIndex += 1) {
      const first = endpointNodes[firstIndex];
      const second = endpointNodes[secondIndex];
      if (first.sourceId === second.sourceId || pointDistance(first.point, second.point) > BRUSH_CLOSE_DISTANCE) continue;
      addEdge(first.nodeId, second.nodeId, "__snap__");
    }
  }
  for (const endpoint of endpointNodes) {
    for (const segment of segments) {
      if (segment.sourceId === endpoint.sourceId) continue;
      const projection = projectPointToSegment(endpoint.point, segment.start, segment.end);
      if (projection.t <= 0.001 || projection.t >= 0.999 || projection.distance > BRUSH_CLOSE_DISTANCE) continue;
      addEdge(endpoint.nodeId, getNodeId(projection.point), "__snap__");
    }
  }

  return { nodes, edges, adjacency };
}

function findNodePath(graph: BrushGraph, start: number, end: number, skippedEdgeId: number): { nodes: number[]; edgeIds: number[] } | null {
  const queue = [start];
  const visited = new Set([start]);
  const previous = new Map<number, { node: number; edgeId: number }>();
  while (queue.length) {
    const node = queue.shift();
    if (node === undefined || node === end) break;
    for (const link of graph.adjacency.get(node) || []) {
      if (link.edgeId === skippedEdgeId || visited.has(link.to)) continue;
      visited.add(link.to);
      previous.set(link.to, { node, edgeId: link.edgeId });
      queue.push(link.to);
    }
  }
  if (!visited.has(end)) return null;
  const nodes = [end];
  const edgeIds: number[] = [];
  let cursor = end;
  while (cursor !== start) {
    const step = previous.get(cursor);
    if (!step) return null;
    edgeIds.unshift(step.edgeId);
    cursor = step.node;
    nodes.unshift(cursor);
  }
  return { nodes, edgeIds };
}

function findGraphCycle(currentPoints: MapPoint[], drafts: MapOutlineData[]): CycleResult | null {
  const currentSourceId = "__current__";
  const graph = createBrushGraph([
    ...drafts.map((draft) => ({ sourceId: draft.id, points: draft.points })),
    { sourceId: currentSourceId, points: currentPoints },
  ]);
  let best: CycleResult | null = null;
  for (const edge of graph.edges) {
    if (edge.sourceId !== currentSourceId) continue;
    const path = findNodePath(graph, edge.to, edge.from, edge.id);
    if (!path || path.nodes.length < 3) continue;
    const edgeIds = [edge.id, ...path.edgeIds];
    const points = normalizePolygon([edge.from, edge.to, ...path.nodes.slice(1)].map((nodeId) => graph.nodes[nodeId]));
    if (points.length < 3) continue;
    const sourceIds = new Set(edgeIds.map((edgeId) => graph.edges[edgeId]?.sourceId).filter(Boolean));
    if (!sourceIds.has(currentSourceId)) continue;
    const area = Math.abs(polygonArea(points));
    const candidate = {
      points,
      draftIds: [...sourceIds].filter((sourceId) => sourceId !== currentSourceId && sourceId !== "__snap__"),
      area,
    };
    if (!best || candidate.area < best.area) best = candidate;
  }
  return best;
}

function makeClosedOutline(drawing: MapOutlineData, points: MapPoint[]): MapOutlineData {
  return { ...drawing, shape: "polygon", closed: true, thickness: 0, points };
}

export function finishBrushDrawing(drawing: MapOutlineData, drafts: MapOutlineData[]): BrushFinishResult {
  if (drawing.points.length < 2) return { outline: null, draftOutlines: drafts };
  const points = drawing.points.map(clonePoint);
  const compatibleDrafts = drafts.filter((draft) => draft.layer === drawing.layer && draft.collisionType === drawing.collisionType && draft.element === drawing.element);
  const graphCycle = findGraphCycle(points, compatibleDrafts);
  if (graphCycle) {
    return {
      outline: makeClosedOutline(drawing, graphCycle.points),
      draftOutlines: drafts.filter((draft) => !graphCycle.draftIds.includes(draft.id)),
    };
  }
  const selfClosed = findSelfClosedPolygon(points);
  if (selfClosed) return { outline: makeClosedOutline(drawing, selfClosed), draftOutlines: drafts };
  return {
    outline: null,
    draftOutlines: [...drafts, { ...drawing, shape: "polygon", closed: false, points }],
  };
}

export function createGroundLinePoints(start: MapPoint, end: MapPoint, thickness: number, horizontalSnapTolerance = 0): MapPoint[] {
  const resolvedEnd = horizontalSnapTolerance > 0 && Math.abs(end.y - start.y) <= horizontalSnapTolerance
    ? { x: end.x, y: start.y }
    : clonePoint(end);
  const body = Math.max(1, Math.min(256, Math.round(thickness)));
  return [
    clonePoint(start),
    resolvedEnd,
    { x: resolvedEnd.x, y: resolvedEnd.y + body },
    { x: start.x, y: start.y + body },
  ];
}
