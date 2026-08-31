import {
  MermaidDiagramResourceUnavailableError,
  type MermaidDiagramLeafRenderConsumer,
  type MermaidDiagramRenderGroupLease,
  type MermaidDiagramRenderRequest,
  type MermaidDiagramRenderResources,
  type MermaidDiagramRenderResult,
  type MermaidRenderPriority
} from '../application/mermaidDiagramRenderResources';

export type MermaidDiagramRenderPoolOptions = {
  readonly initialize: (themeKey: string, configKey: string) => Promise<void> | void;
  readonly render: (renderId: string, normalizedSource: string) => Promise<string>;
  readonly cacheLimit?: number;
  readonly heightCacheLimit?: number;
  readonly maxQueuedOperations?: number;
  readonly maxThemeListeners?: number;
};

type RenderGroupRecord = {
  active: boolean;
  readonly leaves: Set<LeafRenderConsumerRecord>;
  readonly retainedJobs: Set<OperationJob>;
  readonly waiters: Set<OperationWaiter>;
};

type LeafRenderConsumerRecord = {
  active: boolean;
  readonly group: RenderGroupRecord;
  readonly waiters: Set<OperationWaiter>;
};

type WaiterOwner = RenderGroupRecord | LeafRenderConsumerRecord;

type OperationWaiter = {
  readonly owner: WaiterOwner;
  readonly job: OperationJob;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  settled: boolean;
};

type OperationJob = {
  readonly operation: () => Promise<unknown>;
  readonly waiters: Set<OperationWaiter>;
  readonly external: boolean;
  readonly resourceGeneration: number;
  readonly cacheKey?: string;
  readonly staleKey?: string;
  readonly themeGeneration?: number;
  readonly retainedGroups: Set<RenderGroupRecord>;
  state: 'queued' | 'running' | 'settled';
};

const DEFAULT_CACHE_LIMIT = 100;
const DEFAULT_MAX_QUEUED_OPERATIONS = 512;
const DEFAULT_MAX_THEME_LISTENERS = 512;

const cacheKeyFor = (request: MermaidDiagramRenderRequest): string => JSON.stringify([
  request.themeKey,
  request.configKey,
  request.rawSource
]);

const staleKeyFor = (request: MermaidDiagramRenderRequest): string => request.rawSource;

