import type {
  ImagePresentationEffect,
  ImagePresentationEffectContext,
  ImagePresentationEffectExecution,
  ImagePresentationEffectExecutor,
  ImagePresentationInput
} from '../application/imagePresentation';
import { createImagePresentationApplication } from '../application/imagePresentation';
import { createImagePresentationRuntime } from '../adapters/imagePresentationRuntime';
import type {
  ImagePresentationFactory,
  ImagePresentationHandle,
  ImagePresentationView
} from './imagePresentation';

const DEFAULT_RESOLUTION_CACHE_LIMIT = 512;
const DEFAULT_LOADED_CACHE_LIMIT = 128;
const DEFAULT_FAILURE_CACHE_LIMIT = 256;
const DEFAULT_MAX_CONCURRENT_LOADS = 6;
const DEFAULT_MAX_PENDING_RESOLUTIONS = 512;
const DEFAULT_MAX_QUEUED_LOADS = 512;
const DEFAULT_FAILURE_RETRY_MS = 30_000;

/**
 * Shared resolve/load state for one active resource generation. Callers must
 * acquire before requesting work; the last idempotent release invalidates the
 * generation, settles its waiters and clears its bounded caches.
 */
export type ImagePresentationResourcePool = {
  acquire(): () => void;
  invalidate(): void;
  invalidateResource(contextKey: string, rawSrc: string, resolvedSrc: string | null): void;
  resolve(contextKey: string, rawSrc: string): Promise<string | null>;
  getResolved(contextKey: string, rawSrc: string): string | null;
  load(contextKey: string, resolvedSrc: string): Promise<HTMLImageElement | null>;
  getLoaded(contextKey: string, resolvedSrc: string): HTMLImageElement | null;
  dispose(): void;
};

export type ImagePresentationResourcePoolOptions = {
  readonly resolveSource: (
    contextKey: string,
    rawSrc: string,
    signal: AbortSignal
  ) => Promise<string | null>;
  readonly loadImage: (
    resolvedSrc: string,
    signal: AbortSignal,
    forceReload: boolean
  ) => Promise<HTMLImageElement | null>;
  readonly now?: () => number;
  readonly maxConcurrentLoads?: number;
  readonly maxPendingResolutions?: number;
  readonly maxQueuedLoads?: number;
  readonly failureRetryMs?: number;
  readonly resolutionCacheLimit?: number;
  readonly loadedCacheLimit?: number;
  readonly failureCacheLimit?: number;
};

type QueuedLoad = {
  readonly run: () => void;
  readonly cancel: () => void;
};

type ImageResourceLease = {
  released: boolean;
};

type ImageResourceGeneration = {
  readonly leases: Set<ImageResourceLease>;
  readonly abortController: AbortController;
  readonly releasedResult: Promise<null>;
  readonly settleReleased: () => void;
  readonly resolvedCache: Map<string, string>;
  readonly resolutionInFlight: Map<string, Promise<string | null>>;
  readonly loadedCache: Map<string, HTMLImageElement>;
  readonly loadInFlight: Map<string, Promise<HTMLImageElement | null>>;
  readonly failedAt: Map<string, number>;
  readonly forcedReloads: Set<string>;
  readonly queue: QueuedLoad[];
  activeLoads: number;
  released: boolean;
};

const cacheKey = (contextKey: string, src: string): string => `${contextKey.length}:${contextKey}${src}`;

function touch<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key);
  cache.set(key, value);
}

