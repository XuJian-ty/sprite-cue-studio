using System;
using System.Collections.Generic;
using UnityEngine;

namespace FrameAction
{
    public sealed class FrameActionProceduralRigidFracturePiece2D
    {
        public readonly List<FrameActionProceduralRigidVisualFacet2D> Facets =
            new List<FrameActionProceduralRigidVisualFacet2D>(24);
        public Vector2[] Boundary = Array.Empty<Vector2>();
        public Vector2 Centroid;
        public float Area;
        public float MinimumWidth;
    }

    public sealed class FrameActionProceduralRigidFracturePlan2D
    {
        public readonly List<FrameActionProceduralRigidFracturePiece2D> Pieces =
            new List<FrameActionProceduralRigidFracturePiece2D>(8);
        public readonly List<FrameActionProceduralRigidCrackSegment2D> Cracks =
            new List<FrameActionProceduralRigidCrackSegment2D>(32);
        public float SourceArea;
    }

    /// <summary>
    /// Deterministically partitions the authored triangle graph. Multi-source graph growth means
    /// every shard remains connected; midpoint subdivision lets a large surviving shard be hit
    /// repeatedly without a fracture-depth stop. Authoring UVs are interpolated once and remain
    /// attached to the same material points through every generation.
    /// </summary>
    public static class FrameActionProceduralRigidFracturePlanner2D
    {
        private const float CoordinateQuantization = 100000f;
        private const float Epsilon = 0.000001f;
        private const int MaximumWorkingFacets = 768;

        private readonly struct PointKey : IEquatable<PointKey>
        {
            public readonly int X;
            public readonly int Y;

            public PointKey(Vector2 point)
            {
                X = Mathf.RoundToInt(point.x * CoordinateQuantization);
                Y = Mathf.RoundToInt(point.y * CoordinateQuantization);
            }

            public bool Equals(PointKey other) => X == other.X && Y == other.Y;
            public override bool Equals(object value) => value is PointKey other && Equals(other);
            public override int GetHashCode() => unchecked((X * 397) ^ Y);
        }

        private readonly struct EdgeKey : IEquatable<EdgeKey>
        {
            public readonly PointKey First;
            public readonly PointKey Second;

            public EdgeKey(Vector2 a, Vector2 b)
            {
                PointKey left = new PointKey(a);
                PointKey right = new PointKey(b);
                if (left.X < right.X || left.X == right.X && left.Y <= right.Y)
                {
                    First = left;
                    Second = right;
                }
                else
                {
                    First = right;
                    Second = left;
                }
            }

            public bool Equals(EdgeKey other) => First.Equals(other.First) && Second.Equals(other.Second);
            public override bool Equals(object value) => value is EdgeKey other && Equals(other);
            public override int GetHashCode() => unchecked((First.GetHashCode() * 397) ^ Second.GetHashCode());
        }

        private readonly struct EdgeRecord
        {
            public readonly int Facet;
            public readonly Vector2 Start;
            public readonly Vector2 End;

            public EdgeRecord(int facet, Vector2 start, Vector2 end)
            {
                Facet = facet;
                Start = start;
                End = end;
            }
        }

        private readonly struct Neighbor
        {
            public readonly int Facet;
            public readonly float SharedLength;

            public Neighbor(int facet, float sharedLength)
            {
                Facet = facet;
                SharedLength = sharedLength;
            }
        }

        private readonly struct QueueNode
        {
            public readonly int Facet;
            public readonly int Owner;
            public readonly float Cost;

            public QueueNode(int facet, int owner, float cost)
            {
                Facet = facet;
                Owner = owner;
                Cost = cost;
            }
        }

        private sealed class MinHeap
        {
            private QueueNode[] values;
            private int count;
            public int Count => count;

            public MinHeap(int capacity)
            {
                values = new QueueNode[Mathf.Max(16, capacity)];
            }

            public void Push(QueueNode value)
            {
                if (count == values.Length) Array.Resize(ref values, values.Length * 2);
                int index = count++;
                while (index > 0)
                {
                    int parent = (index - 1) >> 1;
                    if (values[parent].Cost <= value.Cost) break;
                    values[index] = values[parent];
                    index = parent;
                }
                values[index] = value;
            }

