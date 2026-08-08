import type { GitBaselineRefreshTimer } from '../application/gitBaselineRefreshCoordinator';

/** Connects Git baseline refresh scheduling to the Host timer runtime. */
export function createGitBaselineRefreshTimerAdapter(): GitBaselineRefreshTimer {
  return {
    schedule(delayMs, run) {
      const timer = setTimeout(run, delayMs);
      return { cancel: () => clearTimeout(timer) };
    }
  };
}
