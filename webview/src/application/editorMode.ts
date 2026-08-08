export type EditorMode = 'live' | 'source' | 'preview';
export type EditableMode = Exclude<EditorMode, 'preview'>;

export type EditorModeViewport = {
  readonly owner: 'editor' | 'preview';
  readonly topLine: number;
  readonly topLineOffset: number;
};

export type EditorModeRequestSource = 'user' | 'host-command' | 'init-host' | 'init-local' | 'render-failure';

export type EditorModeState = {
  readonly lifecycle: 'awaiting-init' | 'ready' | 'disposed';
  readonly mode: EditorMode;
  readonly lastEditableMode: EditableMode;
  readonly hasLocalPreference: boolean;
  readonly editorMount: 'unmounted' | 'scheduled' | 'mounting' | 'mounted';
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
      readonly source: Exclude<EditorModeRequestSource, 'init-host' | 'init-local'>;
      readonly viewport?: EditorModeViewport | null;
      readonly restoreEditorFocus?: boolean;
    }
  | {
      readonly type: 'toggleMode';
      readonly source: 'user' | 'host-command';
      readonly viewport?: EditorModeViewport | null;
      readonly restoreEditorFocus?: boolean;
    }
  | { readonly type: 'editorModeApplied'; readonly transitionId: number }
  | {
      readonly type: 'editorModeFailed';
      readonly transitionId: number;
      readonly failure: 'transient-live' | 'live-incompatible' | 'fatal';
    }
  | { readonly type: 'editorMountStarted' }
  | { readonly type: 'editorMountSucceeded' }
  | {
      readonly type: 'editorMountFailed';
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
  readonly viewport: EditorModeViewport | null;
  readonly restoreEditorFocus: boolean;
};

