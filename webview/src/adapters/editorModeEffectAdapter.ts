import type {
  EditableMode,
  EditorMode,
  EditorModeEffect,
  EditorModeInput,
  EditorModePresentation,
  EditorModeViewportToken
} from '../application/editorMode';

export type EditorModeFailure = 'transient-live' | 'live-incompatible' | 'fatal';

export type EditorModeEffectExecution = {
  readonly immediate?: EditorModeInput;
  readonly completion?: Promise<EditorModeInput | null>;
};

export type EditorModeEffectAdapter = {
  prepareInput(input: EditorModeInput): EditorModeInput;
  execute(effect: EditorModeEffect): EditorModeEffectExecution;
};

export type EditorModeEffectCapabilities = {
  commitTransientEdits(): void;
  scheduleMount?(run: () => void): () => void;
  mountEditor(mode: EditableMode, signal: AbortSignal): void | Promise<void>;
  applyEditorMode(
    mode: EditableMode,
    viewport: EditorModeViewportToken | null
  ): void | Promise<void>;
  setPreviewActive(active: boolean, presentation?: EditorModePresentation): void;
  setEditorVisible(visible: boolean, interactive?: boolean): void;
  presentModeControl(mode: EditorMode): void;
  closeFind(): void;
  setSearchOwner(owner: 'editor' | 'preview'): void;
  setOutlineOwner(owner: 'editor' | 'preview'): void;
  setReplaceEnabled(enabled: boolean): void;
  hideSelectionMenu(): void;
  captureViewport(): EditorModeViewportToken | null;
  restoreViewport(viewport: EditorModeViewportToken, owner: 'editor' | 'preview'): void;
  focusEditor(): void;
  persistMode(mode: EditorMode, lastEditableMode: EditableMode): void | Promise<void>;
  postMode(mode: EditorMode): void | Promise<void>;
  showNotice(notice: Extract<EditorModeEffect, { type: 'showNotice' }>['notice']): void | Promise<void>;
  reportError(operation: string, error: unknown): void;
  classifyError(
    error: unknown,
    operation: 'mount-live' | 'mount-source' | 'apply-live' | 'apply-source'
  ): EditorModeFailure;
  dispose(): void;
};

const bestEffort = (
  operation: string,
  action: () => void | Promise<void>,
  reportError: EditorModeEffectCapabilities['reportError']
): void => {
  try {
    void Promise.resolve(action()).catch((error) => reportError(operation, error));
  } catch (error) {
    reportError(operation, error);
  }
};

