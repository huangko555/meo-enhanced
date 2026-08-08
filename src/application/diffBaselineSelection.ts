export type DiffBaselineMode = 'current-edit' | 'recent-save' | 'git-head';

export type DiffBaselineUnavailableReason =
  | 'not-file'
  | 'git-unavailable'
  | 'not-repo'
  | 'ignored'
  | 'too-large'
  | 'binary'
  | 'error'
  | 'no-baseline';

export type DiffBaselineSelection<TGitProjection> =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'fixed'; readonly text: string }
  | { readonly kind: 'saved'; readonly mode: 'current-edit' | 'recent-save'; readonly text: string }
  | {
      readonly kind: 'unavailable';
      readonly mode: 'current-edit' | 'recent-save';
      readonly reason: DiffBaselineUnavailableReason;
    }
  | { readonly kind: 'git-head'; readonly value: TGitProjection };

export type DiffBaselineRefreshRequest = {
  readonly forcePost?: boolean;
  readonly forceReload?: boolean;
  readonly delayMs?: number;
};

export type DiffBaselinePublishOptions = {
  readonly forcePost?: boolean;
  readonly forceReload?: boolean;
};

export type DiffBaselineSelectionState = {
  readonly mode: DiffBaselineMode;
  readonly fixedPinned: boolean;
  readonly fixedActive: boolean;
};

export type DiffBaselineSelectionModule<TGitProjection> = {
  getState(): DiffBaselineSelectionState;
  requestRefresh(options?: DiffBaselineRefreshRequest): void;
  savedRevisionChanged(): void;
  setMode(mode: DiffBaselineMode): Promise<void>;
  setFixed(enabled: boolean): Promise<void>;
  releaseFixed(): Promise<void>;
  publish(options?: DiffBaselinePublishOptions): Promise<boolean>;
  dispose(): void;
};

export type DiffBaselineOutput<TGitProjection> = {
  hash(selection: DiffBaselineSelection<TGitProjection>): string;
  publish(selection: DiffBaselineSelection<TGitProjection>, generation: number): Promise<boolean>;
  publishFixedState(state: { readonly pinned: boolean; readonly active: boolean }): Promise<void>;
};

export type DiffBaselineSelectionDependencies<TGitProjection> = {
  readonly initialMode: DiffBaselineMode;
  readonly readEnabled: () => boolean;
  readonly canPublish: () => boolean;
  readonly saved: {
    getPinned(): { readonly text: string } | null;
    pinLatest(): Promise<{ readonly text: string } | null>;
    releasePinned(): void;
    resolve(mode: 'current-edit' | 'recent-save'): Promise<
      | { readonly ok: true; readonly text: string }
      | { readonly ok: false; readonly reason: DiffBaselineUnavailableReason }
    >;
  };
  readonly git: {
    resolve(forceReload: boolean): Promise<TGitProjection>;
  };
  readonly output: DiffBaselineOutput<TGitProjection>;
  readonly persistMode: (mode: DiffBaselineMode) => Promise<void>;
  readonly warnNoSavedRevision: () => void;
  readonly requestRefresh: (options: DiffBaselineRefreshRequest) => void;
};

