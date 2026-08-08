import type { HostDiagnosticsTimer } from '../application/hostDiagnosticsLifecycle';

/** Connects Host diagnostics debounce requests to the extension timer runtime. */
export function createHostDiagnosticsTimerAdapter(): HostDiagnosticsTimer {
  return {
    schedule(delayMs, run) {
      const timer = setTimeout(run, delayMs);
      return { cancel: () => clearTimeout(timer) };
    }
  };
}
