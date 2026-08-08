import type {
  EditorHistoryContext,
  EditorHistoryDirection,
  EditorHistoryEffect,
  EditorHistoryEffectExecutor,
  EditorHistoryInput
} from '../application/editorHistory';

export type EditorHistoryNativeResult = {
  readonly applied: boolean;
  readonly changedRange: { readonly from: number; readonly to: number } | null;
};

export type EditorHistoryRestoreRequest = Extract<
  EditorHistoryEffect,
  { readonly type: 'restoreHistoryInteraction' }
>;

export type EditorHistoryRestoreAttempt = 'not-rendered' | 'restored' | 'retry';

export type EditorHistoryEffectCapabilities = {
  captureContext(): EditorHistoryContext;
  commitTransientEdits(): void;
  runNativeHistory(
    direction: EditorHistoryDirection
  ): EditorHistoryNativeResult | Promise<EditorHistoryNativeResult>;
  attemptBoundaryRestore(request: EditorHistoryRestoreRequest): EditorHistoryRestoreAttempt;
  restoreEditorInteraction(request: EditorHistoryRestoreRequest): void;
  scheduleFocusRetry(run: () => void): () => void;
  reportError(operation: 'native-history' | 'restore-history-interaction', error: unknown): void;
  dispose(): void;
};

/**
 * Executes Editor History effects while keeping concrete editor, widget,
 * focus retry, and viewport mechanics behind injected capabilities.
 */
export function createEditorHistoryEffectAdapter(
  capabilities: EditorHistoryEffectCapabilities
): EditorHistoryEffectExecutor {
  let restoreGeneration = 0;
  let cancelFocusRetry: (() => void) | null = null;
  let settleRestore: ((completion: EditorHistoryInput | null) => void) | null = null;

  const cancelPendingRestore = (): void => {
    restoreGeneration += 1;
    cancelFocusRetry?.();
    cancelFocusRetry = null;
    settleRestore?.(null);
    settleRestore = null;
  };

  const restoreInteraction = (request: EditorHistoryRestoreRequest): Promise<EditorHistoryInput | null> => {
    cancelPendingRestore();
    const generation = restoreGeneration;

    return new Promise<EditorHistoryInput | null>((resolve) => {
      settleRestore = resolve;

      const finish = (completion: EditorHistoryInput | null): void => {
        if (generation !== restoreGeneration || settleRestore !== resolve) return;
        cancelFocusRetry?.();
        cancelFocusRetry = null;
        settleRestore = null;
        resolve(completion);
      };

      const attempt = (): void => {
        if (generation !== restoreGeneration || settleRestore !== resolve) return;
        try {
          const result = capabilities.attemptBoundaryRestore(request);
          if (result === 'restored') {
            finish({ type: 'interactionRestored', replayId: request.replayId });
            return;
          }
          if (result === 'not-rendered') {
            capabilities.restoreEditorInteraction(request);
            finish({ type: 'interactionRestored', replayId: request.replayId });
            return;
          }
          cancelFocusRetry?.();
          cancelFocusRetry = capabilities.scheduleFocusRetry(attempt);
        } catch (error) {
          capabilities.reportError('restore-history-interaction', error);
          finish({ type: 'interactionRestored', replayId: request.replayId });
        }
      };

      attempt();
    });
  };

  return {
    prepareInput(input) {
      if (input.type !== 'requestReplay') return input;
      return {
        type: 'requestReplay',
        direction: input.direction,
        context: capabilities.captureContext()
      };
    },

    execute(effect) {
      switch (effect.type) {
        case 'cancelPendingRestore':
          cancelPendingRestore();
          return {};

        case 'commitTransientEdits':
          capabilities.commitTransientEdits();
          return {};

        case 'runNativeHistory':
          return {
            completionMode: 'inline',
            completion: Promise.resolve()
              .then(() => capabilities.runNativeHistory(effect.direction))
              .then<EditorHistoryInput>((result) => ({
                type: 'nativeHistoryCompleted',
                replayId: effect.replayId,
                applied: result.applied,
                changedRange: result.changedRange
              }))
              .catch((error): EditorHistoryInput => {
                capabilities.reportError('native-history', error);
                return {
                  type: 'nativeHistoryCompleted',
                  replayId: effect.replayId,
                  applied: false,
                  changedRange: null
                };
              })
          };

        case 'restoreHistoryInteraction':
          return {
            completionMode: 'deferred',
            completion: restoreInteraction(effect)
          };

        case 'disposeHistory':
          cancelPendingRestore();
          capabilities.dispose();
          return {};
      }
    }
  };
}
