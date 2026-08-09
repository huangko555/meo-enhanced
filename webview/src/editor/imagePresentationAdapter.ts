import type {
  ImagePresentationEffect,
  ImagePresentationEffectExecution,
  ImagePresentationEffectExecutor,
  ImagePresentationInput
} from '../application/imagePresentation';

const DEFAULT_RESOLUTION_CACHE_LIMIT = 512;
const DEFAULT_LOADED_CACHE_LIMIT = 128;
const DEFAULT_FAILURE_CACHE_LIMIT = 256;
const DEFAULT_MAX_CONCURRENT_LOADS = 6;
const DEFAULT_FAILURE_RETRY_MS = 30_000;

export type ImagePresentationResourcePool = {
  resolve(contextKey: string, rawSrc: string): Promise<string | null>;
  load(contextKey: string, resolvedSrc: string): Promise<HTMLImageElement | null>;
  getLoaded(contextKey: string, resolvedSrc: string): HTMLImageElement | null;
  dispose(): void;
};

export type ImagePresentationResourcePoolOptions = {
  readonly resolveSource: (contextKey: string, rawSrc: string) => Promise<string | null>;
  readonly loadImage: (resolvedSrc: string) => Promise<HTMLImageElement | null>;
  readonly now?: () => number;
  readonly maxConcurrentLoads?: number;
  readonly failureRetryMs?: number;
  readonly resolutionCacheLimit?: number;
  readonly loadedCacheLimit?: number;
  readonly failureCacheLimit?: number;
};

type QueuedLoad = {
  readonly run: () => void;
  readonly cancel: () => void;
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
  const failureRetryMs = options.failureRetryMs ?? DEFAULT_FAILURE_RETRY_MS;
  const resolvedCache = new Map<string, string>();
  const resolutionInFlight = new Map<string, Promise<string | null>>();
  const loadedCache = new Map<string, HTMLImageElement>();
  const loadInFlight = new Map<string, Promise<HTMLImageElement | null>>();
  const failedAt = new Map<string, number>();
  const queue: QueuedLoad[] = [];
  let activeLoads = 0;
  let disposed = false;

  const startNext = (): void => {
    if (disposed || activeLoads >= maxConcurrentLoads) return;
    queue.shift()?.run();
  };

  const schedule = (load: () => Promise<HTMLImageElement | null>): Promise<HTMLImageElement | null> => (
    new Promise((resolve) => {
      const item: QueuedLoad = {
        run() {
          if (disposed) {
            resolve(null);
            return;
          }
          activeLoads += 1;
          void load().then(resolve, () => resolve(null)).finally(() => {
            activeLoads -= 1;
            startNext();
          });
        },
        cancel: () => resolve(null)
      };
      if (activeLoads < maxConcurrentLoads) item.run();
      else queue.push(item);
    })
  );

  const resolve = (contextKey: string, rawSrc: string): Promise<string | null> => {
    if (disposed) return Promise.resolve(null);
    const key = cacheKey(contextKey, rawSrc);
    const cached = resolvedCache.get(key);
    if (cached !== undefined) {
      touch(resolvedCache, key, cached);
      return Promise.resolve(cached);
    }
    const pending = resolutionInFlight.get(key);
    if (pending) return pending;
    const resolution = options.resolveSource(contextKey, rawSrc)
      .then((resolved) => {
        if (disposed) return null;
        if (resolved) {
          setBounded(
            resolvedCache,
            key,
            resolved,
            options.resolutionCacheLimit ?? DEFAULT_RESOLUTION_CACHE_LIMIT
          );
        }
        return resolved || null;
      }, () => null)
      .finally(() => resolutionInFlight.delete(key));
    resolutionInFlight.set(key, resolution);
    return resolution;
  };

  const load = (contextKey: string, resolvedSrc: string): Promise<HTMLImageElement | null> => {
    if (disposed) return Promise.resolve(null);
    const key = cacheKey(contextKey, resolvedSrc);
    const cached = loadedCache.get(key);
    if (cached) {
      touch(loadedCache, key, cached);
      return Promise.resolve(cached);
    }
    const failed = failedAt.get(key);
    if (failed !== undefined) {
      if (now() - failed < failureRetryMs) return Promise.resolve(null);
      failedAt.delete(key);
    }
    const pending = loadInFlight.get(key);
    if (pending) return pending;
    const loading = schedule(() => options.loadImage(resolvedSrc))
      .then((image) => {
        if (disposed) return null;
        if (image) {
          setBounded(
            loadedCache,
            key,
            image,
            options.loadedCacheLimit ?? DEFAULT_LOADED_CACHE_LIMIT
          );
          failedAt.delete(key);
        } else {
          setBounded(
            failedAt,
            key,
            now(),
            options.failureCacheLimit ?? DEFAULT_FAILURE_CACHE_LIMIT
          );
        }
        return image;
      })
      .finally(() => loadInFlight.delete(key));
    loadInFlight.set(key, loading);
    return loading;
  };

  return {
    resolve,
    load,
    getLoaded(contextKey, resolvedSrc) {
      const key = cacheKey(contextKey, resolvedSrc);
      const image = loadedCache.get(key) ?? null;
      if (image) touch(loadedCache, key, image);
      return image;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      while (queue.length) queue.shift()?.cancel();
      resolutionInFlight.clear();
      loadInFlight.clear();
      resolvedCache.clear();
      loadedCache.clear();
      failedAt.clear();
    }
  };
}

