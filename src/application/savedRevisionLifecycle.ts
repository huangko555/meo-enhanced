export type SavedRevisionUnavailableReason = 'not-file' | 'too-large' | 'binary' | 'error';

export type SavedRevisionFileReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: SavedRevisionUnavailableReason };

export type SavedRevisionFileAdapter = {
  read(): Promise<SavedRevisionFileReadResult>;
};

export type SavedRevisionRefreshTimer = {
  schedule(delayMs: number, run: () => void): { cancel(): void };
};

export type SavedRevisionRefreshObservation = {
  readonly result: SavedRevisionFileReadResult;
  readonly recoveredFromUnavailable: boolean;
};

export type SavedRevisionAssociation = {
  readonly text: string;
  readonly version: number | null;
};

export type SavedRevisionReadBackResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: 'save-rejected' | 'read-failed' | 'text-mismatch' };

export type SavedRevisionLifecycle = {
  readInitial(): Promise<SavedRevisionAssociation | null>;
  refreshNow(): Promise<void>;
  scheduleRefresh(delayMs?: number): void;
  saveAndReadBack(expectedText: string): Promise<SavedRevisionReadBackResult>;
  markUnavailable(reason: SavedRevisionUnavailableReason): Promise<void>;
  getUnavailableReason(): SavedRevisionUnavailableReason | null;
  dispose(): void;
};

export type SavedRevisionLifecycleDependencies = {
  readonly file: SavedRevisionFileAdapter;
  readonly timer: SavedRevisionRefreshTimer;
  readonly readDocumentRevision: () => { readonly version: number; readonly text: string };
  readonly saveDocument: () => Promise<boolean>;
  readonly onRefresh: (observation: SavedRevisionRefreshObservation) => Promise<void>;
  readonly defaultRefreshDelayMs?: number;
};

const normalizeLineEndings = (text: string): string => text.replace(/\r\n/g, '\n');

/** Owns Saved Revision read lifecycle; history and comparison projections remain outside. */
export function createSavedRevisionLifecycle(
  dependencies: SavedRevisionLifecycleDependencies
): SavedRevisionLifecycle {
  let unavailableReason: SavedRevisionUnavailableReason | null = null;
  let generation = 0;
  let refreshPending = false;
  let refreshRunning: Promise<void> | null = null;
  let scheduled: { cancel(): void } | null = null;
  let disposed = false;

  const noteResult = (result: SavedRevisionFileReadResult): boolean => {
    const recoveredFromUnavailable = unavailableReason !== null && result.ok;
    unavailableReason = result.ok ? null : result.reason;
    return recoveredFromUnavailable;
  };

  const runRefreshes = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (refreshRunning) return refreshRunning;
    const running = (async () => {
      while (refreshPending && !disposed) {
        refreshPending = false;
        const readGeneration = generation;
        const result = await dependencies.file.read();
        if (disposed) return;
        if (readGeneration !== generation) continue;
        const recoveredFromUnavailable = noteResult(result);
        await dependencies.onRefresh({ result, recoveredFromUnavailable });
      }
    })().finally(() => {
      if (refreshRunning === running) refreshRunning = null;
      if (refreshPending && !disposed) void runRefreshes();
    });
    refreshRunning = running;
    return running;
  };

  const refreshNow = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    generation += 1;
    refreshPending = true;
    return runRefreshes();
  };

  return {
    async readInitial() {
      const result = await dependencies.file.read();
      if (disposed) return null;
      noteResult(result);
      if (!result.ok) return null;
      const current = dependencies.readDocumentRevision();
      return {
        text: result.text,
        version: result.text === current.text ? current.version : null
      };
    },
    refreshNow,
    scheduleRefresh(delayMs = dependencies.defaultRefreshDelayMs ?? 150) {
      if (disposed) return;
      generation += 1;
      scheduled?.cancel();
      scheduled = dependencies.timer.schedule(Math.max(0, delayMs), () => {
        scheduled = null;
        void refreshNow();
      });
    },
    async saveAndReadBack(expectedText) {
      if (disposed || !await dependencies.saveDocument()) {
        return { ok: false, reason: 'save-rejected' };
      }
      generation += 1;
      const result = await dependencies.file.read();
      if (disposed) return { ok: false, reason: 'read-failed' };
      noteResult(result);
      if (!result.ok) return { ok: false, reason: 'read-failed' };
      if (normalizeLineEndings(result.text) !== expectedText) {
        return { ok: false, reason: 'text-mismatch' };
      }
      return { ok: true, text: result.text };
    },
    async markUnavailable(reason) {
      if (disposed) return;
      generation += 1;
      unavailableReason = reason;
      await dependencies.onRefresh({
        result: { ok: false, reason },
        recoveredFromUnavailable: false
      });
    },
    getUnavailableReason() {
      return unavailableReason;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      refreshPending = false;
      scheduled?.cancel();
      scheduled = null;
    }
  };
}