            public QueueNode Pop()
            {
                QueueNode result = values[0];
                QueueNode tail = values[--count];
                if (count == 0) return result;
                int index = 0;
                while (true)
                {
                    int left = index * 2 + 1;
                    if (left >= count) break;
                    int right = left + 1;
                    int child = right < count && values[right].Cost < values[left].Cost ? right : left;
                    if (values[child].Cost >= tail.Cost) break;
                    values[index] = values[child];
                    index = child;
                }
                values[index] = tail;
                return result;
            }
        }

        public static bool TryBuildPlan(
            FrameActionProceduralRigidGeometry2D geometry,
            Vector2 localHit,
            Vector2 inwardDirection,
            float relativeEnergy,
            uint impactSeed,
            out FrameActionProceduralRigidFracturePlan2D plan)
        {
            string template = geometry != null ? geometry.VisualSettings.templateId : "custom";
            return TryBuildPlan(geometry, FrameActionProceduralRigidPhysicalProfile2D.Defaults(template),
                localHit, inwardDirection, relativeEnergy, impactSeed, out plan);
        }

        public static bool TryBuildPlan(
            FrameActionProceduralRigidGeometry2D geometry,
            FrameActionProceduralRigidPhysicalProfile2D physical,
            Vector2 localHit,
            Vector2 inwardDirection,
            float relativeEnergy,
            uint impactSeed,
            out FrameActionProceduralRigidFracturePlan2D plan)
        {
            plan = null;
            if (geometry == null || !geometry.IsReady || geometry.FacetCount == 0) return false;

            var input = new List<FrameActionProceduralRigidVisualFacet2D>(geometry.FacetCount);
            for (int index = 0; index < geometry.FacetCount; index++) input.Add(geometry.GetFacet(index));
            return TryBuildPlan(
                input,
                geometry.SourcePixelsPerUnit,
                geometry.FractureSettings,
                physical,
                localHit,
                inwardDirection,
                relativeEnergy,
                impactSeed,
                out plan);
        }

        public static bool TryBuildPlan(
            IReadOnlyList<FrameActionProceduralRigidVisualFacet2D> sourceFacets,
            float sourcePixelsPerUnit,
            FrameActionProceduralRigidFractureSettings2D settings,
            Vector2 localHit,
            Vector2 inwardDirection,
            float relativeEnergy,
            uint impactSeed,
            out FrameActionProceduralRigidFracturePlan2D plan)
        {
            return TryBuildPlan(sourceFacets, sourcePixelsPerUnit, settings,
                FrameActionProceduralRigidPhysicalProfile2D.Defaults("custom"),
                localHit, inwardDirection, relativeEnergy, impactSeed, out plan);
        }

