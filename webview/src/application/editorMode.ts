export type EditorMode = 'live' | 'source' | 'preview';
export type EditableMode = Exclude<EditorMode, 'preview'>;

/** Opaque handle; only the ViewportController Adapter may interpret its anchor. */
export type EditorModeViewportToken = object;

export type EditorModeRequestSource = 'user' | 'host-command' | 'init-host' | 'init-local' | 'render-failure';

export type EditorModeState = {
  readonly lifecycle: 'awaiting-init' | 'ready' | 'disposed';
  readonly mode: EditorMode;
  readonly requestedMode: EditorMode;
  readonly lastEditableMode: EditableMode;
  readonly hasLocalPreference: boolean;
  readonly intentId: number;
  readonly manualIntent: { readonly id: number; readonly mode: EditorMode } | null;
  readonly editorMount: 'unmounted' | 'scheduled' | 'mounting' | 'mounted';
  readonly pendingMount: { readonly id: number; readonly mode: EditableMode } | null;
  readonly mountRecoveryAttempted: boolean;
  readonly pendingTransition: {
    readonly id: number;
    readonly requestedMode: EditableMode;
    readonly fallbackToSource: boolean;
  } | null;
};

export type EditorModeInput =
  | { readonly type: 'restoreLocal'; readonly mode: EditorMode; readonly lastEditableMode: EditableMode }
  | { readonly type: 'initialize'; readonly hostMode: EditorMode }
  | {
      readonly type: 'requestMode';
      readonly mode: EditorMode;
      readonly source: 'user' | 'host-command';
      readonly viewport?: EditorModeViewportToken | null;
      readonly restoreEditorFocus?: boolean;
    }
  | {
      readonly type: 'requestMode';
      readonly mode: EditableMode;
      readonly source: 'render-failure';
      readonly basisManualIntentId: number;
      readonly viewport?: EditorModeViewportToken | null;
      readonly restoreEditorFocus?: boolean;
    }
  | {
      readonly type: 'toggleMode';
      readonly source: 'user' | 'host-command';
      readonly viewport?: EditorModeViewportToken | null;
      readonly restoreEditorFocus?: boolean;
    }
  | { readonly type: 'editorModeApplied'; readonly transitionId: number }
  | {
      readonly type: 'editorModeFailed';
      readonly transitionId: number;
      readonly failure: 'transient-live' | 'live-incompatible' | 'fatal';
    }
  | { readonly type: 'editorMountStarted'; readonly mountId: number }
  | { readonly type: 'editorMountSucceeded'; readonly mountId: number }
  | {
      readonly type: 'editorMountFailed';
      readonly mountId: number;
      readonly failure: 'transient-live' | 'live-incompatible' | 'fatal';
    }
  | { readonly type: 'dispose' };

export type EditorModePresentation = {
  readonly mode: EditorMode;
  readonly previousMode: EditorMode;
  readonly closeFind: boolean;
  readonly previewActive: boolean;
  readonly editorVisible: boolean;
  readonly searchOwner: 'editor' | 'preview';
  readonly outlineOwner: 'editor' | 'preview';
  readonly replaceEnabled: boolean;
  readonly hideSelectionMenu: boolean;
  readonly viewport: EditorModeViewportToken | null;
  readonly restoreEditorFocus: boolean;
};

export type EditorModeEffect =
  | { readonly type: 'commitTransientEdits' }
  | { readonly type: 'presentMode'; readonly presentation: EditorModePresentation }
  | {
      readonly type: 'rollbackPresentation';
      readonly mode: EditorMode;
      readonly viewport: EditorModeViewportToken | null;
    }
  | {
      readonly type: 'applyEditorMode';
      readonly transitionId: number;
      readonly mode: EditableMode;
      readonly viewport: EditorModeViewportToken | null;
    }
  | { readonly type: 'persistMode'; readonly mode: EditorMode; readonly lastEditableMode: EditableMode }
  | { readonly type: 'postMode'; readonly mode: EditorMode }
  | {
      readonly type: 'showNotice';
      readonly notice: 'transient-live' | 'live-fallback' | 'editor-failure' | 'mount-retry' | 'mount-failure';
    }
  | { readonly type: 'scheduleEditorMount'; readonly mountId: number; readonly mode: EditableMode }
  | { readonly type: 'disposeMode' };

export type EditorModeApplication = {
  getState(): EditorModeState;
  dispatch(input: EditorModeInput): readonly EditorModeEffect[];
};

type PendingTransition = {
  readonly id: number;
  readonly previousMode: EditorMode;
  readonly requestedMode: EditableMode;
  readonly source: EditorModeRequestSource;
  readonly manualIntentId: number | null;
  readonly viewport: EditorModeViewportToken | null;
  readonly restoreEditorFocus: boolean;
  readonly persist: boolean;
  readonly post: boolean;
  readonly fallbackToSource: boolean;
};