export type CodeMirrorDomImagePresentationAdapterOptions = {
  readonly resources: ImagePresentationResourcePool;
  readonly resourceContextKey: string;
  readonly root: HTMLElement;
  readonly altText: string;
  readonly preserveLayoutChange: (apply: () => void) => void;
};

/** Concrete Editor adapter for resource work and fallback/image DOM projection. */
export function createCodeMirrorDomImagePresentationAdapter(
  options: CodeMirrorDomImagePresentationAdapterOptions
): ImagePresentationEffectExecutor {
  let cancelledThrough = 0;
  let disposed = false;

  const accepts = (presentationId: number): boolean => !disposed && presentationId > cancelledThrough;
  const completion = (
    presentationId: number,
    work: Promise<ImagePresentationInput | null>
  ): ImagePresentationEffectExecution => ({
    completion: work.then((input) => accepts(presentationId) ? input : null)
  });

  const showFallback = (sourceKey: string): void => {
    const fallback = options.root.ownerDocument.createElement('code');
    fallback.className = 'meo-md-image-fallback-text';
    fallback.textContent = sourceKey;
    options.root.classList.add('meo-md-image-fallback');
    options.root.replaceChildren(fallback);
  };

  const showImage = (resolvedSrc: string): void => {
    const loaded = options.resources.getLoaded(options.resourceContextKey, resolvedSrc);
    if (!loaded) return;
    const image = loaded.cloneNode(false) as HTMLImageElement;
    image.className = 'meo-md-image-img';
    image.alt = options.altText;
    image.loading = 'eager';
    options.preserveLayoutChange(() => {
      if (disposed) return;
      options.root.classList.remove('meo-md-image-fallback');
      options.root.replaceChildren(image);
    });
  };

  return {
    execute(effect: ImagePresentationEffect): ImagePresentationEffectExecution {
      if (disposed) return {};
      switch (effect.type) {
        case 'resolveSource':
          return completion(
            effect.presentationId,
            options.resources.resolve(options.resourceContextKey, effect.rawSrc).then((resolvedSrc) => (
              resolvedSrc
                ? { type: 'sourceResolved', presentationId: effect.presentationId, resolvedSrc }
                : { type: 'sourceFailed', presentationId: effect.presentationId }
            ))
          );
        case 'loadImage':
          return completion(
            effect.presentationId,
            options.resources.load(options.resourceContextKey, effect.resolvedSrc).then((image) => (
              image
                ? { type: 'imageLoaded', presentationId: effect.presentationId }
                : { type: 'imageFailed', presentationId: effect.presentationId }
            ))
          );
        case 'showFallback':
          if (accepts(effect.presentationId)) showFallback(effect.sourceKey);
          return {};
        case 'showImage':
          if (accepts(effect.presentationId)) showImage(effect.resolvedSrc);
          return {};
        case 'cancelPresentation':
          cancelledThrough = Math.max(cancelledThrough, effect.presentationId);
          return {};
      }
    },
    dispose() {
      disposed = true;
    }
  };
}

export function loadBrowserImage(resolvedSrc: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const complete = (value: HTMLImageElement | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    image.addEventListener('load', () => complete(image), { once: true });
    image.addEventListener('error', () => complete(null), { once: true });
    image.src = resolvedSrc;
    if (image.complete && image.naturalWidth > 0) complete(image);
  });
}
