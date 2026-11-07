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
  readonly previousUnavailableReason: SavedRevisionUnavailableReason | null;
  readonly recoveredFromUnavailable: boolean;
};

export type SavedRevisionAssociation = {
  readonly text: string;
  readonly version: number | null;
};

export type SavedRevisionExpectedDocument = {
  readonly version: number;
  readonly text: string;
};

export type SavedRevisionReadBackResult =
  | { readonly ok: true; readonly text: string }
  // The native save completed, but this document is deliberately outside the
  // bounded Saved Revision comparison budget.
  | { readonly ok: true; readonly text: null }
  | { readonly ok: false; readonly reason: 'save-rejected' | 'read-failed' | 'text-mismatch' };

export type SavedRevisionLifecycle = {
  readInitial(): Promise<SavedRevisionAssociation | null>;
  refreshNow(): Promise<void>;
  scheduleRefresh(delayMs?: number): void;
  saveAndReadBack(expected: SavedRevisionExpectedDocument): Promise<SavedRevisionReadBackResult>;
  markUnavailable(reason: SavedRevisionUnavailableReason): Promise<void>;
  getUnavailableReason(): SavedRevisionUnavailableReason | null;
  dispose(): void;
};

export type SavedRevisionLifecycleDependencies = {
  readonly file: SavedRevisionFileAdapter;
  readonly timer: SavedRevisionRefreshTimer;
  readonly readDocumentRevision: () => { readonly version: number; readonly text: string };
  readonly readDocumentVersion: () => number;
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

  const readWithRecovery = async (): Promise<SavedRevisionFileReadResult> => {
    const result = await dependencies.file.read();
    return result.ok || result.reason !== 'error' ? result : dependencies.file.read();
  };

  const runRefreshes = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (refreshRunning) return refreshRunning;
    const running = (async () => {
      while (refreshPending && !disposed) {
        refreshPending = false;
        const readGeneration = generation;
        const result = await readWithRecovery();
        if (disposed) return;
        if (readGeneration !== generation) continue;
        const previousUnavailableReason = unavailableReason;
        const recoveredFromUnavailable = noteResult(result);
        await dependencies.onRefresh({ result, previousUnavailableReason, recoveredFromUnavailable });
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
      const result = await readWithRecovery();
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
    async saveAndReadBack(expected) {
      if (disposed || !await dependencies.saveDocument()) {
        return { ok: false, reason: 'save-rejected' };
      }
      // TextDocument.version is the authoritative, constant-size snapshot for
      // changes made by formatters or other will-save participants. The caller
      // already matched this revision immediately before requesting the save.
      if (dependencies.readDocumentVersion() !== expected.version) {
        return { ok: false, reason: 'text-mismatch' };
      }
      generation += 1;
      const result = await readWithRecovery();
      if (disposed) return { ok: false, reason: 'read-failed' };
      noteResult(result);
      // A successful TextDocument.save is the persistence acknowledgement.
      // Saved Revision is only an optional, bounded comparison baseline.
      if (!result.ok && result.reason === 'too-large') return { ok: true, text: null };
      if (!result.ok) return { ok: false, reason: 'read-failed' };
      if (normalizeLineEndings(result.text) !== expected.text) {
        return { ok: false, reason: 'text-mismatch' };
      }
      return { ok: true, text: result.text };
    },
    async markUnavailable(reason) {
      if (disposed) return;
      generation += 1;
      const previousUnavailableReason = unavailableReason;
      unavailableReason = reason;
      await dependencies.onRefresh({
        result: { ok: false, reason },
        previousUnavailableReason,
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
