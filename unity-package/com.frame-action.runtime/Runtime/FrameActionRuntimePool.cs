using System.Collections;
using System.Collections.Generic;
using UnityEngine;

namespace FrameAction
{
    public interface IFrameActionPoolable
    {
        void OnFrameActionPoolAcquire();
        void OnFrameActionPoolRelease();
    }

    public enum FrameActionPoolKind
    {
        Vfx,
        Sfx,
        PhysicalEntity,
    }

    public readonly struct FrameActionPoolStats
    {
        public int Available { get; }
        public int Active { get; }
        public int Capacity { get; }
        public int Created { get; }
        public int Reused { get; }
        public int Destroyed { get; }

        internal FrameActionPoolStats(int available, int active, int capacity, int created, int reused, int destroyed)
        {
            Available = available;
            Active = active;
            Capacity = capacity;
            Created = created;
            Reused = reused;
            Destroyed = destroyed;
        }
    }

    internal sealed class FrameActionPoolLease : MonoBehaviour
    {
        public FrameActionPoolKind kind;
        public int generation;
        public bool inPool;
        public readonly List<MonoBehaviour> callbackBuffer = new List<MonoBehaviour>(8);
    }

    [DisallowMultipleComponent]
    public sealed class FrameActionRuntimePool : MonoBehaviour
    {
        private sealed class PoolMetrics
        {
            public int active;
            public int created;
            public int reused;
            public int destroyed;
        }

        private static FrameActionRuntimePool _instance;
        private readonly Dictionary<FrameActionPoolKind, Stack<GameObject>> _available = new Dictionary<FrameActionPoolKind, Stack<GameObject>>();
        private readonly Dictionary<FrameActionPoolKind, PoolMetrics> _metrics = new Dictionary<FrameActionPoolKind, PoolMetrics>();
        private readonly Dictionary<FrameActionPoolKind, int> _capacities = new Dictionary<FrameActionPoolKind, int>();

        public static GameObject Acquire(FrameActionPoolKind kind, string objectName)
        {
            FrameActionRuntimePool pool = EnsureInstance();
            Stack<GameObject> stack = pool.GetStack(kind);
            GameObject instance = null;
            while (stack.Count > 0 && instance == null) instance = stack.Pop();
            PoolMetrics metrics = pool.GetMetrics(kind);
            if (instance == null)
            {
                instance = CreateInstance(kind, objectName);
                metrics.created += 1;
            }
            else
            {
                metrics.reused += 1;
            }

            FrameActionPoolLease lease = instance.GetComponent<FrameActionPoolLease>();
            if (lease == null) lease = instance.AddComponent<FrameActionPoolLease>();
            lease.kind = kind;
            lease.generation += 1;
            lease.inPool = false;
            metrics.active += 1;
            instance.name = objectName;
            instance.transform.SetParent(null, false);
            instance.transform.localScale = Vector3.one;
            instance.transform.rotation = Quaternion.identity;
            instance.SetActive(true);
            InvokeAcquireCallbacks(instance);
            return instance;
        }

        public static void Release(GameObject instance)
        {
            if (instance == null) return;
            FrameActionPoolLease lease = instance.GetComponent<FrameActionPoolLease>();
            if (lease == null)
            {
                DestroyPooledObject(instance);
                return;
            }
            if (lease.inPool) return;

            InvokeReleaseCallbacks(instance);
            AudioSource audioSource = instance.GetComponent<AudioSource>();
            if (audioSource != null)
            {
                audioSource.Stop();
                audioSource.clip = null;
                audioSource.loop = false;
            }
            SpriteRenderer renderer = instance.GetComponent<SpriteRenderer>();
            if (renderer != null) renderer.sprite = null;

            lease.inPool = true;
            instance.SetActive(false);
            FrameActionRuntimePool pool = EnsureInstance();
            PoolMetrics metrics = pool.GetMetrics(lease.kind);
            metrics.active = Mathf.Max(0, metrics.active - 1);
            Stack<GameObject> stack = pool.GetStack(lease.kind);
            if (stack.Count >= pool.GetCapacity(lease.kind))
            {
                metrics.destroyed += 1;
                DestroyPooledObject(instance);
                return;
            }
            instance.transform.SetParent(pool.transform, false);
            stack.Push(instance);
        }

        public static void ReleaseAfter(GameObject instance, float delay)
        {
            if (instance == null) return;
            FrameActionPoolLease lease = instance.GetComponent<FrameActionPoolLease>();
            if (lease == null)
            {
                if (Application.isPlaying) Destroy(instance, Mathf.Max(0f, delay));
                else DestroyPooledObject(instance);
                return;
            }
            EnsureInstance().StartCoroutine(ReleaseAfterRoutine(instance, lease.generation, Mathf.Max(0f, delay)));
        }

        public static void Prewarm(FrameActionPoolKind kind, int count)
        {
            FrameActionRuntimePool pool = EnsureInstance();
            Stack<GameObject> stack = pool.GetStack(kind);
            int target = Mathf.Min(Mathf.Max(0, count), pool.GetCapacity(kind));
            int missing = target - stack.Count;
            for (int i = 0; i < missing; i++)
            {
                GameObject instance = CreateInstance(kind, $"FrameAction {kind}");
                pool.GetMetrics(kind).created += 1;
                FrameActionPoolLease lease = instance.GetComponent<FrameActionPoolLease>();
                lease.inPool = true;
                instance.SetActive(false);
                instance.transform.SetParent(pool.transform, false);
                stack.Push(instance);
            }
        }