        public static bool TryBuildPlan(
            IReadOnlyList<FrameActionProceduralRigidVisualFacet2D> sourceFacets,
            float sourcePixelsPerUnit,
            FrameActionProceduralRigidFractureSettings2D settings,
            FrameActionProceduralRigidPhysicalProfile2D physical,
            Vector2 localHit,
            Vector2 inwardDirection,
            float relativeEnergy,
            uint impactSeed,
            out FrameActionProceduralRigidFracturePlan2D plan)
        {
            plan = null;
            if (sourceFacets == null || sourceFacets.Count == 0) return false;

            float ppu = Mathf.Max(1f, sourcePixelsPerUnit);
            float minimumArea = Mathf.Max(Epsilon,
                settings.minimumFragmentAreaPixelsSquared / (ppu * ppu));
            float minimumWidth = Mathf.Max(0f, settings.minimumFragmentWidthPixels / ppu);
            var facets = CopyAndRefine(sourceFacets, minimumArea);
            if (facets.Length < 3) return false;

            float totalArea = 0f;
            Vector2[] centers = new Vector2[facets.Length];
            Bounds2D bounds = new Bounds2D();
            for (int index = 0; index < facets.Length; index++)
            {
                FrameActionProceduralRigidVisualFacet2D facet = facets[index];
                facet.EnsureCounterClockwise();
                facets[index] = facet;
                centers[index] = facet.Centroid;
                totalArea += facet.Area;
                bounds.Include(facet.A);
                bounds.Include(facet.B);
                bounds.Include(facet.C);
            }
            if (totalArea <= Epsilon || totalArea < minimumArea * 1.9f) return false;

            List<Neighbor>[] neighbors = BuildAdjacency(facets, out Dictionary<EdgeKey, List<EdgeRecord>> edges);
            if (CountConnected(neighbors) != facets.Length) return false;

            int authoredMin = Mathf.Clamp(settings.primaryFragmentMin <= 0 ? 3 : settings.primaryFragmentMin, 3, 8);
            int authoredMax = Mathf.Clamp(settings.primaryFragmentMax <= 0 ? 8 : settings.primaryFragmentMax, authoredMin, 8);
            authoredMax = Mathf.Min(authoredMax,
                Mathf.Clamp(settings.maxFragmentsPerImpact <= 0 ? 8 : settings.maxFragmentsPerImpact, 2, 8));
            authoredMin = Mathf.Min(authoredMin, authoredMax);
            float energy01 = Mathf.SmoothStep(0f, 1f, Mathf.InverseLerp(0.70f, 2.60f, relativeEnergy));
            float countBias = Mathf.Clamp01(energy01 * Mathf.Lerp(0.45f, 1.15f, physical.brittleness));
            int desiredCount = Mathf.Clamp(Mathf.RoundToInt(Mathf.Lerp(authoredMin, authoredMax, countBias)), 2, 8);
            desiredCount = Mathf.Min(desiredCount, Mathf.FloorToInt(totalArea / minimumArea));
            desiredCount = Mathf.Min(desiredCount, facets.Length);
            if (desiredCount < 2) return false;

            Vector2 axis = inwardDirection.sqrMagnitude > Epsilon ? inwardDirection.normalized : Vector2.right;
            float grainRadians = physical.grainAngleDegrees * Mathf.Deg2Rad;
            Vector2 grainAxis = new Vector2(Mathf.Cos(grainRadians), Mathf.Sin(grainRadians));
            if (Vector2.Dot(grainAxis, axis) < 0f) grainAxis = -grainAxis;
            axis = Vector2.Lerp(axis, grainAxis, Mathf.Clamp01(physical.anisotropy) * 0.72f).normalized;
            float extent = Mathf.Max(0.05f, Mathf.Max(bounds.Width, bounds.Height));
            for (int requested = desiredCount; requested >= 2; requested--)
            {
                int[] seeds = SelectSeeds(facets, centers, localHit, axis, requested, extent, impactSeed);
                if (seeds == null) continue;
                int[] owners = GrowConnectedRegions(neighbors, centers, localHit, axis, grainAxis,
                    physical.anisotropy, seeds, extent, impactSeed);
                if (owners == null) continue;
                MergeInvalidRegions(facets, edges, owners, minimumArea, minimumWidth);
                int ownerCount = CompactOwners(owners);
                if (ownerCount < 2) continue;
                FrameActionProceduralRigidFracturePlan2D candidate = BuildResult(facets, edges, owners, ownerCount);
                if (candidate == null || candidate.Pieces.Count < 2) continue;
                bool valid = true;
                for (int pieceIndex = 0; pieceIndex < candidate.Pieces.Count; pieceIndex++)
                {
                    FrameActionProceduralRigidFracturePiece2D piece = candidate.Pieces[pieceIndex];
                    if (piece.Area + Epsilon < minimumArea || piece.MinimumWidth + Epsilon < minimumWidth)
                    {
                        valid = false;
                        break;
                    }
                }
                if (!valid) continue;
                candidate.SourceArea = totalArea;
                plan = candidate;
                return true;
            }
            return false;
        }

        private static FrameActionProceduralRigidVisualFacet2D[] CopyAndRefine(
            IReadOnlyList<FrameActionProceduralRigidVisualFacet2D> source,
            float minimumPieceArea)
        {
            var working = new List<FrameActionProceduralRigidVisualFacet2D>(source.Count);
            for (int index = 0; index < source.Count; index++)
            {
                FrameActionProceduralRigidVisualFacet2D facet = source[index];
                facet.EnsureCounterClockwise();
                if (facet.Area > Epsilon) working.Add(facet);
            }

            // Subdivide the complete local mesh uniformly. Splitting only one triangle would make
            // T-junctions along shared edges and break the connected-fragment guarantee.
            while (working.Count < 12 && working.Count * 4 <= MaximumWorkingFacets)
            {
                float largest = 0f;
                for (int index = 0; index < working.Count; index++) largest = Mathf.Max(largest, working[index].Area);
                if (largest <= minimumPieceArea * 0.82f) break;
                working = SubdivideAll(working);
            }
            return working.ToArray();
        }

