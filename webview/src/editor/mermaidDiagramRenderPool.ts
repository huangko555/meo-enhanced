export type MermaidRenderPriority = 'normal' | 'high';

export type MermaidDiagramRenderRequest = {
  readonly rawSource: string;
  readonly normalizedSource: string;
  readonly themeKey: string;
  readonly configKey: string;
  readonly priority?: MermaidRenderPriority;
};

export type MermaidDiagramRenderResult =
  | { readonly ok: true; readonly svg: string }
  | { readonly ok: false; readonly error: string };

export type MermaidDiagramRenderPool = {
  render(request: MermaidDiagramRenderRequest): Promise<MermaidDiagramRenderResult>;
  runExclusive<T>(operation: () => Promise<T>, priority?: MermaidRenderPriority): Promise<T>;
  refreshTheme(): void;
  subscribeThemeRefresh(listener: () => void): () => void;
  getHeight(key: string): number | null;
  rememberHeight(key: string, height: number): void;
  dispose(): void;
};

export type MermaidDiagramRenderPoolOptions = {
  readonly initialize: (themeKey: string, configKey: string) => Promise<void> | void;
  readonly render: (renderId: string, normalizedSource: string) => Promise<string>;
  readonly cacheLimit?: number;
  readonly heightCacheLimit?: number;
  readonly maxQueuedOperations?: number;
  readonly maxThemeListeners?: number;
};

type OperationJob<T = unknown> = {
  readonly operation: () => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  readonly external: boolean;
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
): MermaidDiagramRenderPool {
  const cacheLimit = options.cacheLimit ?? DEFAULT_CACHE_LIMIT;
  const heightCacheLimit = options.heightCacheLimit ?? DEFAULT_CACHE_LIMIT;
  const maxQueuedOperations = options.maxQueuedOperations ?? DEFAULT_MAX_QUEUED_OPERATIONS;
  const maxThemeListeners = options.maxThemeListeners ?? DEFAULT_MAX_THEME_LISTENERS;
  const cache = new Map<string, MermaidDiagramRenderResult>();
  const inFlight = new Map<string, Promise<MermaidDiagramRenderResult>>();
  const heightCache = new Map<string, number>();
  const themeListeners = new Set<() => void>();
  const highPriority: OperationJob[] = [];
  const normalPriority: OperationJob[] = [];
  let active = false;
  let disposed = false;
  let resourceGeneration = 0;
  let signalDisposed: (() => void) | null = null;
  const disposedSignal = new Promise<void>((resolve) => {
    signalDisposed = resolve;
  });
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

  const runNext = (): void => {
    if (active || disposed) return;
    const job = highPriority.shift() ?? normalPriority.shift();
    if (!job) return;
    active = true;
    void job.operation().then(job.resolve, job.reject).finally(() => {
      if (job.external) initializedIdentity = null;
      active = false;
      runNext();
    });
  };

  const enqueue = <T>(
    operation: () => Promise<T>,
    priority: MermaidRenderPriority,
    external: boolean
  ): Promise<T> => {
    if (disposed) return Promise.reject(new Error('Mermaid render Pool is disposed'));
    if (highPriority.length + normalPriority.length >= maxQueuedOperations) {
      return Promise.reject(new Error('Mermaid render queue capacity exceeded'));
    }
    return new Promise<T>((resolve, reject) => {
      const job: OperationJob<T> = { operation, resolve, reject, external };
      (priority === 'high' ? highPriority : normalPriority).push(job as OperationJob);
      runNext();
    });
  };

  const render = (request: MermaidDiagramRenderRequest): Promise<MermaidDiagramRenderResult> => {
    if (disposed) return Promise.resolve({ ok: false, error: 'Mermaid render Pool is disposed' });
    const key = cacheKeyFor(request);
    const cached = cache.get(key);
    if (cached) {
      remember(cache, key, cached, cacheLimit);
      return Promise.resolve(cached);
    }
    const pending = inFlight.get(key);
    if (pending) return pending;

    const generation = resourceGeneration;
    const queuedOperation = enqueue(async () => {
      const identity = JSON.stringify([request.themeKey, request.configKey]);
      if (initializedIdentity !== identity) {
        await options.initialize(request.themeKey, request.configKey);
        if (!disposed && generation === resourceGeneration) initializedIdentity = identity;
      }
      return options.render(`mermaid-${++renderSequence}`, request.normalizedSource);
    }, request.priority ?? 'normal', false)
      .then(
        (svg): MermaidDiagramRenderResult => ({ ok: true, svg }),
        (error): MermaidDiagramRenderResult => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      )
      .then((result) => {
        if (!disposed && generation === resourceGeneration) remember(cache, key, result, cacheLimit);
        return result;
      });
    let operation!: Promise<MermaidDiagramRenderResult>;
    operation = Promise.race([
      queuedOperation,
      disposedSignal.then((): MermaidDiagramRenderResult => ({
        ok: false,
        error: 'Mermaid render Pool is disposed'
      }))
    ]).finally(() => {
      if (inFlight.get(key) === operation) inFlight.delete(key);
    });
    inFlight.set(key, operation);
    return operation;
  };

  return {
    render,
    runExclusive(operation, priority = 'normal') {
      const queuedOperation = enqueue(operation, priority, true);
      return Promise.race([
        queuedOperation,
        disposedSignal.then(() => Promise.reject<never>(new Error('Mermaid render Pool is disposed')))
      ]);
    },
    refreshTheme() {
      if (disposed) return;
      cache.clear();
      inFlight.clear();
      heightCache.clear();
      resourceGeneration += 1;
      initializedIdentity = null;
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
      signalDisposed?.();
      signalDisposed = null;
      const error = new Error('Mermaid render Pool is disposed');
      for (const job of [...highPriority, ...normalPriority]) job.reject(error);
      highPriority.length = 0;
      normalPriority.length = 0;
      cache.clear();
      inFlight.clear();
      heightCache.clear();
      resourceGeneration += 1;
      themeListeners.clear();
      initializedIdentity = null;
    }
  };
}
