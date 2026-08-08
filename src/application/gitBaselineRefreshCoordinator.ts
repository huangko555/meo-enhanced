export type GitBaselineRefreshOptions = {
  readonly forcePost?: boolean;
  readonly forceReload?: boolean;
  readonly delayMs?: number;
};

type GitBaselinePublishOptions = {
  readonly forcePost: boolean;
  readonly forceReload: boolean;
};

export type GitBaselineRefreshTimer = {
  schedule(delayMs: number, run: () => void): { cancel(): void };
};

export type GitBaselineRefreshCoordinator = {
  request(options?: GitBaselineRefreshOptions): void;
  dispose(): void;
};

export type GitBaselineRefreshDependencies = {
  readonly timer: GitBaselineRefreshTimer;
  readonly canRun: () => boolean;
  readonly invalidateGitHead: () => void;
  readonly prepare: () => Promise<boolean>;
  readonly publish: (options: GitBaselinePublishOptions) => Promise<void>;
};

/** Owns refresh coalescing and lifecycle, but never chooses the baseline source. */
export function createGitBaselineRefreshCoordinator(
  dependencies: GitBaselineRefreshDependencies
): GitBaselineRefreshCoordinator {
  let running = false;
  let pending = false;
  let pendingForcePost = false;
  let pendingForceReload = false;
  let scheduled: { cancel(): void } | null = null;
  let disposed = false;

  const run = async (): Promise<void> => {
    scheduled?.cancel();
    scheduled = null;
    if (disposed || running || !dependencies.canRun()) return;

    running = true;
    try {
      while (pending && !disposed) {
        const nextOptions = {
          forcePost: pendingForcePost,
          forceReload: pendingForceReload
        };
        pending = false;
        pendingForcePost = false;
        pendingForceReload = false;
        try {
          if (!await dependencies.prepare()) {
            pending = true;
            pendingForcePost ||= nextOptions.forcePost;
            pendingForceReload ||= nextOptions.forceReload;
            return;
          }
          if (!disposed) await dependencies.publish(nextOptions);
        } catch {
          // A transient Git, Init, or post failure must not kill later refreshes.
        }
      }
    } finally {
      running = false;
      if (pending && !disposed && dependencies.canRun()) void run();
    }
  };

  return {
    request(options = {}) {
      if (disposed) return;
      if (options.forceReload) dependencies.invalidateGitHead();
      pending = true;
      pendingForcePost ||= options.forcePost === true;
      pendingForceReload ||= options.forceReload === true;

      const delayMs = Math.max(0, options.delayMs ?? 0);
      if (delayMs > 0 && !running) {
        scheduled?.cancel();
        scheduled = dependencies.timer.schedule(delayMs, () => { void run(); });
        return;
      }
      void run();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pending = false;
      pendingForcePost = false;
      pendingForceReload = false;
      scheduled?.cancel();
      scheduled = null;
    }
  };
}