        private static List<FrameActionProceduralRigidVisualFacet2D> SubdivideAll(
            IReadOnlyList<FrameActionProceduralRigidVisualFacet2D> source)
        {
            var result = new List<FrameActionProceduralRigidVisualFacet2D>(source.Count * 4);
            for (int index = 0; index < source.Count; index++)
            {
                FrameActionProceduralRigidVisualFacet2D f = source[index];
                Vector2 ab = (f.A + f.B) * 0.5f;
                Vector2 bc = (f.B + f.C) * 0.5f;
                Vector2 ca = (f.C + f.A) * 0.5f;
                Vector2 uvAb = (f.AuthoringUvA + f.AuthoringUvB) * 0.5f;
                Vector2 uvBc = (f.AuthoringUvB + f.AuthoringUvC) * 0.5f;
                Vector2 uvCa = (f.AuthoringUvC + f.AuthoringUvA) * 0.5f;
                int id = unchecked(f.Id * 17);
                result.Add(NewFacet(id + 1, f.A, ab, ca, f.AuthoringUvA, uvAb, uvCa, f.Shade));
                result.Add(NewFacet(id + 2, ab, f.B, bc, uvAb, f.AuthoringUvB, uvBc, f.Shade));
                result.Add(NewFacet(id + 3, ca, bc, f.C, uvCa, uvBc, f.AuthoringUvC, f.Shade));
                result.Add(NewFacet(id + 4, ab, bc, ca, uvAb, uvBc, uvCa, f.Shade));
            }
            return result;
        }

        private static FrameActionProceduralRigidVisualFacet2D NewFacet(
            int id,
            Vector2 a,
            Vector2 b,
            Vector2 c,
            Vector2 uvA,
            Vector2 uvB,
            Vector2 uvC,
            float shade)
        {
            var result = new FrameActionProceduralRigidVisualFacet2D(id, a, b, c, uvA, uvB, uvC, shade);
            result.EnsureCounterClockwise();
            return result;
        }

        private static List<Neighbor>[] BuildAdjacency(
            FrameActionProceduralRigidVisualFacet2D[] facets,
            out Dictionary<EdgeKey, List<EdgeRecord>> edges)
        {
            edges = new Dictionary<EdgeKey, List<EdgeRecord>>(facets.Length * 2);
            for (int index = 0; index < facets.Length; index++)
            {
                FrameActionProceduralRigidVisualFacet2D facet = facets[index];
                AddEdge(edges, index, facet.A, facet.B);
                AddEdge(edges, index, facet.B, facet.C);
                AddEdge(edges, index, facet.C, facet.A);
            }
            List<Neighbor>[] result = new List<Neighbor>[facets.Length];
            for (int index = 0; index < result.Length; index++) result[index] = new List<Neighbor>(3);
            foreach (KeyValuePair<EdgeKey, List<EdgeRecord>> pair in edges)
            {
                List<EdgeRecord> records = pair.Value;
                if (records.Count != 2) continue;
                float length = Vector2.Distance(records[0].Start, records[0].End);
                result[records[0].Facet].Add(new Neighbor(records[1].Facet, length));
                result[records[1].Facet].Add(new Neighbor(records[0].Facet, length));
            }
            return result;
        }

        private static void AddEdge(
            Dictionary<EdgeKey, List<EdgeRecord>> edges,
            int facet,
            Vector2 start,
            Vector2 end)
        {
            EdgeKey key = new EdgeKey(start, end);
            if (!edges.TryGetValue(key, out List<EdgeRecord> list))
            {
                list = new List<EdgeRecord>(2);
                edges.Add(key, list);
            }
            list.Add(new EdgeRecord(facet, start, end));
        }

        private static int CountConnected(List<Neighbor>[] neighbors)
        {
            if (neighbors.Length == 0) return 0;
            bool[] visited = new bool[neighbors.Length];
            int[] queue = new int[neighbors.Length];
            int read = 0;
            int write = 0;
            visited[0] = true;
            queue[write++] = 0;
            while (read < write)
            {
                int current = queue[read++];
                List<Neighbor> list = neighbors[current];
                for (int index = 0; index < list.Count; index++)
                {
                    int next = list[index].Facet;
                    if (visited[next]) continue;
                    visited[next] = true;
                    queue[write++] = next;
                }
            }
            return write;
        }

