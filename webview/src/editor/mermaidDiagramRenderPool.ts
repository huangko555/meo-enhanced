import {
  MermaidDiagramResourceUnavailableError,
  type MermaidDiagramRenderConsumer,
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

type RenderConsumerGroup = {
  readonly retainedJobs: Set<OperationJob>;
};

type RenderConsumerRecord = {
  active: boolean;
  generation: number;
  readonly group: RenderConsumerGroup;
  readonly cacheKeys: Set<string>;
  readonly waiters: Set<OperationWaiter>;
};

type OperationWaiter = {
  readonly consumer: RenderConsumerRecord;
  readonly generation: number;
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
  readonly retainedGroups: Set<RenderConsumerGroup>;
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

/** Owns the single Webview-wide Mermaid renderer queue and resource caches. */
export function createMermaidDiagramRenderPool(
  options: MermaidDiagramRenderPoolOptions
): MermaidDiagramRenderResources {
  const cacheLimit = options.cacheLimit ?? DEFAULT_CACHE_LIMIT;
  const heightCacheLimit = options.heightCacheLimit ?? DEFAULT_CACHE_LIMIT;
  const maxQueuedOperations = options.maxQueuedOperations ?? DEFAULT_MAX_QUEUED_OPERATIONS;
  const maxThemeListeners = options.maxThemeListeners ?? DEFAULT_MAX_THEME_LISTENERS;
  const cache = new Map<string, MermaidDiagramRenderResult>();
  const renderJobs = new Map<string, OperationJob>();
  const heightCache = new Map<string, number>();
  const themeListeners = new Set<() => void>();
  const consumers = new Set<RenderConsumerRecord>();
  const highPriority: OperationJob[] = [];
  const normalPriority: OperationJob[] = [];
  let activeJob: OperationJob | null = null;
  let disposed = false;
  let resourceGeneration = 0;
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
    error: message
  });

  const removeQueuedJob = (job: OperationJob): void => {
    for (const queue of [highPriority, normalPriority]) {
      const index = queue.indexOf(job);
      if (index >= 0) queue.splice(index, 1);
    }
    if (job.cacheKey && renderJobs.get(job.cacheKey) === job) renderJobs.delete(job.cacheKey);
  };

  const settleWaiter = (
    waiter: OperationWaiter,
    outcome: { readonly value: unknown } | { readonly error: unknown }
  ): void => {
    if (waiter.settled) return;
    waiter.settled = true;
    waiter.consumer.waiters.delete(waiter);
    waiter.job.waiters.delete(waiter);
    if ('error' in outcome) waiter.reject(outcome.error);
    else waiter.resolve(outcome.value);
  };

  const cancelIfOrphaned = (
    job: OperationJob,
    reusableGroup: RenderConsumerGroup | null
  ): void => {
    if (job.state === 'settled') return;
    if (reusableGroup) {
      job.retainedGroups.add(reusableGroup);
      reusableGroup.retainedJobs.add(job);
    }
    if (job.waiters.size > 0) return;
    if (reusableGroup) {
      return;
    }
    if (job.retainedGroups.size > 0) return;
    if (job.state === 'queued') removeQueuedJob(job);
    else if (job.cacheKey && renderJobs.get(job.cacheKey) === job) renderJobs.delete(job.cacheKey);
  };

  const invalidateConsumer = (
    consumer: RenderConsumerRecord,
    reason: MermaidDiagramResourceUnavailableError,
    evictOwnedCache: boolean,
    reusableGroup: RenderConsumerGroup | null
  ): void => {
    if (!consumer.active) return;
    consumer.generation += 1;
    const jobs = new Set<OperationJob>();
    for (const waiter of [...consumer.waiters]) {
      jobs.add(waiter.job);
      settleWaiter(waiter, { error: reason });
    }
    if (evictOwnedCache) {
      for (const job of jobs) {
        job.retainedGroups.delete(consumer.group);
        consumer.group.retainedJobs.delete(job);
      }
    }
    for (const job of jobs) cancelIfOrphaned(job, reusableGroup);
    if (evictOwnedCache) {
      for (const key of consumer.cacheKeys) {
        const shared = [...consumers].some((candidate) => (
          candidate !== consumer && candidate.active && candidate.cacheKeys.has(key)
        ));
        if (!shared) cache.delete(key);
      }
    }
    consumer.cacheKeys.clear();
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
        if (
          job.cacheKey &&
          (job.waiters.size > 0 || job.retainedGroups.size > 0) &&
          !disposed &&
          job.resourceGeneration === resourceGeneration
        ) {
          remember(cache, job.cacheKey, value as MermaidDiagramRenderResult, cacheLimit);
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
      if (job.cacheKey && renderJobs.get(job.cacheKey) === job) renderJobs.delete(job.cacheKey);
      if (job.external) initializedIdentity = null;
      activeJob = null;
      runNext();
    });
  };

  const enqueue = (
    job: OperationJob,
    priority: MermaidRenderPriority,
  ): boolean => {
    if (disposed) return false;
    if (highPriority.length + normalPriority.length >= maxQueuedOperations) {
      return false;
    }
    (priority === 'high' ? highPriority : normalPriority).push(job);
    runNext();
    return true;
  };

  const attach = <T>(job: OperationJob, consumer: RenderConsumerRecord): Promise<T> => (
    new Promise<T>((resolve, reject) => {
      job.retainedGroups.delete(consumer.group);
      consumer.group.retainedJobs.delete(job);
      const waiter: OperationWaiter = {
        consumer,
        generation: consumer.generation,
        job,
        resolve: (value) => resolve(value as T),
        reject,
        settled: false
      };
      consumer.waiters.add(waiter);
      job.waiters.add(waiter);
    })
  );

  const render = (
    consumer: RenderConsumerRecord,
    request: MermaidDiagramRenderRequest
  ): Promise<MermaidDiagramRenderResult> => {
    if (disposed || !consumer.active) {
      return Promise.resolve(unavailable('Mermaid render consumer is released'));
    }
    const key = cacheKeyFor(request);
    consumer.cacheKeys.add(key);
    const cached = cache.get(key);
    if (cached) {
      remember(cache, key, cached, cacheLimit);
      return Promise.resolve(cached);
    }
    const pending = renderJobs.get(key);
    if (pending && pending.resourceGeneration === resourceGeneration) {
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

  const groupHasOtherConsumer = (
    group: RenderConsumerGroup,
    excluded: RenderConsumerRecord
  ): boolean => [...consumers].some((candidate) => (
    candidate !== excluded && candidate.active && candidate.group === group
  ));

  const releaseGroupIfUnused = (group: RenderConsumerGroup): void => {
    if ([...consumers].some((consumer) => consumer.active && consumer.group === group)) return;
    for (const job of [...group.retainedJobs]) {
      group.retainedJobs.delete(job);
      job.retainedGroups.delete(group);
      if (job.waiters.size === 0) cancelIfOrphaned(job, null);
    }
  };

  const invalidateGroup = (
    group: RenderConsumerGroup,
    reason: MermaidDiagramResourceUnavailableError,
    evictOwnedCache: boolean
  ): void => {
    for (const consumer of [...consumers]) {
      if (consumer.group === group) invalidateConsumer(consumer, reason, evictOwnedCache, null);
    }
    for (const job of [...group.retainedJobs]) {
      group.retainedJobs.delete(job);
      job.retainedGroups.delete(group);
      if (job.waiters.size === 0) cancelIfOrphaned(job, null);
    }
  };

  const releaseGroup = (
    group: RenderConsumerGroup,
    reason: MermaidDiagramResourceUnavailableError
  ): void => {
    invalidateGroup(group, reason, false);
    for (const consumer of [...consumers]) {
      if (consumer.group !== group) continue;
      consumer.active = false;
      consumers.delete(consumer);
    }
    if (consumers.size === 0) {
      resourceGeneration += 1;
      initializedIdentity = null;
    }
  };

  const createConsumer = (
    group: RenderConsumerGroup,
    ownsGroup: boolean
  ): MermaidDiagramRenderConsumer => {
    const consumer: RenderConsumerRecord = {
      active: true,
      generation: 0,
      group,
      cacheKeys: new Set(),
      waiters: new Set()
    };
    consumers.add(consumer);
    return {
      fork() {
        if (!consumer.active || disposed) return createUnavailableConsumer();
        return createConsumer(group, false);
      },
      render: (request) => render(consumer, request),
      getCached(request) {
        if (!consumer.active || disposed) return null;
        const key = cacheKeyFor(request);
        consumer.cacheKeys.add(key);
        const cached = cache.get(key) ?? null;
        if (cached) remember(cache, key, cached, cacheLimit);
        return cached;
      },
      runExclusive<T>(
        operation: () => Promise<T>,
        priority: MermaidRenderPriority = 'normal'
      ): Promise<T> {
        if (!consumer.active || disposed) {
          return Promise.reject(new MermaidDiagramResourceUnavailableError(
            'Mermaid render consumer is released'
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
        const result = attach<T>(job, consumer);
        if (!enqueue(job, priority)) {
          for (const waiter of [...job.waiters]) settleWaiter(waiter, {
            error: new MermaidDiagramResourceUnavailableError('Mermaid render queue capacity exceeded')
          });
        }
        return result;
      },
      invalidate() {
        const reason = new MermaidDiagramResourceUnavailableError(
          'Mermaid render consumer generation was replaced'
        );
        if (ownsGroup) invalidateGroup(group, reason, true);
        else invalidateConsumer(consumer, reason, true, null);
      },
      release() {
        if (!consumer.active) return;
        const reason = new MermaidDiagramResourceUnavailableError('Mermaid render consumer is released');
        if (ownsGroup) {
          releaseGroup(group, reason);
          return;
        }
        invalidateConsumer(
          consumer,
          reason,
          false,
          groupHasOtherConsumer(group, consumer) ? group : null
        );
        consumer.active = false;
        consumers.delete(consumer);
        releaseGroupIfUnused(group);
        if (consumers.size === 0) {
          resourceGeneration += 1;
          initializedIdentity = null;
        }
      }
    };
  };

  const createUnavailableConsumer = (): MermaidDiagramRenderConsumer => ({
    fork: createUnavailableConsumer,
    render: async () => unavailable('Mermaid render Pool is disposed'),
    getCached: () => null,
    runExclusive: async () => {
      throw new MermaidDiagramResourceUnavailableError('Mermaid render Pool is disposed');
    },
    invalidate() {},
    release() {}
  });

  return {
    acquire() {
      if (disposed) {
        return createUnavailableConsumer();
      }
      return createConsumer({ retainedJobs: new Set() }, true);
    },
    getCached(request) {
      if (disposed) return null;
      const key = cacheKeyFor(request);
      const cached = cache.get(key) ?? null;
      if (cached) remember(cache, key, cached, cacheLimit);
      return cached;
    },
    refreshTheme() {
      if (disposed) return;
      cache.clear();
      resourceGeneration += 1;
      initializedIdentity = null;
      const reason = new MermaidDiagramResourceUnavailableError('Mermaid render theme generation was replaced');
      for (const consumer of consumers) invalidateConsumer(consumer, reason, false, null);
      for (const job of renderJobs.values()) {
        for (const group of job.retainedGroups) group.retainedJobs.delete(job);
        job.retainedGroups.clear();
        if (job.waiters.size === 0) cancelIfOrphaned(job, null);
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
      const groups = new Set([...consumers].map((consumer) => consumer.group));
      for (const consumer of [...consumers]) {
        invalidateConsumer(consumer, error, false, null);
        consumer.active = false;
      }
      consumers.clear();
      for (const group of groups) {
        for (const job of group.retainedJobs) job.retainedGroups.delete(group);
        group.retainedJobs.clear();
      }
      for (const job of [...highPriority, ...normalPriority]) {
        for (const waiter of [...job.waiters]) settleWaiter(waiter, { error });
        job.state = 'settled';
      }
      highPriority.length = 0;
      normalPriority.length = 0;
      cache.clear();
      renderJobs.clear();
      heightCache.clear();
      resourceGeneration += 1;
      themeListeners.clear();
      initializedIdentity = null;
    }
  };
}