/** Owns the single Webview-wide Mermaid renderer queue and content-addressed caches. */
export function createMermaidDiagramRenderPool(
  options: MermaidDiagramRenderPoolOptions
): MermaidDiagramRenderResources {
  const cacheLimit = options.cacheLimit ?? DEFAULT_CACHE_LIMIT;
  const heightCacheLimit = options.heightCacheLimit ?? DEFAULT_CACHE_LIMIT;
  const maxQueuedOperations = options.maxQueuedOperations ?? DEFAULT_MAX_QUEUED_OPERATIONS;
  const maxThemeListeners = options.maxThemeListeners ?? DEFAULT_MAX_THEME_LISTENERS;
  const cache = new Map<string, MermaidDiagramRenderResult>();
  const staleCache = new Map<string, {
    readonly themeGeneration: number;
    readonly result: Extract<MermaidDiagramRenderResult, { ok: true }>;
  }>();
  const renderJobs = new Map<string, OperationJob>();
  const heightCache = new Map<string, number>();
  const themeListeners = new Set<() => void>();
  const groups = new Set<RenderGroupRecord>();
  const highPriority: OperationJob[] = [];
  const normalPriority: OperationJob[] = [];
  let activeJob: OperationJob | null = null;
  let disposed = false;
  let resourceGeneration = 0;
  let themeGeneration = 0;
  let renderSequence = 0;
  let initializedIdentity: string | null = null;

  const remember = <T>(target: Map<string, T>, key: string, value: T, limit: number): void => {
    target.delete(key);
    target.set(key, value);
    while (target.size > limit) {
      const oldest = target.keys().next().value;
      if (oldest === undefined) break;
      target.delete(oldest);
    }
  };

  const unavailable = (message: string): MermaidDiagramRenderResult => ({
    ok: false,
    error: message,
    unavailable: true
  });

  const retireFromReuse = (job: OperationJob): void => {
    if (job.cacheKey && renderJobs.get(job.cacheKey) === job) renderJobs.delete(job.cacheKey);
  };

  const removeQueuedJob = (job: OperationJob): void => {
    for (const queue of [highPriority, normalPriority]) {
      const index = queue.indexOf(job);
      if (index >= 0) queue.splice(index, 1);
    }
    retireFromReuse(job);
    job.state = 'settled';
  };

  const settleWaiter = (
    waiter: OperationWaiter,
    outcome: { readonly value: unknown } | { readonly error: unknown }
  ): void => {
    if (waiter.settled) return;
    waiter.settled = true;
    waiter.owner.waiters.delete(waiter);
    waiter.job.waiters.delete(waiter);
    if ('error' in outcome) waiter.reject(outcome.error);
    else waiter.resolve(outcome.value);
  };

  const cancelIfOrphaned = (job: OperationJob): void => {
    if (
      job.state === 'settled'
      || job.waiters.size > 0
      || [...job.retainedGroups].some((group) => group.active)
    ) {
      return;
    }
    if (job.state === 'queued') removeQueuedJob(job);
    else retireFromReuse(job);
  };

  const retainForGroup = (job: OperationJob, group: RenderGroupRecord): void => {
    if (!group.active || job.state === 'settled') return;
    job.retainedGroups.add(group);
    group.retainedJobs.add(job);
  };

  const detachWaiters = (
    owner: WaiterOwner,
    reason: MermaidDiagramResourceUnavailableError,
    retainLeafWork: boolean
  ): void => {
    const jobs = new Set<OperationJob>();
    for (const waiter of [...owner.waiters]) {
      jobs.add(waiter.job);
      settleWaiter(waiter, { error: reason });
    }
    for (const job of jobs) {
      if (retainLeafWork && 'group' in owner) retainForGroup(job, owner.group);
      cancelIfOrphaned(job);
    }
  };

  const releaseRetainedJobs = (group: RenderGroupRecord): void => {
    for (const job of [...group.retainedJobs]) {
      group.retainedJobs.delete(job);
      job.retainedGroups.delete(group);
      cancelIfOrphaned(job);
    }
  };

  const runNext = (): void => {
    if (activeJob || disposed) return;
    let job = highPriority.shift() ?? normalPriority.shift();
    while (job && job.waiters.size === 0 && job.retainedGroups.size === 0) {
      if (job.cacheKey && renderJobs.get(job.cacheKey) === job) renderJobs.delete(job.cacheKey);
      job.state = 'settled';
      job = highPriority.shift() ?? normalPriority.shift();
    }
    if (!job) return;
    activeJob = job;
    job.state = 'running';
    void job.operation().then(
      (value) => {
        const result = value as MermaidDiagramRenderResult;
        if (
          job.cacheKey
          && renderJobs.get(job.cacheKey) === job
          && result?.ok === true
          && (job.waiters.size > 0 || job.retainedGroups.size > 0)
          && !disposed
          && job.resourceGeneration === resourceGeneration
        ) {
          remember(cache, job.cacheKey, result, cacheLimit);
          if (job.staleKey && job.themeGeneration !== undefined) {
            remember(staleCache, job.staleKey, {
              themeGeneration: job.themeGeneration,
              result
            }, cacheLimit);
          }
        }
        for (const waiter of [...job.waiters]) settleWaiter(waiter, { value });
      },
      (error) => {
        for (const waiter of [...job.waiters]) settleWaiter(waiter, { error });
      }
    ).finally(() => {
      job.state = 'settled';
      for (const group of job.retainedGroups) group.retainedJobs.delete(job);
      job.retainedGroups.clear();
      retireFromReuse(job);
      if (job.external) initializedIdentity = null;
      activeJob = null;
      runNext();
    });
  };

  const enqueue = (job: OperationJob, priority: MermaidRenderPriority): boolean => {
    if (disposed) return false;
    if (highPriority.length + normalPriority.length >= maxQueuedOperations) return false;
    (priority === 'high' ? highPriority : normalPriority).push(job);
    runNext();
    return true;
  };

  const promoteQueuedJob = (job: OperationJob): void => {
    if (job.state !== 'queued') return;
    const index = normalPriority.indexOf(job);
    if (index < 0) return;
    normalPriority.splice(index, 1);
    highPriority.unshift(job);
  };

  const attach = <T>(job: OperationJob, owner: WaiterOwner): Promise<T> => (
    new Promise<T>((resolve, reject) => {
      const group = 'group' in owner ? owner.group : owner;
      job.retainedGroups.delete(group);
      group.retainedJobs.delete(job);
      const waiter: OperationWaiter = {
        owner,
        job,
        resolve: (value) => resolve(value as T),
        reject,
        settled: false
      };
      owner.waiters.add(waiter);
      job.waiters.add(waiter);
    })
  );

  const render = (
    consumer: LeafRenderConsumerRecord,
    request: MermaidDiagramRenderRequest
  ): Promise<MermaidDiagramRenderResult> => {
    if (disposed || !consumer.active || !consumer.group.active) {
      return Promise.resolve(unavailable('Mermaid render leaf consumer is released'));
    }
    const key = cacheKeyFor(request);
    const cached = cache.get(key);
    if (cached) {
      remember(cache, key, cached, cacheLimit);
      return Promise.resolve(cached);
    }
    const pending = renderJobs.get(key);
    if (pending && pending.resourceGeneration === resourceGeneration) {
      if (request.priority === 'high') promoteQueuedJob(pending);
      return attach<MermaidDiagramRenderResult>(pending, consumer).catch((error) => unavailable(
        error instanceof Error ? error.message : String(error)
      ));
    }

    const generation = resourceGeneration;
    const job: OperationJob = {
      operation: async (): Promise<MermaidDiagramRenderResult> => {
        try {
          const identity = JSON.stringify([request.themeKey, request.configKey]);
          if (initializedIdentity !== identity) {
            await options.initialize(request.themeKey, request.configKey);
            if (!disposed && generation === resourceGeneration) initializedIdentity = identity;
          }
          const svg = await options.render(`mermaid-${++renderSequence}`, request.normalizedSource);
          return { ok: true, svg };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          };
        }
      },
      waiters: new Set(),
      external: false,
      resourceGeneration: generation,
      cacheKey: key,
      staleKey: staleKeyFor(request),
      themeGeneration,
      retainedGroups: new Set(),
      state: 'queued'
    };
    const result = attach<MermaidDiagramRenderResult>(job, consumer).catch((error) => unavailable(
      error instanceof Error ? error.message : String(error)
    ));
    renderJobs.set(key, job);
    if (!enqueue(job, request.priority ?? 'normal')) {
      renderJobs.delete(key);
      for (const waiter of [...job.waiters]) settleWaiter(waiter, {
        error: new MermaidDiagramResourceUnavailableError('Mermaid render queue capacity exceeded')
      });
    }
    return result;
  };

  const replaceGroupForExternalDocument = (group: RenderGroupRecord): void => {
    if (disposed || !group.active) {
      throw new MermaidDiagramResourceUnavailableError('Mermaid render group is ended');
    }
    const reason = new MermaidDiagramResourceUnavailableError(
      'Mermaid render group was replaced for an external Document'
    );
    // Existing sibling waiters may finish, but the replaced group establishes a freshness
    // barrier: no later request may attach to any work that belonged to its old Document.
    for (const waiter of group.waiters) retireFromReuse(waiter.job);
    for (const leaf of group.leaves) {
      for (const waiter of leaf.waiters) retireFromReuse(waiter.job);
    }
    for (const job of group.retainedJobs) retireFromReuse(job);
    detachWaiters(group, reason, false);
    for (const leaf of group.leaves) detachWaiters(leaf, reason, false);
    releaseRetainedJobs(group);
  };

  const endGroup = (
    group: RenderGroupRecord,
    reason = new MermaidDiagramResourceUnavailableError('Mermaid render group is ended')
  ): void => {
    if (!group.active) return;
    detachWaiters(group, reason, false);
    for (const leaf of group.leaves) {
      detachWaiters(leaf, reason, false);
      leaf.active = false;
    }
    group.leaves.clear();
    releaseRetainedJobs(group);
    group.active = false;
    groups.delete(group);
    if (groups.size === 0) {
      resourceGeneration += 1;
      initializedIdentity = null;
    }
  };

  const createLeaf = (group: RenderGroupRecord): MermaidDiagramLeafRenderConsumer => {
    if (disposed || !group.active) {
      throw new MermaidDiagramResourceUnavailableError('Mermaid render group is ended');
    }
    const consumer: LeafRenderConsumerRecord = {
      active: true,
      group,
      waiters: new Set()
    };
    group.leaves.add(consumer);
    return {
      render: (request) => render(consumer, request),
      getCached(request) {
        if (disposed || !consumer.active || !group.active) return null;
        const key = cacheKeyFor(request);
        const cached = cache.get(key) ?? null;
        if (cached) remember(cache, key, cached, cacheLimit);
        return cached;
      },
      replacePending() {
        if (disposed || !consumer.active || !group.active) {
          throw new MermaidDiagramResourceUnavailableError('Mermaid render leaf consumer is released');
        }
        detachWaiters(
          consumer,
          new MermaidDiagramResourceUnavailableError('Mermaid render leaf consumer was replaced'),
          true
        );
      },
      release() {
        if (!consumer.active) return;
        detachWaiters(
          consumer,
          new MermaidDiagramResourceUnavailableError('Mermaid render leaf consumer is released'),
          group.active
        );
        consumer.active = false;
        group.leaves.delete(consumer);
      }
    };
  };

  const createGroup = (): MermaidDiagramRenderGroupLease => {
    if (disposed) throw new MermaidDiagramResourceUnavailableError('Mermaid render Pool is disposed');
    const group: RenderGroupRecord = {
      active: true,
      leaves: new Set(),
      retainedJobs: new Set(),
      waiters: new Set()
    };
    groups.add(group);
    return {
      createLeaf: () => createLeaf(group),
      runExclusive<T>(
        operation: () => Promise<T>,
        priority: MermaidRenderPriority = 'normal'
      ): Promise<T> {
        if (disposed || !group.active) {
          return Promise.reject(new MermaidDiagramResourceUnavailableError(
            'Mermaid render group is ended'
          ));
        }
        const job: OperationJob = {
          operation,
          waiters: new Set(),
          external: true,
          resourceGeneration,
          retainedGroups: new Set(),
          state: 'queued'
        };
        const result = attach<T>(job, group);
        if (!enqueue(job, priority)) {
          for (const waiter of [...job.waiters]) settleWaiter(waiter, {
            error: new MermaidDiagramResourceUnavailableError('Mermaid render queue capacity exceeded')
          });
        }
        return result;
      },
      replaceForExternalDocument: () => replaceGroupForExternalDocument(group),
      end: () => endGroup(group)
    };
  };

  return {
    acquireGroup: createGroup,
    getCached(request) {
      if (disposed) return null;
      const key = cacheKeyFor(request);
      const cached = cache.get(key) ?? null;
      if (cached) remember(cache, key, cached, cacheLimit);
      return cached;
    },
    getStale(request) {
      if (disposed) return null;
      const key = staleKeyFor(request);
      const cached = staleCache.get(key) ?? null;
      if (cached) remember(staleCache, key, cached, cacheLimit);
      return cached && cached.themeGeneration !== themeGeneration
        ? cached.result
        : null;
    },
    refreshTheme() {
      if (disposed) return;
      for (const [key, result] of cache) {
        if (result.ok !== true) continue;
        const parsed = JSON.parse(key) as [string, string, string];
        remember(staleCache, parsed[2], {
          themeGeneration,
          result
        }, cacheLimit);
      }
      cache.clear();
      themeGeneration += 1;
      resourceGeneration += 1;
      initializedIdentity = null;
      const reason = new MermaidDiagramResourceUnavailableError(
        'Mermaid render theme generation was replaced'
      );
      for (const group of groups) {
        detachWaiters(group, reason, false);
        for (const leaf of group.leaves) detachWaiters(leaf, reason, false);
        releaseRetainedJobs(group);
      }
      for (const listener of themeListeners) listener();
    },
    subscribeThemeRefresh(listener) {
      if (disposed || themeListeners.size >= maxThemeListeners) return () => undefined;
      themeListeners.add(listener);
      return () => themeListeners.delete(listener);
    },
    getHeight(key) {
      const height = heightCache.get(key);
      if (height === undefined) return null;
      remember(heightCache, key, height, heightCacheLimit);
      return height;
    },
    rememberHeight(key, height) {
      if (disposed || !Number.isFinite(height) || height <= 0) return;
      remember(heightCache, key, height, heightCacheLimit);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const error = new MermaidDiagramResourceUnavailableError('Mermaid render Pool is disposed');
      for (const group of [...groups]) endGroup(group, error);
      for (const job of [...highPriority, ...normalPriority]) {
        for (const waiter of [...job.waiters]) settleWaiter(waiter, { error });
        job.state = 'settled';
      }
      highPriority.length = 0;
      normalPriority.length = 0;
      cache.clear();
      staleCache.clear();
      renderJobs.clear();
      heightCache.clear();
      resourceGeneration += 1;
      themeListeners.clear();
      initializedIdentity = null;
    }
  };
}