/** Executes Editor Mode effects without owning mode, transition, or document state. */
export function createEditorModeEffectAdapter(
  capabilities: EditorModeEffectCapabilities
): EditorModeEffectAdapter {
  let cancelScheduledMount: (() => void) | null = null;
  let resolveScheduledMount: ((run: boolean) => void) | null = null;
  let mountAbortController: AbortController | null = null;
  let presentationGeneration = 0;
  let pendingAtomicReveal: {
    readonly generation: number;
    readonly restoreEditorFocus: boolean;
  } | null = null;

  const applyPresentation = (presentation: EditorModePresentation): void => {
    const generation = ++presentationGeneration;
    pendingAtomicReveal = null;
    if (presentation.closeFind) capabilities.closeFind();
    if (presentation.atomicEditorReveal) {
      capabilities.setEditorVisible(true, false);
      pendingAtomicReveal = {
        generation,
        restoreEditorFocus: presentation.restoreEditorFocus
      };
    } else {
      capabilities.setPreviewActive(presentation.previewActive, presentation);
      capabilities.setEditorVisible(presentation.editorVisible, presentation.editorVisible);
    }
    capabilities.presentModeControl(presentation.mode);
    capabilities.setSearchOwner(presentation.searchOwner);
    capabilities.setOutlineOwner(presentation.outlineOwner);
    capabilities.setReplaceEnabled(presentation.replaceEnabled);
    if (presentation.hideSelectionMenu) capabilities.hideSelectionMenu();
    if (
      presentation.viewport &&
      presentation.previewActive &&
      presentation.previousMode !== 'preview'
    ) {
      capabilities.restoreViewport(
        presentation.viewport,
        presentation.previewActive ? 'preview' : 'editor'
      );
    }
    if (presentation.restoreEditorFocus && !presentation.atomicEditorReveal) capabilities.focusEditor();
  };

  const rollbackPresentation = (
    mode: EditorMode,
    viewport: EditorModeViewportToken | null
  ): void => {
    presentationGeneration += 1;
    pendingAtomicReveal = null;
    const preview = mode === 'preview';
    capabilities.setPreviewActive(preview);
    capabilities.setEditorVisible(!preview, !preview);
    capabilities.presentModeControl(mode);
    capabilities.setSearchOwner(preview ? 'preview' : 'editor');
    capabilities.setOutlineOwner(preview ? 'preview' : 'editor');
    capabilities.setReplaceEnabled(!preview);
    if (preview) capabilities.hideSelectionMenu();
    if (viewport) capabilities.restoreViewport(viewport, preview ? 'preview' : 'editor');
  };

  return {
    prepareInput(input) {
      if ((input.type !== 'requestMode' && input.type !== 'toggleMode') || input.viewport !== undefined) {
        return input;
      }
      return { ...input, viewport: capabilities.captureViewport() };
    },

    execute(effect) {
      switch (effect.type) {
        case 'commitTransientEdits':
          capabilities.commitTransientEdits();
          return {};
        case 'presentMode':
          applyPresentation(effect.presentation);
          return {};
        case 'rollbackPresentation':
          rollbackPresentation(effect.mode, effect.viewport);
          return {};
        case 'applyEditorMode': {
          const operation = effect.mode === 'live' ? 'apply-live' : 'apply-source';
          const atomicReveal = pendingAtomicReveal;
          return {
            completion: Promise.resolve()
              .then(() => capabilities.applyEditorMode(effect.mode, effect.viewport))
              .then<EditorModeInput>(() => {
                if (
                  atomicReveal &&
                  pendingAtomicReveal === atomicReveal &&
                  presentationGeneration === atomicReveal.generation
                ) {
                  pendingAtomicReveal = null;
                  capabilities.setPreviewActive(false);
                  capabilities.setEditorVisible(true, true);
                  if (atomicReveal.restoreEditorFocus) capabilities.focusEditor();
                }
                return { type: 'editorModeApplied', transitionId: effect.transitionId };
              })
              .catch((error): EditorModeInput => {
                if (pendingAtomicReveal === atomicReveal) pendingAtomicReveal = null;
                return {
                  type: 'editorModeFailed',
                  transitionId: effect.transitionId,
                  failure: capabilities.classifyError(error, operation)
                };
              })
          };
        }
        case 'persistMode':
          bestEffort('persist-mode', () => capabilities.persistMode(effect.mode, effect.lastEditableMode), capabilities.reportError);
          return {};
        case 'postMode':
          bestEffort('post-mode', () => capabilities.postMode(effect.mode), capabilities.reportError);
          return {};
        case 'showNotice':
          bestEffort('show-notice', () => capabilities.showNotice(effect.notice), capabilities.reportError);
          return {};
        case 'scheduleEditorMount': {
          mountAbortController?.abort();
          const controller = new AbortController();
          mountAbortController = controller;
          return {
            immediate: { type: 'editorMountStarted', mountId: effect.mountId },
            completion: new Promise<boolean>((resolve) => {
              cancelScheduledMount?.();
              resolveScheduledMount?.(false);
              resolveScheduledMount = resolve;
              if (capabilities.scheduleMount) {
                cancelScheduledMount = capabilities.scheduleMount(() => {
                  cancelScheduledMount = null;
                  resolveScheduledMount = null;
                  resolve(true);
                });
              } else {
                resolveScheduledMount = null;
                resolve(true);
              }
            })
              .then(async (run): Promise<EditorModeInput | null> => {
                if (!run) return null;
                await capabilities.mountEditor(effect.mode, controller.signal);
                if (controller.signal.aborted) return null;
                if (mountAbortController === controller) mountAbortController = null;
                return { type: 'editorMountSucceeded', mountId: effect.mountId };
              })
              .catch((error): EditorModeInput => {
                if (mountAbortController === controller) mountAbortController = null;
                return {
                  type: 'editorMountFailed',
                  mountId: effect.mountId,
                  failure: capabilities.classifyError(
                    error,
                    effect.mode === 'live' ? 'mount-live' : 'mount-source'
                  )
                };
              })
          };
        }
        case 'disposeMode':
          presentationGeneration += 1;
          pendingAtomicReveal = null;
          cancelScheduledMount?.();
          cancelScheduledMount = null;
          resolveScheduledMount?.(false);
          resolveScheduledMount = null;
          mountAbortController?.abort();
          mountAbortController = null;
          capabilities.dispose();
          return {};
      }
    }
  };
}
