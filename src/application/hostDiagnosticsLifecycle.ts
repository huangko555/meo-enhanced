export type HostDiagnosticsRuntime<TDiagnostic> = {
  computeInternal(enabled: boolean): Promise<readonly TDiagnostic[]>;
  hasExternal(): boolean;
  replaceInternal(diagnostics: readonly TDiagnostic[]): void;
  clearInternal(): void;
};

export type HostDiagnosticsTimer = {
  schedule(delayMs: number, run: () => void): { cancel(): void };
};

export type HostDiagnosticsLifecycle = {
  requestRefresh(delayMs?: number): void;
  handleDiagnosticsChanged(): Promise<void>;
  dispose(): void;
};

export type HostDiagnosticsLifecycleDependencies<TDiagnostic> = {
  readonly runtime: HostDiagnosticsRuntime<TDiagnostic>;
  readonly timer: HostDiagnosticsTimer;
  readonly readEnabled: () => boolean;
  readonly publishCombined: () => Promise<void>;
  readonly reportFailure: (error: unknown) => void;
  readonly defaultDelayMs?: number;
};

/** Owns Host diagnostics scheduling and precedence; concrete diagnostics remain in the runtime Adapter. */
export function createHostDiagnosticsLifecycle<TDiagnostic>(
  dependencies: HostDiagnosticsLifecycleDependencies<TDiagnostic>
): HostDiagnosticsLifecycle {
  let generation = 0;
  let scheduled: { cancel(): void } | null = null;
  let disposed = false;

  const run = async (targetGeneration: number): Promise<void> => {
    try {
      const diagnostics = await dependencies.runtime.computeInternal(dependencies.readEnabled());
      if (disposed || targetGeneration !== generation) return;
      dependencies.runtime.replaceInternal(diagnostics);
    } catch (error) {
      if (disposed || targetGeneration !== generation) return;
      dependencies.reportFailure(error);
      dependencies.runtime.clearInternal();
    }
  };

  return {
    requestRefresh(delayMs = dependencies.defaultDelayMs ?? 350) {
      if (disposed) return;
      generation += 1;
      const targetGeneration = generation;
      scheduled?.cancel();
      scheduled = dependencies.timer.schedule(Math.max(0, delayMs), () => {
        if (targetGeneration === generation) scheduled = null;
        void run(targetGeneration);
      });
    },
    async handleDiagnosticsChanged() {
      if (disposed) return;
      if (dependencies.runtime.hasExternal()) {
        generation += 1;
        scheduled?.cancel();
        scheduled = null;
        dependencies.runtime.clearInternal();
      }
      await dependencies.publishCombined();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      scheduled?.cancel();
      scheduled = null;
      dependencies.runtime.clearInternal();
    }
  };
}
