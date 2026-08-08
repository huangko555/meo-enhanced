import type { SavedRevisionRefreshTimer } from '../application/savedRevisionLifecycle';

/** Connects Saved Revision watcher refreshes to the Host timer runtime. */
export function createSavedRevisionRefreshTimerAdapter(): SavedRevisionRefreshTimer {
  return {
    schedule(delayMs, run) {
      const timer = setTimeout(run, delayMs);
      return { cancel: () => clearTimeout(timer) };
    }
  };
}
