export type ReadingPosition = {
  readonly line: number;
  readonly lineOffset: number;
};

type ReadingPositionTimer = {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
};

type ReadingPositionLifecycleDependencies = {
  readonly timer: ReadingPositionTimer;
  readonly capture: () => ReadingPosition | null;
  readonly restore: (position: ReadingPosition) => boolean;
  readonly post: (position: ReadingPosition) => void;
  readonly debounceMs?: number;
};

export type ReadingPositionLifecycle = {
  start(input: { readonly enabled: boolean; readonly restore: ReadingPosition | null }): void;
  setEnabled(enabled: boolean): void;
  surfaceReady(): boolean;
  viewportChanged(): void;
  userInteracted(): void;
  explicitNavigation(): void;
  flush(): void;
  dispose(): void;
};

const DEFAULT_DEBOUNCE_MS = 1_200;

const positionKey = (position: ReadingPosition): string => (
  `${position.line}:${position.lineOffset}`
);

/** Owns one Webview's pending restore and idle-only position reporting. */
export function createReadingPositionLifecycle(
  dependencies: ReadingPositionLifecycleDependencies
): ReadingPositionLifecycle {
  let initialized = false;
  let enabled = true;
  let disposed = false;
  let pendingRestore: ReadingPosition | null = null;
  let pendingCapture: unknown = null;
  let lastPostedKey: string | null = null;

  const cancelCapture = (): void => {
    if (pendingCapture === null) return;
    dependencies.timer.cancel(pendingCapture);
    pendingCapture = null;
  };

  const postCurrent = (): void => {
    if (disposed || !initialized || !enabled || pendingRestore) return;
    const position = dependencies.capture();
    if (!position) return;
    const key = positionKey(position);
    if (key === lastPostedKey) return;
    lastPostedKey = key;
    dependencies.post(position);
  };

  const cancelRestore = (): void => {
    pendingRestore = null;
  };

  return {
    start(input) {
      if (disposed) return;
      initialized = true;
      enabled = input.enabled;
      pendingRestore = enabled ? input.restore : null;
      lastPostedKey = null;
      cancelCapture();
    },
    setEnabled(nextEnabled) {
      if (disposed) return;
      const changed = enabled !== nextEnabled;
      enabled = nextEnabled;
      if (!enabled) {
        cancelRestore();
        cancelCapture();
      } else if (changed) {
        lastPostedKey = null;
      }
    },
    surfaceReady() {
      if (disposed || !initialized || !enabled || !pendingRestore) return false;
      const restored = dependencies.restore(pendingRestore);
      if (restored) pendingRestore = null;
      return restored;
    },
    viewportChanged() {
      if (disposed || !initialized || !enabled || pendingRestore) return;
      cancelCapture();
      pendingCapture = dependencies.timer.schedule(() => {
        pendingCapture = null;
        postCurrent();
      }, dependencies.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    },
    userInteracted() {
      if (disposed) return;
      cancelRestore();
    },
    explicitNavigation() {
      if (disposed) return;
      cancelRestore();
    },
    flush() {
      cancelCapture();
      postCurrent();
    },
    dispose() {
      if (disposed) return;
      cancelCapture();
      pendingRestore = null;
      disposed = true;
    }
  };
}