        private static int[] SelectSeeds(
            FrameActionProceduralRigidVisualFacet2D[] facets,
            Vector2[] centers,
            Vector2 localHit,
            Vector2 axis,
            int count,
            float extent,
            uint seed)
        {
            int[] result = new int[count];
            bool[] used = new bool[facets.Length];
            Vector2 perpendicular = new Vector2(-axis.y, axis.x);
            for (int owner = 0; owner < count; owner++)
            {
                uint mixed = Mix(seed ^ 0x91e10da5u, owner);
                int best = -1;
                if (owner < 3)
                {
                    float side = owner == 0 ? 0f : owner == 1 ? 1f : -1f;
                    float depth = owner == 0 ? 0.28f : 0.56f;
                    float lateral = side * extent * Mathf.Lerp(0.18f, 0.34f,
                        ((mixed >> 8) & 0xffffu) / 65535f);
                    Vector2 target = localHit + axis * extent * depth + perpendicular * lateral;
                    float bestScore = float.PositiveInfinity;
                    for (int index = 0; index < centers.Length; index++)
                    {
                        if (used[index]) continue;
                        Vector2 fromHit = centers[index] - localHit;
                        float behindPenalty = Mathf.Max(0f, -Vector2.Dot(fromHit, axis)) * extent * 0.75f;
                        float score = (centers[index] - target).sqrMagnitude + behindPenalty;
                        if (score >= bestScore) continue;
                        bestScore = score;
                        best = index;
                    }
                }
                else
                {
                    // Deterministic farthest-point sampling distributes fracture nuclei over the
                    // remaining body. It avoids the old impact-facet fan where every region met at
                    // one arbitrary outline vertex.
                    float bestScore = float.NegativeInfinity;
                    for (int index = 0; index < centers.Length; index++)
                    {
                        if (used[index]) continue;
                        float nearest = float.PositiveInfinity;
                        for (int selected = 0; selected < owner; selected++)
                            nearest = Mathf.Min(nearest, (centers[index] - centers[result[selected]]).sqrMagnitude);
                        Vector2 fromHit = centers[index] - localHit;
                        float depthBias = Mathf.Lerp(0.72f, 1.18f,
                            Mathf.Clamp01(Vector2.Dot(fromHit, axis) / Mathf.Max(Epsilon, extent) + 0.35f));
                        float lateralBias = 0.88f + Mathf.Min(0.32f,
                            Mathf.Abs(Vector2.Dot(fromHit, perpendicular)) / Mathf.Max(Epsilon, extent) * 0.32f);
                        float noise = Mathf.Lerp(0.90f, 1.10f, (Mix(mixed, index) & 0xffffu) / 65535f);
                        float score = nearest * depthBias * lateralBias * noise;
                        if (score <= bestScore) continue;
                        bestScore = score;
                        best = index;
                    }
                }
                if (best < 0) return null;
                result[owner] = best;
                used[best] = true;
            }
            return result;
        }