        public static void SetCapacity(FrameActionPoolKind kind, int capacity)
        {
            FrameActionRuntimePool pool = EnsureInstance();
            int resolved = Mathf.Max(0, capacity);
            pool._capacities[kind] = resolved;
            Stack<GameObject> stack = pool.GetStack(kind);
            PoolMetrics metrics = pool.GetMetrics(kind);
            while (stack.Count > resolved)
            {
                GameObject instance = stack.Pop();
                if (instance == null) continue;
                metrics.destroyed += 1;
                DestroyPooledObject(instance);
            }
        }

        public static FrameActionPoolStats GetStats(FrameActionPoolKind kind)
        {
            FrameActionRuntimePool pool = EnsureInstance();
            Stack<GameObject> stack = pool.GetStack(kind);
            RemoveDestroyedEntries(stack);
            PoolMetrics metrics = pool.GetMetrics(kind);
            return new FrameActionPoolStats(stack.Count, metrics.active, pool.GetCapacity(kind), metrics.created, metrics.reused, metrics.destroyed);
        }

        public static void Clear(FrameActionPoolKind kind)
        {
            FrameActionRuntimePool pool = EnsureInstance();
            Stack<GameObject> stack = pool.GetStack(kind);
            PoolMetrics metrics = pool.GetMetrics(kind);
            while (stack.Count > 0)
            {
                GameObject instance = stack.Pop();
                if (instance == null) continue;
                metrics.destroyed += 1;
                DestroyPooledObject(instance);
            }
        }

        public static void ClearAll()
        {
            foreach (FrameActionPoolKind kind in System.Enum.GetValues(typeof(FrameActionPoolKind))) Clear(kind);
        }

        private static GameObject CreateInstance(FrameActionPoolKind kind, string objectName)
        {
            GameObject instance = new GameObject(objectName);
            FrameActionPoolLease lease = instance.AddComponent<FrameActionPoolLease>();
            lease.kind = kind;
            return instance;
        }

        private static IEnumerator ReleaseAfterRoutine(GameObject instance, int generation, float delay)
        {
            if (delay > 0f) yield return new WaitForSeconds(delay);
            if (instance == null) yield break;
            FrameActionPoolLease lease = instance.GetComponent<FrameActionPoolLease>();
            if (lease != null && !lease.inPool && lease.generation == generation) Release(instance);
        }

        private Stack<GameObject> GetStack(FrameActionPoolKind kind)
        {
            if (!_available.TryGetValue(kind, out Stack<GameObject> stack))
            {
                stack = new Stack<GameObject>();
                _available[kind] = stack;
            }
            return stack;
        }

        private PoolMetrics GetMetrics(FrameActionPoolKind kind)
        {
            if (!_metrics.TryGetValue(kind, out PoolMetrics metrics))
            {
                metrics = new PoolMetrics();
                _metrics[kind] = metrics;
            }
            return metrics;
        }

        private int GetCapacity(FrameActionPoolKind kind)
        {
            if (_capacities.TryGetValue(kind, out int capacity)) return capacity;
            switch (kind)
            {
                case FrameActionPoolKind.Vfx: return 96;
                case FrameActionPoolKind.Sfx: return 48;
                default: return 32;
            }
        }

        private static void InvokeAcquireCallbacks(GameObject instance)
        {
            FrameActionPoolLease lease = instance.GetComponent<FrameActionPoolLease>();
            if (lease == null) return;
            lease.callbackBuffer.Clear();
            instance.GetComponentsInChildren(true, lease.callbackBuffer);
            for (int i = 0; i < lease.callbackBuffer.Count; i++)
            {
                MonoBehaviour behaviour = lease.callbackBuffer[i];
                if (!(behaviour is IFrameActionPoolable poolable)) continue;
                try { poolable.OnFrameActionPoolAcquire(); }
                catch (System.Exception exception) { Debug.LogException(exception, behaviour); }
            }
        }

        private static void InvokeReleaseCallbacks(GameObject instance)
        {
            FrameActionPoolLease lease = instance.GetComponent<FrameActionPoolLease>();
            if (lease == null) return;
            lease.callbackBuffer.Clear();
            instance.GetComponentsInChildren(true, lease.callbackBuffer);
            for (int i = 0; i < lease.callbackBuffer.Count; i++)
            {
                MonoBehaviour behaviour = lease.callbackBuffer[i];
                if (!(behaviour is IFrameActionPoolable poolable)) continue;
                try { poolable.OnFrameActionPoolRelease(); }
                catch (System.Exception exception) { Debug.LogException(exception, behaviour); }
            }
        }

        private static void RemoveDestroyedEntries(Stack<GameObject> stack)
        {
            if (stack.Count == 0) return;
            Stack<GameObject> valid = new Stack<GameObject>(stack.Count);
            while (stack.Count > 0)
            {
                GameObject instance = stack.Pop();
                if (instance != null) valid.Push(instance);
            }
            while (valid.Count > 0) stack.Push(valid.Pop());
        }

        private static void DestroyPooledObject(GameObject instance)
        {
            if (instance == null) return;
            if (Application.isPlaying) Destroy(instance);
            else DestroyImmediate(instance);
        }

        private static FrameActionRuntimePool EnsureInstance()
        {
            if (_instance != null) return _instance;
            GameObject root = new GameObject("[Frame Action Runtime Pool]") { hideFlags = HideFlags.DontSave };
            if (Application.isPlaying) DontDestroyOnLoad(root);
            _instance = root.AddComponent<FrameActionRuntimePool>();
            return _instance;
        }

        private void OnDestroy()
        {
            if (_instance == this) _instance = null;
        }
    }
}