type PendingMount = {
  readonly id: number;
  readonly mode: EditableMode;
  readonly requestedMode: EditorMode;
  readonly manualIntentId: number | null;
  readonly persist: boolean;
  readonly post: boolean;
};

const requestPolicy = (source: EditorModeRequestSource): {
  readonly persist: boolean;
  readonly post: boolean;
  readonly markLocalPreference: boolean;
} => {
  switch (source) {
    case 'user':
    case 'host-command':
    case 'init-local':
      return { persist: true, post: true, markLocalPreference: true };
    case 'render-failure':
      return { persist: false, post: true, markLocalPreference: false };
    case 'init-host':
      return { persist: false, post: false, markLocalPreference: false };
  }
};

const presentationFor = (
  mode: EditorMode,
  previousMode: EditorMode,
  viewport: EditorModeViewportToken | null,
  restoreEditorFocus: boolean
): EditorModePresentation => ({
  mode,
  previousMode,
  closeFind: mode !== previousMode,
  previewActive: mode === 'preview',
  editorVisible: mode !== 'preview',
  searchOwner: mode === 'preview' ? 'preview' : 'editor',
  outlineOwner: mode === 'preview' ? 'preview' : 'editor',
  replaceEnabled: mode !== 'preview',
  hideSelectionMenu: mode === 'preview',
  viewport,
  restoreEditorFocus: mode !== 'preview' && restoreEditorFocus
});

/**
 * Owns Editor Mode intent, rollback, fallback and lazy-mount lifecycle.
 * Effects are instructions for concrete Editor/Preview/UI/Protocol adapters;
 * this module never owns Document text, Draft, Revision or rendering objects.
 */