        private static int[] GrowConnectedRegions(
            List<Neighbor>[] neighbors,
            Vector2[] centers,
            Vector2 hit,
            Vector2 axis,
            Vector2 grainAxis,
            float anisotropy,
            int[] seeds,
            float extent,
            uint seed)
        {
            int[] owners = new int[neighbors.Length];
            float[] best = new float[neighbors.Length];
            for (int index = 0; index < owners.Length; index++)
            {
                owners[index] = -1;
                best[index] = float.PositiveInfinity;
            }
            Vector2[] desired = new Vector2[seeds.Length];
            MinHeap heap = new MinHeap(neighbors.Length * 2);
            for (int owner = 0; owner < seeds.Length; owner++)
            {
                Vector2 direction = centers[seeds[owner]] - hit;
                desired[owner] = direction.sqrMagnitude > Epsilon ? direction.normalized : axis;
                best[seeds[owner]] = 0f;
                heap.Push(new QueueNode(seeds[owner], owner, 0f));
            }
            int fixedCount = 0;
            while (heap.Count > 0)
            {
                QueueNode node = heap.Pop();
                if (owners[node.Facet] >= 0 || node.Cost > best[node.Facet] + Epsilon) continue;
                owners[node.Facet] = node.Owner;
                fixedCount++;
                List<Neighbor> list = neighbors[node.Facet];
                for (int index = 0; index < list.Count; index++)
                {
                    int next = list[index].Facet;
                    if (owners[next] >= 0) continue;
                    Vector2 stepDelta = centers[next] - centers[node.Facet];
                    float isotropicStep = stepDelta.magnitude;
                    float alongGrain = Mathf.Abs(Vector2.Dot(stepDelta, grainAxis));
                    float acrossGrain = Mathf.Abs(Cross(grainAxis, stepDelta));
                    float directionalStep = alongGrain * 0.48f + acrossGrain * 2.20f;
                    float step = Mathf.Lerp(isotropicStep, directionalStep, Mathf.Clamp01(anisotropy));
                    Vector2 fromHit = centers[next] - hit;
                    Vector2 direction = fromHit.sqrMagnitude > Epsilon ? fromHit.normalized : desired[node.Owner];
                    float directionPenalty = (1f - Mathf.Clamp(
                        Vector2.Dot(desired[node.Owner], direction), -1f, 1f)) * extent * 0.12f;
                    float impactPenalty = Mathf.Max(0f, -Vector2.Dot(axis, direction)) * extent * 0.08f;
                    float neckPreference = 1f / Mathf.Max(0.005f, list[index].SharedLength);
                    float noise = (Mix(seed ^ (uint)next, node.Owner) & 0xffffu) / 65535f * extent * 0.035f;
                    float cost = node.Cost + step + directionPenalty + impactPenalty + neckPreference * 0.002f + noise;
                    if (cost >= best[next]) continue;
                    best[next] = cost;
                    heap.Push(new QueueNode(next, node.Owner, cost));
                }
            }
            return fixedCount == owners.Length ? owners : null;
        }

        private static void MergeInvalidRegions(
            FrameActionProceduralRigidVisualFacet2D[] facets,
            Dictionary<EdgeKey, List<EdgeRecord>> edges,
            int[] owners,
            float minimumArea,
            float minimumWidth)
        {
            for (int pass = 0; pass < owners.Length; pass++)
            {
                int ownerCount = CompactOwners(owners);
                bool merged = false;
                for (int owner = 0; owner < ownerCount; owner++)
                {
                    MeasureOwner(facets, owners, owner, out float area, out float width);
                    if (area + Epsilon >= minimumArea && width + Epsilon >= minimumWidth) continue;
                    float[] shared = new float[ownerCount];
                    foreach (KeyValuePair<EdgeKey, List<EdgeRecord>> pair in edges)
                    {
                        List<EdgeRecord> records = pair.Value;
                        if (records.Count != 2) continue;
                        int firstOwner = owners[records[0].Facet];
                        int secondOwner = owners[records[1].Facet];
                        if (firstOwner == secondOwner) continue;
                        float length = Vector2.Distance(records[0].Start, records[0].End);
                        if (firstOwner == owner) shared[secondOwner] += length;
                        else if (secondOwner == owner) shared[firstOwner] += length;
                    }
                    int target = -1;
                    float longest = 0f;
                    for (int candidate = 0; candidate < ownerCount; candidate++)
                    {
                        if (candidate == owner || shared[candidate] <= longest) continue;
                        longest = shared[candidate];
                        target = candidate;
                    }
                    if (target < 0) continue;
                    for (int facet = 0; facet < owners.Length; facet++)
                        if (owners[facet] == owner) owners[facet] = target;
                    merged = true;
                    break;
                }
                if (!merged) break;
            }
        }

        private static int CompactOwners(int[] owners)
        {
            var map = new Dictionary<int, int>();
            int count = 0;
            for (int index = 0; index < owners.Length; index++)
            {
                int owner = owners[index];
                if (!map.TryGetValue(owner, out int compact))
                {
                    compact = count++;
                    map.Add(owner, compact);
                }
                owners[index] = compact;
            }
            return count;
        }