function setBounded<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): void {
  touch(cache, key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Shared resource work; it deliberately owns no active presentation state. */
export function createImagePresentationResourcePool(
  options: ImagePresentationResourcePoolOptions
): ImagePresentationResourcePool {
  const now = options.now ?? Date.now;
  const maxConcurrentLoads = options.maxConcurrentLoads ?? DEFAULT_MAX_CONCURRENT_LOADS;
  const maxPendingResolutions = options.maxPendingResolutions ?? DEFAULT_MAX_PENDING_RESOLUTIONS;
  const maxQueuedLoads = options.maxQueuedLoads ?? DEFAULT_MAX_QUEUED_LOADS;
  const failureRetryMs = options.failureRetryMs ?? DEFAULT_FAILURE_RETRY_MS;
  let disposed = false;
  let currentGeneration: ImageResourceGeneration | null = null;

  const createGeneration = (
    leases: readonly ImageResourceLease[] = []
  ): ImageResourceGeneration => {
    let settleReleased!: () => void;
    const releasedResult = new Promise<null>((resolve) => {
      settleReleased = () => resolve(null);
    });
    return {
      leases: new Set(leases),
      abortController: new AbortController(),
      releasedResult,
      settleReleased,
      resolvedCache: new Map(),
      resolutionInFlight: new Map(),
      loadedCache: new Map(),
      loadInFlight: new Map(),
      failedAt: new Map(),
      forcedReloads: new Set(),
      queue: [],
      activeLoads: 0,
      released: false
    };
  };

  const releaseGeneration = (
    generation: ImageResourceGeneration,
    releaseLeases: boolean
  ): void => {
    if (currentGeneration === generation) currentGeneration = null;
    if (releaseLeases) {
      for (const lease of generation.leases) lease.released = true;
    }
    generation.leases.clear();
    if (generation.released) return;
    generation.released = true;
    generation.abortController.abort();
    generation.settleReleased();
    while (generation.queue.length) generation.queue.shift()?.cancel();
    generation.resolutionInFlight.clear();
    generation.loadInFlight.clear();
    generation.resolvedCache.clear();
    generation.loadedCache.clear();
    generation.failedAt.clear();
    generation.forcedReloads.clear();
  };

  const startNext = (generation: ImageResourceGeneration): void => {
    if (generation.released || generation.activeLoads >= maxConcurrentLoads) return;
    generation.queue.shift()?.run();
  };

  const schedule = (
    generation: ImageResourceGeneration,
    load: () => Promise<HTMLImageElement | null>
  ): Promise<HTMLImageElement | null> => (
    new Promise((resolve) => {
      const item: QueuedLoad = {
        run() {
          if (generation.released) {
            resolve(null);
            return;
          }
          generation.activeLoads += 1;
          let work: Promise<HTMLImageElement | null>;
          try {
            work = load();
          } catch {
            work = Promise.resolve(null);
          }
          void work.then(resolve, () => resolve(null)).finally(() => {
            generation.activeLoads -= 1;
            startNext(generation);
          });
        },
        cancel: () => resolve(null)
      };
      if (generation.activeLoads < maxConcurrentLoads) item.run();
      else generation.queue.push(item);
    })
  );

  const resolve = (contextKey: string, rawSrc: string): Promise<string | null> => {
    const generation = currentGeneration;
    if (!generation || generation.released) return Promise.resolve(null);
    const key = cacheKey(contextKey, rawSrc);
    const cached = generation.resolvedCache.get(key);
    if (cached !== undefined) {
      touch(generation.resolvedCache, key, cached);
      return Promise.resolve(cached);
    }
    const pending = generation.resolutionInFlight.get(key);
    if (pending) return pending;
    if (generation.resolutionInFlight.size >= maxPendingResolutions) return Promise.resolve(null);
    let sourceResolution: Promise<string | null>;
    try {
      sourceResolution = options.resolveSource(
        contextKey,
        rawSrc,
        generation.abortController.signal
      ).catch(() => null);
    } catch {
      sourceResolution = Promise.resolve(null);
    }
    const resolution = Promise.race([sourceResolution, generation.releasedResult])
      .then((resolved) => {
        if (generation.released || currentGeneration !== generation) return null;
        if (resolved) {
          setBounded(
            generation.resolvedCache,
            key,
            resolved,
            options.resolutionCacheLimit ?? DEFAULT_RESOLUTION_CACHE_LIMIT
          );
        }
        return resolved || null;
      })
      .finally(() => generation.resolutionInFlight.delete(key));
    generation.resolutionInFlight.set(key, resolution);
    return resolution;
  };

  const load = (contextKey: string, resolvedSrc: string): Promise<HTMLImageElement | null> => {
    const generation = currentGeneration;
    if (!generation || generation.released) return Promise.resolve(null);
    const key = cacheKey(contextKey, resolvedSrc);
    const cached = generation.loadedCache.get(key);
    if (cached) {
      touch(generation.loadedCache, key, cached);
      return Promise.resolve(cached);
    }
    const failed = generation.failedAt.get(key);
    if (failed !== undefined) {
      if (now() - failed < failureRetryMs) return Promise.resolve(null);
      generation.failedAt.delete(key);
    }
    const pending = generation.loadInFlight.get(key);
    if (pending) return pending;
    if (generation.loadInFlight.size >= maxConcurrentLoads + maxQueuedLoads) {
      return Promise.resolve(null);
    }
    const forceReload = generation.forcedReloads.delete(key);
    const browserLoad = schedule(
      generation,
      () => options.loadImage(resolvedSrc, generation.abortController.signal, forceReload)
    );
    const loading = Promise.race([browserLoad, generation.releasedResult])
      .then((image) => {
        if (generation.released || currentGeneration !== generation) return null;
        if (image) {
          setBounded(
            generation.loadedCache,
            key,
            image,
            options.loadedCacheLimit ?? DEFAULT_LOADED_CACHE_LIMIT
          );
          generation.failedAt.delete(key);
        } else {
          setBounded(
            generation.failedAt,
            key,
            now(),
            options.failureCacheLimit ?? DEFAULT_FAILURE_CACHE_LIMIT
          );
        }
        return image;
      })
      .finally(() => generation.loadInFlight.delete(key));
    generation.loadInFlight.set(key, loading);
    return loading;
  };

  return {
    acquire() {
      if (disposed) return () => {};
      if (!currentGeneration) currentGeneration = createGeneration();
      const lease: ImageResourceLease = { released: false };
      currentGeneration.leases.add(lease);
      return () => {
        if (lease.released) return;
        lease.released = true;
        const generation = currentGeneration;
        if (!generation || !generation.leases.delete(lease)) return;
        if (generation.leases.size === 0) releaseGeneration(generation, false);
      };
    },
    invalidate() {
      const generation = currentGeneration;
      if (disposed || !generation) return;
      const activeLeases = [...generation.leases];
      releaseGeneration(generation, false);
      currentGeneration = createGeneration(activeLeases);
    },
    invalidateResource(contextKey, rawSrc, resolvedSrc) {
      const generation = currentGeneration;
      if (disposed || !generation || generation.released) return;
      const resolutionKey = cacheKey(contextKey, rawSrc);
      generation.resolvedCache.delete(resolutionKey);
      generation.resolutionInFlight.delete(resolutionKey);
      if (!resolvedSrc) return;
      const loadKey = cacheKey(contextKey, resolvedSrc);
      generation.loadedCache.delete(loadKey);
      generation.loadInFlight.delete(loadKey);
      generation.failedAt.delete(loadKey);
      generation.forcedReloads.add(loadKey);
    },
    resolve,
    getResolved(contextKey, rawSrc) {
      const generation = currentGeneration;
      if (!generation || generation.released) return null;
      const key = cacheKey(contextKey, rawSrc);
      const resolved = generation.resolvedCache.get(key) ?? null;
      if (resolved) touch(generation.resolvedCache, key, resolved);
      return resolved;
    },
    load,
    getLoaded(contextKey, resolvedSrc) {
      const generation = currentGeneration;
      if (!generation || generation.released) return null;
      const key = cacheKey(contextKey, resolvedSrc);
      const image = generation.loadedCache.get(key) ?? null;
      if (image) touch(generation.loadedCache, key, image);
      return image;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const generation = currentGeneration;
      if (generation) releaseGeneration(generation, true);
    }
  };
}

export type CodeMirrorDomImagePresentationAdapterOptions = {
  readonly resources: ImagePresentationResourcePool;
  readonly resourceContextKey: string;
  readonly view: ImagePresentationView;
};

/** Concrete Editor adapter for resource work and fallback/image DOM projection. */
export function createCodeMirrorDomImagePresentationAdapter(
  options: CodeMirrorDomImagePresentationAdapterOptions
): ImagePresentationEffectExecutor {
  let disposed = false;

  const completion = (work: Promise<ImagePresentationInput>): ImagePresentationEffectExecution => ({
    completion: work
  });

  const projectionCompletion = (
    effect: Extract<ImagePresentationEffect, { type: 'showImage' | 'showFallback' }>,
    type: 'projectionSucceeded' | 'projectionFailed'
  ): ImagePresentationEffectExecution => ({
    immediateCompletion: {
      type,
      presentationId: effect.presentationId,
      commandId: effect.commandId
    }
  });

  const project = (
    effect: Extract<ImagePresentationEffect, { type: 'showImage' | 'showFallback' }>,
    context: ImagePresentationEffectContext,
    apply: () => boolean
  ): ImagePresentationEffectExecution => {
    const result = options.view.preserveLayoutChange(() => (
      disposed || !context.isCurrentProjection() ? false : apply()
    ));
    const completed = (projected: boolean): ImagePresentationInput => ({
      type: projected ? 'projectionSucceeded' : 'projectionFailed',
      presentationId: effect.presentationId,
      commandId: effect.commandId
    });
    return result instanceof Promise
      ? completion(result.then(completed))
      : { immediateCompletion: completed(result) };
  };

  const showImage = (
    effect: Extract<ImagePresentationEffect, { type: 'showImage' }>,
    context: ImagePresentationEffectContext
  ): ImagePresentationEffectExecution => {
    const resolvedSrc = effect.resolvedSrc;
    const loaded = options.resources.getLoaded(options.resourceContextKey, resolvedSrc);
    if (!loaded) return projectionCompletion(effect, 'projectionFailed');
    const image = loaded.cloneNode(false) as HTMLImageElement;
    return project(effect, context, () => options.view.showImage(image));
  };

  return {
    execute(
      effect: ImagePresentationEffect,
      context: ImagePresentationEffectContext
    ): ImagePresentationEffectExecution {
      if (disposed) {
        switch (effect.type) {
          case 'resolveSource':
            return {
              immediateCompletion: { type: 'sourceFailed', presentationId: effect.presentationId }
            };
          case 'loadImage':
            return {
              immediateCompletion: { type: 'imageFailed', presentationId: effect.presentationId }
            };
          case 'showImage':
          case 'showFallback':
            return projectionCompletion(effect, 'projectionFailed');
        }
      }
      switch (effect.type) {
        case 'resolveSource': {
          const resolvedSrc = options.resources.getResolved(
            options.resourceContextKey,
            effect.rawSrc
          );
          if (resolvedSrc) {
            return {
              immediateCompletion: {
                type: 'sourceResolved',
                presentationId: effect.presentationId,
                resolvedSrc
              }
            };
          }
          return completion(
            options.resources.resolve(options.resourceContextKey, effect.rawSrc).then((resolvedSrc) => (
              resolvedSrc
                ? { type: 'sourceResolved', presentationId: effect.presentationId, resolvedSrc }
                : { type: 'sourceFailed', presentationId: effect.presentationId }
            ))
          );
        }
        case 'loadImage':
          if (options.resources.getLoaded(options.resourceContextKey, effect.resolvedSrc)) {
            return {
              immediateCompletion: {
                type: 'imageLoaded',
                presentationId: effect.presentationId
              }
            };
          }
          return completion(
            options.resources.load(options.resourceContextKey, effect.resolvedSrc).then((image) => (
              image
                ? { type: 'imageLoaded', presentationId: effect.presentationId }
                : { type: 'imageFailed', presentationId: effect.presentationId }
            ))
          );
        case 'showFallback':
          return project(effect, context, () => options.view.showFallback(effect.sourceKey));
        case 'showImage':
          return showImage(effect, context);
      }
    },
    dispose() {
      disposed = true;
    }
  };
}

export type ImagePresentationFactoryOptions = {
  readonly resources: ImagePresentationResourcePool;
  readonly resourceContextKey: string;
};

/** Creates one correlated presentation lifecycle per image widget. */
export function createImagePresentationFactory(
  options: ImagePresentationFactoryOptions
): ImagePresentationFactory {
  const handles = new Map<ImagePresentationHandle, {
    readonly view: ImagePresentationView;
    readonly runtime: ReturnType<typeof createImagePresentationRuntime>;
  }>();
  const releaseResourceLeases = new Set<() => void>();
  let disposed = false;

  const create = (view: ImagePresentationView): ImagePresentationHandle => {
    if (disposed) throw new Error('Image presentation factory is disposed');
    const application = createImagePresentationApplication();
    const executor = createCodeMirrorDomImagePresentationAdapter({
      resources: options.resources,
      resourceContextKey: options.resourceContextKey,
      view
    });
    const runtime = createImagePresentationRuntime({ application, executor });
    let active = true;
    const handle: ImagePresentationHandle = {
      present(sourceKey, rawSrc) {
        if (active) runtime.dispatch({ type: 'present', sourceKey, rawSrc });
      },
      async refresh() {
        if (!active) return;
        const before = application.getState().current;
        if (!before || before.phase !== 'ready') return;
        options.resources.invalidateResource(
          options.resourceContextKey,
          before.rawSrc,
          before.resolvedSrc
        );
        const resolved = await options.resources.resolve(
          options.resourceContextKey,
          before.rawSrc
        );
        if (!resolved || !active) return;
        const loaded = await options.resources.load(options.resourceContextKey, resolved);
        const current = application.getState().current;
        if (
          !loaded ||
          !active ||
          current?.presentationId !== before.presentationId ||
          current.sourceKey !== before.sourceKey ||
          current.rawSrc !== before.rawSrc
        ) return;
        runtime.dispatch({
          type: 'present',
          sourceKey: before.sourceKey,
          rawSrc: before.rawSrc
        });
        await runtime.whenCurrentPresentationSettles();
      },
      externalDocumentPresented() {
        if (active) runtime.dispatch({ type: 'externalDocumentPresented' });
      },
      whenCurrentPresentationSettles: (signal) => runtime.whenCurrentPresentationSettles(signal),
      dispose() {
        if (!active) return;
        active = false;
        handles.delete(handle);
        runtime.dispose();
      }
    };
    handles.set(handle, { view, runtime });
    return handle;
  };

  return {
    acquire() {
      if (disposed) return () => {};
      const releasePoolLease = options.resources.acquire();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        releaseResourceLeases.delete(release);
        releasePoolLease();
      };
      releaseResourceLeases.add(release);
      return release;
    },
    async preload(rawSrc) {
      if (disposed) return;
      const resolved = await options.resources.resolve(options.resourceContextKey, rawSrc);
      if (!resolved || disposed) return;
      await options.resources.load(options.resourceContextKey, resolved);
    },
    create,
    async whenVisiblePresentationsSettle(signal) {
      if (disposed) return;
      const pending = [...handles.values()]
        .filter(({ view }) => view.isVisible?.() !== false)
        .map(({ runtime }) => runtime.whenCurrentPresentationSettles(signal));
      await Promise.all(pending);
    },
    externalDocumentPresented() {
      if (disposed) return;
      options.resources.invalidate();
      for (const handle of handles.keys()) handle.externalDocumentPresented();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const handle of [...handles.keys()]) handle.dispose();
      handles.clear();
      for (const release of [...releaseResourceLeases]) release();
      releaseResourceLeases.clear();
    }
  };
}