export function createEditorModeApplication(): EditorModeApplication {
  let lifecycle: EditorModeState['lifecycle'] = 'awaiting-init';
  let mode: EditorMode = 'live';
  let requestedMode: EditorMode = 'live';
  let lastEditableMode: EditableMode = 'live';
  let hasLocalPreference = false;
  let intentId = 0;
  let manualIntentSequence = 0;
  let manualIntent: EditorModeState['manualIntent'] = null;
  let editorMount: EditorModeState['editorMount'] = 'unmounted';
  let mountSequence = 0;
  let pendingMount: PendingMount | null = null;
  let mountRecoveryAttempted = false;
  let transitionSequence = 0;
  let pendingTransition: PendingTransition | null = null;
  let restoreFocusOnPreviewExit = false;

  const getState = (): EditorModeState => ({
    lifecycle,
    mode,
    requestedMode,
    lastEditableMode,
    hasLocalPreference,
    intentId,
    manualIntent,
    editorMount,
    pendingMount: pendingMount ? { id: pendingMount.id, mode: pendingMount.mode } : null,
    mountRecoveryAttempted,
    pendingTransition: pendingTransition
      ? {
          id: pendingTransition.id,
          requestedMode: pendingTransition.requestedMode,
          fallbackToSource: pendingTransition.fallbackToSource
        }
      : null
  });

  const finalize = (
    requestedMode: EditorMode,
    policy: ReturnType<typeof requestPolicy>
  ): EditorModeEffect[] => {
    const effects: EditorModeEffect[] = [];
    if (policy.persist) effects.push({ type: 'persistMode', mode, lastEditableMode });
    if (policy.post) effects.push({ type: 'postMode', mode: requestedMode });
    return effects;
  };

  const requestMode = (
    targetMode: EditorMode,
    source: EditorModeRequestSource,
    viewport: EditorModeViewportToken | null,
    restoreEditorFocus: boolean,
    options: { readonly force?: boolean; readonly basisManualIntentId?: number } = {}
  ): EditorModeEffect[] => {
    if (source === 'render-failure'
      && options.basisManualIntentId !== (manualIntent?.id ?? 0)) {
      return [];
    }
    const manual = source === 'user' || source === 'host-command';
    if (!options.force && targetMode === requestedMode) {
      const pendingTargetMode = pendingTransition?.fallbackToSource
        ? 'source'
        : pendingTransition?.requestedMode;
      const adoptsPendingTransition = pendingTargetMode === targetMode;
      const adoptsPendingMount = pendingMount?.requestedMode === targetMode;
      const transitionAlreadyManual = adoptsPendingTransition
        && pendingTransition?.manualIntentId !== null
        && pendingTransition?.manualIntentId === (manualIntent?.id ?? null)
        && manualIntent?.mode === targetMode;
      const mountAlreadyManual = adoptsPendingMount
        && pendingMount?.manualIntentId !== null
        && pendingMount?.manualIntentId === (manualIntent?.id ?? null)
        && manualIntent?.mode === targetMode;
      if (manual
        && ((adoptsPendingTransition && !transitionAlreadyManual)
          || (adoptsPendingMount && !mountAlreadyManual))) {
        const adoptedManualIntent = { id: ++manualIntentSequence, mode: targetMode };
        manualIntent = adoptedManualIntent;
        hasLocalPreference = true;
        if (targetMode !== 'preview') lastEditableMode = targetMode;
        if (adoptsPendingTransition && pendingTransition) {
          pendingTransition = {
            ...pendingTransition,
            requestedMode: pendingTransition.fallbackToSource
              ? targetMode
              : pendingTransition.requestedMode,
            source,
            manualIntentId: adoptedManualIntent.id,
            viewport: viewport ?? pendingTransition.viewport,
            persist: true,
            post: true
          };
        }
        if (adoptsPendingMount && pendingMount) {
          pendingMount = {
            ...pendingMount,
            manualIntentId: adoptedManualIntent.id,
            persist: true,
            post: true
          };
        }
      }
      return [];
    }

    intentId += 1;
    requestedMode = targetMode;
    if (manual) {
      manualIntent = { id: ++manualIntentSequence, mode: targetMode };
    }
    const previousMode = mode;
    const policy = requestPolicy(source);
    if (targetMode === 'preview' && previousMode !== 'preview') {
      restoreFocusOnPreviewExit = restoreEditorFocus;
    }
    const effectiveRestoreEditorFocus = targetMode !== 'preview' && previousMode === 'preview'
      ? restoreEditorFocus || restoreFocusOnPreviewExit
      : restoreEditorFocus;
    pendingTransition = null;
    mode = targetMode;
    if (targetMode !== 'preview') lastEditableMode = targetMode;
    if (policy.markLocalPreference) hasLocalPreference = true;

    const effects: EditorModeEffect[] = [
      { type: 'commitTransientEdits' },
      {
        type: 'presentMode',
        presentation: presentationFor(targetMode, previousMode, viewport, effectiveRestoreEditorFocus)
      }
    ];

    if (targetMode === 'preview' || editorMount !== 'mounted') {
      if (targetMode !== 'preview' && pendingMount?.mode !== targetMode) {
        pendingMount = {
          id: ++mountSequence,
          mode: targetMode,
          requestedMode: targetMode,
          manualIntentId: manual ? manualIntent?.id ?? null : null,
          persist: policy.persist,
          post: policy.post
        };
        editorMount = 'scheduled';
        effects.unshift({ type: 'scheduleEditorMount', mountId: pendingMount.id, mode: targetMode });
      } else if (pendingMount) {
        pendingMount = {
          ...pendingMount,
          requestedMode: targetMode,
          manualIntentId: manual ? manualIntent?.id ?? null : null,
          persist: policy.persist,
          post: policy.post
        };
      }
      if (targetMode !== 'preview') restoreFocusOnPreviewExit = false;
      if (pendingMount) return effects;
      effects.push(...finalize(targetMode, policy));
      return effects;
    }

    const transitionId = ++transitionSequence;
    pendingTransition = {
      id: transitionId,
      previousMode,
      requestedMode: targetMode,
      source,
      manualIntentId: manual ? manualIntent?.id ?? null : null,
      viewport,
      restoreEditorFocus: effectiveRestoreEditorFocus,
      persist: policy.persist,
      post: policy.post,
      fallbackToSource: false
    };
    effects.push({ type: 'applyEditorMode', transitionId, mode: targetMode, viewport });
    return effects;
  };

  const dispatch = (input: EditorModeInput): readonly EditorModeEffect[] => {
    if (lifecycle === 'disposed') return [];

    switch (input.type) {
      case 'restoreLocal':
        if (lifecycle !== 'awaiting-init') return [];
        mode = input.mode;
        requestedMode = input.mode;
        lastEditableMode = input.lastEditableMode;
        hasLocalPreference = true;
        return [];

      case 'initialize': {
        if (lifecycle !== 'awaiting-init') return [];
        lifecycle = 'ready';
        const source: EditorModeRequestSource = hasLocalPreference ? 'init-local' : 'init-host';
        const targetMode = hasLocalPreference ? mode : input.hostMode;
        if (targetMode === 'preview') {
          const policy = requestPolicy(source);
          pendingMount = {
            id: ++mountSequence,
            mode: lastEditableMode,
            requestedMode: targetMode,
            manualIntentId: null,
            persist: policy.persist,
            post: policy.post
          };
          editorMount = 'scheduled';
          return [
            { type: 'scheduleEditorMount', mountId: pendingMount.id, mode: pendingMount.mode },
            ...requestMode(targetMode, source, null, false, { force: true })
          ];
        }
        return requestMode(targetMode, source, null, false, { force: true });
      }

      case 'requestMode':
        if (lifecycle !== 'ready') return [];
        return requestMode(
          input.mode,
          input.source,
          input.viewport ?? null,
          input.restoreEditorFocus === true,
          input.source === 'render-failure'
            ? { basisManualIntentId: input.basisManualIntentId }
            : undefined
        );

      case 'toggleMode': {
        if (lifecycle !== 'ready') return [];
        const targetMode = mode === 'preview'
          ? lastEditableMode
          : mode === 'live' ? 'source' : 'live';
        return requestMode(
          targetMode,
          input.source,
          input.viewport ?? null,
          input.restoreEditorFocus === true
        );
      }

      case 'editorModeApplied': {
        const pending = pendingTransition;
        if (!pending || pending.id !== input.transitionId) return [];
        pendingTransition = null;
        restoreFocusOnPreviewExit = false;
        if (pending.fallbackToSource) {
          mode = 'source';
          requestedMode = 'source';
          return [
            {
              type: 'presentMode',
              presentation: presentationFor('source', 'live', pending.viewport, pending.restoreEditorFocus)
            },
            ...(pending.requestedMode === 'source'
              ? finalize('source', {
                  persist: pending.persist,
                  post: pending.post,
                  markLocalPreference: false
                })
              : pending.post ? [{ type: 'postMode', mode: 'source' } as const] : [])
          ];
        }
        return finalize(pending.requestedMode, {
          persist: pending.persist,
          post: pending.post,
          markLocalPreference: false
        });
      }

      case 'editorModeFailed': {
        const pending = pendingTransition;
        if (!pending || pending.id !== input.transitionId) return [];
        if (pending.fallbackToSource) {
          pendingTransition = null;
          mode = pending.previousMode;
          requestedMode = pending.previousMode;
          return [
            { type: 'showNotice', notice: 'editor-failure' },
            {
              type: 'rollbackPresentation',
              mode: pending.previousMode,
              viewport: pending.viewport
            }
          ];
        }
        if (pending.requestedMode === 'live' && input.failure === 'live-incompatible') {
          pendingTransition = { ...pending, fallbackToSource: true };
          requestedMode = 'source';
          return [
            { type: 'showNotice', notice: 'live-fallback' },
            {
              type: 'applyEditorMode',
              transitionId: pending.id,
              mode: 'source',
              viewport: pending.viewport
            }
          ];
        }
        pendingTransition = null;
        mode = pending.previousMode;
        requestedMode = pending.previousMode;
        return [
          {
            type: 'showNotice',
            notice: pending.requestedMode === 'live' && input.failure === 'transient-live'
              ? 'transient-live'
              : 'editor-failure'
          },
          {
            type: 'rollbackPresentation',
            mode: pending.previousMode,
            viewport: pending.viewport
          }
        ];
      }

      case 'editorMountStarted':
        if (editorMount !== 'scheduled'
          || !pendingMount
          || input.mountId !== pendingMount.id) return [];
        editorMount = 'mounting';
        return [];

      case 'editorMountSucceeded':
        if (editorMount !== 'mounting'
          || !pendingMount
          || input.mountId !== pendingMount.id) return [];
        const completedMount = pendingMount;
        editorMount = 'mounted';
        pendingMount = null;
        mountRecoveryAttempted = false;
        return finalize(completedMount.requestedMode, {
          persist: completedMount.persist,
          post: completedMount.post,
          markLocalPreference: false
        });

      case 'editorMountFailed': {
        if (editorMount !== 'mounting'
          || !pendingMount
          || input.mountId !== pendingMount.id) return [];
        const failedMount = pendingMount;
        pendingMount = null;
        if (mode === 'live' && !mountRecoveryAttempted && input.failure === 'transient-live') {
          mountRecoveryAttempted = true;
          pendingMount = { ...failedMount, id: ++mountSequence, mode: 'live' };
          editorMount = 'scheduled';
          return [
            { type: 'showNotice', notice: 'mount-retry' },
            { type: 'scheduleEditorMount', mountId: pendingMount.id, mode: 'live' }
          ];
        }
        if (mode === 'live' && !mountRecoveryAttempted && input.failure === 'live-incompatible') {
          mountRecoveryAttempted = true;
          const fallbackEffects = requestMode('source', 'render-failure', null, false, {
            force: true,
            basisManualIntentId: manualIntent?.id ?? 0
          });
          return [
            { type: 'showNotice', notice: 'live-fallback' },
            ...fallbackEffects
          ];
        }
        editorMount = 'unmounted';
        return [{
          type: 'showNotice',
          notice: mode === 'live' && input.failure === 'transient-live'
            ? 'mount-failure'
            : 'editor-failure'
        }];
      }

      case 'dispose':
        lifecycle = 'disposed';
        editorMount = 'unmounted';
        pendingMount = null;
        pendingTransition = null;
        restoreFocusOnPreviewExit = false;
        return [{ type: 'disposeMode' }];
    }
  };

  return { getState, dispatch };
}