        private static FrameActionProceduralRigidFracturePlan2D BuildResult(
            FrameActionProceduralRigidVisualFacet2D[] facets,
            Dictionary<EdgeKey, List<EdgeRecord>> edges,
            int[] owners,
            int ownerCount)
        {
            var result = new FrameActionProceduralRigidFracturePlan2D();
            for (int owner = 0; owner < ownerCount; owner++)
                result.Pieces.Add(new FrameActionProceduralRigidFracturePiece2D());
            for (int index = 0; index < facets.Length; index++) result.Pieces[owners[index]].Facets.Add(facets[index]);

            for (int owner = 0; owner < ownerCount; owner++)
            {
                FrameActionProceduralRigidFracturePiece2D piece = result.Pieces[owner];
                piece.Area = SumArea(piece.Facets);
                piece.Centroid = AreaCentroid(piece.Facets, piece.Area);
                piece.MinimumWidth = MinimumWidth(piece.Facets);
                piece.Boundary = BuildBoundary(edges, owners, owner);
                if (piece.Boundary.Length < 3) return null;
            }

            foreach (KeyValuePair<EdgeKey, List<EdgeRecord>> pair in edges)
            {
                List<EdgeRecord> records = pair.Value;
                if (records.Count != 2) continue;
                if (owners[records[0].Facet] == owners[records[1].Facet]) continue;
                result.Cracks.Add(new FrameActionProceduralRigidCrackSegment2D(
                    records[0].Start,
                    records[0].End,
                    1f));
            }
            return result;
        }

        private static Vector2[] BuildBoundary(
            Dictionary<EdgeKey, List<EdgeRecord>> edges,
            int[] owners,
            int owner)
        {
            var boundaryEdges = new List<EdgeRecord>();
            foreach (KeyValuePair<EdgeKey, List<EdgeRecord>> pair in edges)
            {
                List<EdgeRecord> records = pair.Value;
                for (int index = 0; index < records.Count; index++)
                {
                    EdgeRecord record = records[index];
                    if (owners[record.Facet] != owner) continue;
                    bool sharedInside = false;
                    for (int other = 0; other < records.Count; other++)
                    {
                        if (other != index && owners[records[other].Facet] == owner)
                        {
                            sharedInside = true;
                            break;
                        }
                    }
                    if (!sharedInside) boundaryEdges.Add(record);
                }
            }
            if (boundaryEdges.Count < 3) return Array.Empty<Vector2>();

            var starts = new Dictionary<PointKey, List<int>>();
            for (int index = 0; index < boundaryEdges.Count; index++)
            {
                PointKey key = new PointKey(boundaryEdges[index].Start);
                if (!starts.TryGetValue(key, out List<int> list))
                {
                    list = new List<int>(2);
                    starts.Add(key, list);
                }
                list.Add(index);
            }
            bool[] used = new bool[boundaryEdges.Count];
            List<Vector2> largest = null;
            float largestArea = 0f;
            for (int first = 0; first < boundaryEdges.Count; first++)
            {
                if (used[first]) continue;
                var loop = new List<Vector2>();
                int current = first;
                PointKey startKey = new PointKey(boundaryEdges[first].Start);
                for (int guard = 0; guard <= boundaryEdges.Count; guard++)
                {
                    if (current < 0 || used[current]) break;
                    EdgeRecord edge = boundaryEdges[current];
                    used[current] = true;
                    loop.Add(edge.Start);
                    PointKey endKey = new PointKey(edge.End);
                    if (endKey.Equals(startKey)) break;
                    current = -1;
                    if (!starts.TryGetValue(endKey, out List<int> candidates)) continue;
                    for (int index = 0; index < candidates.Count; index++)
                    {
                        if (used[candidates[index]]) continue;
                        current = candidates[index];
                        break;
                    }
                }
                float area = Mathf.Abs(SignedArea(loop));
                if (loop.Count >= 3 && area > largestArea)
                {
                    largestArea = area;
                    largest = loop;
                }
            }
            if (largest == null) return Array.Empty<Vector2>();
            if (SignedArea(largest) < 0f) largest.Reverse();
            return largest.ToArray();
        }

        private static void MeasureOwner(
            FrameActionProceduralRigidVisualFacet2D[] facets,
            int[] owners,
            int owner,
            out float area,
            out float width)
        {
            var selected = new List<FrameActionProceduralRigidVisualFacet2D>();
            for (int index = 0; index < facets.Length; index++)
                if (owners[index] == owner) selected.Add(facets[index]);
            area = SumArea(selected);
            width = MinimumWidth(selected);
        }