export type EditorModeEffect =
  | { readonly type: 'commitTransientEdits' }
  | { readonly type: 'presentMode'; readonly presentation: EditorModePresentation }
  | { readonly type: 'rollbackPresentation'; readonly mode: EditorMode }
  | { readonly type: 'applyEditorMode'; readonly transitionId: number; readonly mode: EditableMode }
  | { readonly type: 'persistMode'; readonly mode: EditorMode; readonly lastEditableMode: EditableMode }
  | { readonly type: 'postMode'; readonly mode: EditorMode }
  | { readonly type: 'showNotice'; readonly notice: 'transient-live' | 'live-fallback' | 'editor-failure' | 'mount-retry' }
  | { readonly type: 'scheduleEditorMount'; readonly mode: EditableMode }
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
  readonly viewport: EditorModeViewport | null;
  readonly restoreEditorFocus: boolean;
  readonly persist: boolean;
  readonly post: boolean;
  readonly fallbackToSource: boolean;
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
  viewport: EditorModeViewport | null,
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
  let lastEditableMode: EditableMode = 'live';
  let hasLocalPreference = false;
  let editorMount: EditorModeState['editorMount'] = 'unmounted';
  let mountRecoveryAttempted = false;
  let transitionSequence = 0;
  let pendingTransition: PendingTransition | null = null;

  const getState = (): EditorModeState => ({
    lifecycle,
    mode,
    lastEditableMode,
    hasLocalPreference,
    editorMount,
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
    viewport: EditorModeViewport | null,
    restoreEditorFocus: boolean
  ): EditorModeEffect[] => {
    const previousMode = mode;
    const policy = requestPolicy(source);
    pendingTransition = null;
    mode = targetMode;
    if (targetMode !== 'preview') lastEditableMode = targetMode;
    if (policy.markLocalPreference) hasLocalPreference = true;

    const effects: EditorModeEffect[] = [
      { type: 'commitTransientEdits' },
      {
        type: 'presentMode',
        presentation: presentationFor(targetMode, previousMode, viewport, restoreEditorFocus)
      }
    ];

    if (targetMode === 'preview' || editorMount !== 'mounted') {
      effects.push(...finalize(targetMode, policy));
      return effects;
    }

    const transitionId = ++transitionSequence;
    pendingTransition = {
      id: transitionId,
      previousMode,
      requestedMode: targetMode,
      source,
      viewport,
      restoreEditorFocus,
      persist: policy.persist,
      post: policy.post,
      fallbackToSource: false
    };
    effects.push({ type: 'applyEditorMode', transitionId, mode: targetMode });
    return effects;
  };

  const dispatch = (input: EditorModeInput): readonly EditorModeEffect[] => {
    if (lifecycle === 'disposed') return [];

    switch (input.type) {
      case 'restoreLocal':
        if (lifecycle !== 'awaiting-init') return [];
        mode = input.mode;
        lastEditableMode = input.lastEditableMode;
        hasLocalPreference = true;
        return [];

      case 'initialize': {
        if (lifecycle !== 'awaiting-init') return [];
        lifecycle = 'ready';
        const source: EditorModeRequestSource = hasLocalPreference ? 'init-local' : 'init-host';
        const targetMode = hasLocalPreference ? mode : input.hostMode;
        const mountMode = targetMode === 'preview' ? lastEditableMode : targetMode;
        editorMount = 'scheduled';
        return [
          { type: 'scheduleEditorMount', mode: mountMode },
          ...requestMode(targetMode, source, null, false)
        ];
      }

      case 'requestMode':
        if (lifecycle !== 'ready') return [];
        return requestMode(
          input.mode,
          input.source,
          input.viewport ?? null,
          input.restoreEditorFocus === true
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
        if (pending.fallbackToSource) {
          mode = 'source';
          return [
            {
              type: 'presentMode',
              presentation: presentationFor('source', 'live', pending.viewport, pending.restoreEditorFocus)
            },
            ...(pending.post ? [{ type: 'postMode', mode: 'source' } as const] : [])
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
          return [
            { type: 'showNotice', notice: 'editor-failure' },
            { type: 'rollbackPresentation', mode: pending.previousMode }
          ];
        }
        if (pending.requestedMode === 'live' && input.failure === 'live-incompatible') {
          pendingTransition = { ...pending, fallbackToSource: true };
          return [
            { type: 'showNotice', notice: 'live-fallback' },
            { type: 'applyEditorMode', transitionId: pending.id, mode: 'source' }
          ];
        }
        pendingTransition = null;
        mode = pending.previousMode;
        return [
          {
            type: 'showNotice',
            notice: pending.requestedMode === 'live' && input.failure === 'transient-live'
              ? 'transient-live'
              : 'editor-failure'
          },
          { type: 'rollbackPresentation', mode: pending.previousMode }
        ];
      }

      case 'editorMountStarted':
        if (editorMount !== 'scheduled') return [];
        editorMount = 'mounting';
        return [];

      case 'editorMountSucceeded':
        if (editorMount !== 'mounting') return [];
        editorMount = 'mounted';
        mountRecoveryAttempted = false;
        return [];

      case 'editorMountFailed': {
        if (editorMount !== 'mounting') return [];
        if (mode === 'live' && !mountRecoveryAttempted && input.failure === 'transient-live') {
          mountRecoveryAttempted = true;
          editorMount = 'scheduled';
          return [
            { type: 'showNotice', notice: 'mount-retry' },
            { type: 'scheduleEditorMount', mode: 'live' }
          ];
        }
        if (mode === 'live' && !mountRecoveryAttempted && input.failure === 'live-incompatible') {
          mountRecoveryAttempted = true;
          editorMount = 'scheduled';
          return [
            { type: 'showNotice', notice: 'live-fallback' },
            ...requestMode('source', 'render-failure', null, false),
            { type: 'scheduleEditorMount', mode: 'source' }
          ];
        }
        editorMount = 'unmounted';
        return [{ type: 'showNotice', notice: 'editor-failure' }];
      }

      case 'dispose':
        lifecycle = 'disposed';
        editorMount = 'unmounted';
        pendingTransition = null;
        return [{ type: 'disposeMode' }];
    }
  };

  return { getState, dispatch };
}
