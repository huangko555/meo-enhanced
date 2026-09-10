export type EditorHistoryDirection = 'undo' | 'redo';

export type EditorHistoryViewport = {
  readonly scrollTop: number;
  readonly selection: {
    readonly lineNumber: number;
    readonly visibleFromLineNumber: number;
    readonly visibleToLineNumber: number;
    readonly wasVisible: boolean;
  };
};

export type EditorHistoryContext = {
  readonly viewport: EditorHistoryViewport;
};

export type EditorHistoryState = {
  readonly lifecycle: 'active' | 'disposed';
  readonly pendingReplay: {
    readonly id: number;
    readonly direction: EditorHistoryDirection;
    readonly phase: 'running-native-history' | 'restoring';
  } | null;
};

export type EditorHistoryInput =
  | {
      readonly type: 'requestReplay';
      readonly direction: EditorHistoryDirection;
      readonly context: EditorHistoryContext;
    }
  | {
      readonly type: 'nativeHistoryCompleted';
      readonly replayId: number;
      readonly applied: boolean;
      readonly changedRange: { readonly from: number; readonly to: number } | null;
    }
  | { readonly type: 'interactionRestored'; readonly replayId: number }
  | { readonly type: 'cancelRestore' }
  | { readonly type: 'localDocumentEdited' }
  | { readonly type: 'presentationChanged' }
  | { readonly type: 'externalDocumentPresented' }
  | { readonly type: 'dispose' };

export type EditorHistoryEffect =
  | { readonly type: 'cancelPendingRestore' }
  | { readonly type: 'commitTransientEdits' }
  | {
      readonly type: 'runNativeHistory';
      readonly replayId: number;
      readonly direction: EditorHistoryDirection;
    }
  | {
      /** Successful replay restores Editor focus after positioning the target. */
      readonly type: 'restoreHistoryInteraction';
      readonly replayId: number;
      readonly direction: EditorHistoryDirection;
      readonly targetPosition: number | null;
      readonly changedRange: { readonly from: number; readonly to: number } | null;
      readonly previousViewport: EditorHistoryViewport;
    }
  | { readonly type: 'disposeHistory' };

export type EditorHistoryApplication = {
  getState(): EditorHistoryState;
  dispatch(input: EditorHistoryInput): readonly EditorHistoryEffect[];
};

export type EditorHistoryRuntimeInput =
  | { readonly type: 'requestReplay'; readonly direction: EditorHistoryDirection }
  | { readonly type: 'cancelRestore' }
  | { readonly type: 'localDocumentEdited' }
  | { readonly type: 'presentationChanged' }
  | { readonly type: 'externalDocumentPresented' };

export type EditorHistoryEffectExecution = {
  readonly completion?: Promise<EditorHistoryInput | null>;
  readonly completionMode?: 'inline' | 'deferred';
};

/** Port used by the runtime; concrete CodeMirror/DOM mechanics stay in the Adapter. */
export type EditorHistoryEffectExecutor = {
  prepareInput(input: EditorHistoryRuntimeInput): EditorHistoryInput;
  execute(effect: EditorHistoryEffect): EditorHistoryEffectExecution;
  flushPendingRestore(): void;
};

type PendingReplay = {
  readonly id: number;
  readonly direction: EditorHistoryDirection;
  readonly context: EditorHistoryContext;
  readonly phase: 'running-native-history' | 'restoring';
};

/**
 * Coordinates native history replay with transient-edit commit and interaction
 * restoration. CodeMirror remains the sole owner of undo/redo entries; this
 * Application never stores Document, Draft, Revision, transactions or text.
 */
export function createEditorHistoryApplication(): EditorHistoryApplication {
  let lifecycle: EditorHistoryState['lifecycle'] = 'active';
  let replaySequence = 0;
  let pendingReplay: PendingReplay | null = null;

  const getState = (): EditorHistoryState => ({
    lifecycle,
    pendingReplay: pendingReplay
      ? {
          id: pendingReplay.id,
          direction: pendingReplay.direction,
          phase: pendingReplay.phase
        }
      : null
  });

  const invalidatePendingReplay = (): EditorHistoryEffect[] => {
    if (!pendingReplay) return [];
    pendingReplay = null;
    return [{ type: 'cancelPendingRestore' }];
  };

  const dispatch = (input: EditorHistoryInput): readonly EditorHistoryEffect[] => {
    if (lifecycle === 'disposed') return [];

    switch (input.type) {
      case 'requestReplay': {
        const effects = invalidatePendingReplay();
        const id = ++replaySequence;
        pendingReplay = {
          id,
          direction: input.direction,
          context: input.context,
          phase: 'running-native-history'
        };
        return [
          ...effects,
          { type: 'commitTransientEdits' },
          { type: 'runNativeHistory', replayId: id, direction: input.direction }
        ];
      }

      case 'nativeHistoryCompleted': {
        const pending = pendingReplay;
        if (!pending || pending.id !== input.replayId || pending.phase !== 'running-native-history') return [];
        if (!input.applied) {
          pendingReplay = null;
          return [];
        }
        pendingReplay = { ...pending, phase: 'restoring' };
        return [{
          type: 'restoreHistoryInteraction',
          replayId: pending.id,
          direction: pending.direction,
          targetPosition: input.changedRange
            ? pending.direction === 'undo' ? input.changedRange.from : input.changedRange.to
            : null,
          changedRange: input.changedRange,
          previousViewport: pending.context.viewport
        }];
      }

      case 'interactionRestored':
        if (!pendingReplay || pendingReplay.id !== input.replayId || pendingReplay.phase !== 'restoring') return [];
        pendingReplay = null;
        return [];

      case 'cancelRestore':
      case 'localDocumentEdited':
      case 'presentationChanged':
      case 'externalDocumentPresented':
        return invalidatePendingReplay();

      case 'dispose': {
        const effects = invalidatePendingReplay();
        lifecycle = 'disposed';
        return [...effects, { type: 'disposeHistory' }];
      }
    }
  };

  return { getState, dispatch };
}