        private static float SumArea(IReadOnlyList<FrameActionProceduralRigidVisualFacet2D> facets)
        {
            float area = 0f;
            for (int index = 0; index < facets.Count; index++) area += facets[index].Area;
            return area;
        }

        private static Vector2 AreaCentroid(IReadOnlyList<FrameActionProceduralRigidVisualFacet2D> facets, float area)
        {
            Vector2 weighted = Vector2.zero;
            if (area <= Epsilon) return weighted;
            for (int index = 0; index < facets.Count; index++)
                weighted += facets[index].Centroid * facets[index].Area;
            return weighted / area;
        }

        private static float MinimumWidth(IReadOnlyList<FrameActionProceduralRigidVisualFacet2D> facets)
        {
            if (facets.Count == 0) return 0f;
            float result = float.PositiveInfinity;
            for (int facetIndex = 0; facetIndex < facets.Count; facetIndex++)
            {
                FrameActionProceduralRigidVisualFacet2D facet = facets[facetIndex];
                Vector2 a = facet.A;
                Vector2 b = facet.B;
                Vector2 c = facet.C;
                for (int edgeIndex = 0; edgeIndex < 3; edgeIndex++)
                {
                    Vector2 start = edgeIndex == 0 ? a : edgeIndex == 1 ? b : c;
                    Vector2 end = edgeIndex == 0 ? b : edgeIndex == 1 ? c : a;
                    Vector2 edge = end - start;
                    if (edge.sqrMagnitude <= Epsilon) continue;
                    Vector2 normal = new Vector2(-edge.y, edge.x).normalized;
                    float minimum = float.PositiveInfinity;
                    float maximum = float.NegativeInfinity;
                    for (int otherFacet = 0; otherFacet < facets.Count; otherFacet++)
                    {
                        FrameActionProceduralRigidVisualFacet2D other = facets[otherFacet];
                        Project(other.A, normal, ref minimum, ref maximum);
                        Project(other.B, normal, ref minimum, ref maximum);
                        Project(other.C, normal, ref minimum, ref maximum);
                    }
                    result = Mathf.Min(result, maximum - minimum);
                }
            }
            return float.IsInfinity(result) ? 0f : result;
        }

        private static void Project(Vector2 point, Vector2 normal, ref float minimum, ref float maximum)
        {
            float value = Vector2.Dot(point, normal);
            minimum = Mathf.Min(minimum, value);
            maximum = Mathf.Max(maximum, value);
        }

        private static bool PointInTriangle(Vector2 point, FrameActionProceduralRigidVisualFacet2D facet)
        {
            float first = Cross(facet.B - facet.A, point - facet.A);
            float second = Cross(facet.C - facet.B, point - facet.B);
            float third = Cross(facet.A - facet.C, point - facet.C);
            bool negative = first < -Epsilon || second < -Epsilon || third < -Epsilon;
            bool positive = first > Epsilon || second > Epsilon || third > Epsilon;
            return !(negative && positive);
        }

        private static float SignedArea(IReadOnlyList<Vector2> points)
        {
            if (points == null || points.Count < 3) return 0f;
            float sum = 0f;
            for (int index = 0; index < points.Count; index++)
            {
                Vector2 next = points[(index + 1) % points.Count];
                sum += points[index].x * next.y - next.x * points[index].y;
            }
            return sum * 0.5f;
        }

        private static float Cross(Vector2 first, Vector2 second)
        {
            return first.x * second.y - first.y * second.x;
        }

        private static uint Mix(uint seed, int index)
        {
            unchecked
            {
                uint value = seed ^ ((uint)index + 1u) * 0x9e3779b9u;
                value ^= value >> 16;
                value *= 0x7feb352du;
                value ^= value >> 15;
                value *= 0x846ca68bu;
                value ^= value >> 16;
                return value;
            }
        }

        private struct Bounds2D
        {
            private bool initialized;
            private Vector2 minimum;
            private Vector2 maximum;
            public float Width => initialized ? maximum.x - minimum.x : 0f;
            public float Height => initialized ? maximum.y - minimum.y : 0f;

            public void Include(Vector2 point)
            {
                if (!initialized)
                {
                    initialized = true;
                    minimum = point;
                    maximum = point;
                    return;
                }
                minimum = Vector2.Min(minimum, point);
                maximum = Vector2.Max(maximum, point);
            }
        }
    }
}