/** Owns comparison-source selection and publication, never the source lifecycles themselves. */
export function createDiffBaselineSelection<TGitProjection>(
  dependencies: DiffBaselineSelectionDependencies<TGitProjection>
): DiffBaselineSelectionModule<TGitProjection> {
  let mode = dependencies.initialMode;
  let fixedSelected = false;
  let lastPublishedHash = '';
  let outputGeneration = 0;
  let selectionGeneration = 0;
  let publishRequestGeneration = 0;
  let transitionGeneration = 0;
  let disposed = false;

  const getState = (): DiffBaselineSelectionState => {
    const fixedPinned = dependencies.saved.getPinned() !== null;
    return { mode, fixedPinned, fixedActive: fixedSelected && fixedPinned };
  };

  const requestRefresh = (options: DiffBaselineRefreshRequest = {}): void => {
    if (!disposed) dependencies.requestRefresh(options);
  };

  const invalidateSelection = (): void => {
    selectionGeneration += 1;
    lastPublishedHash = '';
  };

  return {
    getState,
    requestRefresh,
    savedRevisionChanged() {
      if (!disposed && mode !== 'git-head') requestRefresh({ forcePost: true });
    },
    async setMode(nextMode) {
      if (disposed) return;
      const transition = ++transitionGeneration;
      mode = nextMode;
      fixedSelected = false;
      invalidateSelection();
      await dependencies.output.publishFixedState({
        pinned: dependencies.saved.getPinned() !== null,
        active: false
      });
      if (disposed || transition !== transitionGeneration) return;
      await dependencies.persistMode(nextMode);
      if (disposed || transition !== transitionGeneration) return;
      requestRefresh({ forcePost: true, forceReload: nextMode === 'git-head' });
    },
    async setFixed(enabled) {
      if (disposed) return;
      const transition = ++transitionGeneration;
      if (enabled) {
        let pinned = dependencies.saved.getPinned();
        if (!pinned) pinned = await dependencies.saved.pinLatest();
        if (disposed || transition !== transitionGeneration) return;
        if (!pinned) {
          fixedSelected = false;
          invalidateSelection();
          await dependencies.output.publishFixedState({ pinned: false, active: false });
          if (!disposed && transition === transitionGeneration) dependencies.warnNoSavedRevision();
          return;
        }
        fixedSelected = true;
        invalidateSelection();
        await dependencies.output.publishFixedState({ pinned: true, active: true });
        if (!disposed && transition === transitionGeneration) requestRefresh({ forcePost: true });
        return;
      }

      fixedSelected = false;
      invalidateSelection();
      await dependencies.output.publishFixedState({
        pinned: dependencies.saved.getPinned() !== null,
        active: false
      });
      if (!disposed && transition === transitionGeneration) {
        requestRefresh({ forcePost: true, forceReload: mode === 'git-head' });
      }
    },
    async releaseFixed() {
      if (disposed) return;
      const transition = ++transitionGeneration;
      dependencies.saved.releasePinned();
      fixedSelected = false;
      invalidateSelection();
      await dependencies.output.publishFixedState({ pinned: false, active: false });
      if (!disposed && transition === transitionGeneration) {
        requestRefresh({ forcePost: true, forceReload: mode === 'git-head' });
      }
    },
    async publish(options = {}) {
      if (disposed || !dependencies.canPublish()) return false;
      const requestGeneration = ++publishRequestGeneration;
      const startedSelectionGeneration = selectionGeneration;
      let selected: DiffBaselineSelection<TGitProjection>;
      if (!dependencies.readEnabled()) {
        selected = { kind: 'disabled' };
      } else {
        const pinned = dependencies.saved.getPinned();
        if (fixedSelected && pinned) {
          selected = { kind: 'fixed', text: pinned.text };
        } else if (mode === 'git-head') {
          selected = { kind: 'git-head', value: await dependencies.git.resolve(options.forceReload === true) };
        } else {
          const saved = await dependencies.saved.resolve(mode);
          selected = saved.ok
            ? { kind: 'saved', mode, text: saved.text }
            : { kind: 'unavailable', mode, reason: saved.reason };
        }
      }
      if (disposed
        || requestGeneration !== publishRequestGeneration
        || startedSelectionGeneration !== selectionGeneration) return false;

      const hash = dependencies.output.hash(selected);
      if (!options.forcePost && hash === lastPublishedHash) return true;
      outputGeneration += 1;
      const posted = await dependencies.output.publish(selected, outputGeneration);
      if (posted
        && !disposed
        && requestGeneration === publishRequestGeneration
        && startedSelectionGeneration === selectionGeneration) {
        lastPublishedHash = hash;
      }
      return posted;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      selectionGeneration += 1;
      publishRequestGeneration += 1;
      transitionGeneration += 1;
    }
  };
}