let imageReloadSequence = 0;

function cacheBustedImageSource(resolvedSrc: string): string {
  if (/^(?:data:|blob:)/i.test(resolvedSrc)) return resolvedSrc;
  const hashAt = resolvedSrc.indexOf('#');
  const base = hashAt >= 0 ? resolvedSrc.slice(0, hashAt) : resolvedSrc;
  const hash = hashAt >= 0 ? resolvedSrc.slice(hashAt) : '';
  const separator = base.includes('?') ? '&' : '?';
  imageReloadSequence += 1;
  return `${base}${separator}meoReload=${imageReloadSequence}${hash}`;
}

export function loadBrowserImage(
  resolvedSrc: string,
  signal?: AbortSignal,
  forceReload = false
): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;

    function complete(value: HTMLImageElement | null): void {
      if (settled) return;
      settled = true;
      image.removeEventListener('load', onLoad);
      image.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    }
    function onLoad(): void {
      complete(image);
    }
    function onError(): void {
      complete(null);
    }
    function onAbort(): void {
      image.removeEventListener('load', onLoad);
      image.removeEventListener('error', onError);
      try {
        image.src = '';
      } finally {
        complete(null);
      }
    }

    if (signal?.aborted) {
      complete(null);
      return;
    }
    image.addEventListener('load', onLoad, { once: true });
    image.addEventListener('error', onError, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    image.src = forceReload ? cacheBustedImageSource(resolvedSrc) : resolvedSrc;
    if (image.complete && image.naturalWidth > 0) complete(image);
  });
}
