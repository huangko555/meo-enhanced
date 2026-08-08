import type {
  EditableMode,
  EditorMode,
  EditorModeEffect,
  EditorModeInput,
  EditorModePresentation,
  EditorModeViewport
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
  mountEditor(mode: EditableMode): void | Promise<void>;
  applyEditorMode(mode: EditableMode): void | Promise<void>;
  setPreviewActive(active: boolean): void;
  setEditorVisible(visible: boolean): void;
  presentModeControl(mode: EditorMode): void;
  closeFind(): void;
  setSearchOwner(owner: 'editor' | 'preview'): void;
  setOutlineOwner(owner: 'editor' | 'preview'): void;
  setReplaceEnabled(enabled: boolean): void;
  hideSelectionMenu(): void;
  captureViewport(): EditorModeViewport | null;
  restoreViewport(viewport: EditorModeViewport): void;
  focusEditor(): void;
  persistMode(mode: EditorMode, lastEditableMode: EditableMode): void | Promise<void>;
  postMode(mode: EditorMode): void | Promise<void>;
  showNotice(notice: Extract<EditorModeEffect, { type: 'showNotice' }>['notice']): void | Promise<void>;
  reportError(operation: string, error: unknown): void;
  classifyError(error: unknown, operation: 'mount' | 'apply-live' | 'apply-source'): EditorModeFailure;
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
  const applyPresentation = (presentation: EditorModePresentation): void => {
    if (presentation.closeFind) capabilities.closeFind();
    capabilities.setPreviewActive(presentation.previewActive);
    capabilities.setEditorVisible(presentation.editorVisible);
    capabilities.presentModeControl(presentation.mode);
    capabilities.setSearchOwner(presentation.searchOwner);
    capabilities.setOutlineOwner(presentation.outlineOwner);
    capabilities.setReplaceEnabled(presentation.replaceEnabled);
    if (presentation.hideSelectionMenu) capabilities.hideSelectionMenu();
    if (presentation.viewport) capabilities.restoreViewport(presentation.viewport);
    if (presentation.restoreEditorFocus) capabilities.focusEditor();
  };

  const rollbackPresentation = (mode: EditorMode): void => {
    const preview = mode === 'preview';
    capabilities.setPreviewActive(preview);
    capabilities.setEditorVisible(!preview);
    capabilities.presentModeControl(mode);
    capabilities.setSearchOwner(preview ? 'preview' : 'editor');
    capabilities.setOutlineOwner(preview ? 'preview' : 'editor');
    capabilities.setReplaceEnabled(!preview);
    if (preview) capabilities.hideSelectionMenu();
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
          rollbackPresentation(effect.mode);
          return {};
        case 'applyEditorMode': {
          const operation = effect.mode === 'live' ? 'apply-live' : 'apply-source';
          return {
            completion: Promise.resolve()
              .then(() => capabilities.applyEditorMode(effect.mode))
              .then<EditorModeInput>(() => ({
                type: 'editorModeApplied', transitionId: effect.transitionId
              }))
              .catch((error): EditorModeInput => ({
                type: 'editorModeFailed',
                transitionId: effect.transitionId,
                failure: capabilities.classifyError(error, operation)
              }))
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
        case 'scheduleEditorMount':
          return {
            immediate: { type: 'editorMountStarted' },
            completion: Promise.resolve()
              .then(() => capabilities.mountEditor(effect.mode))
              .then<EditorModeInput>(() => ({ type: 'editorMountSucceeded' }))
              .catch((error): EditorModeInput => ({
                type: 'editorMountFailed',
                failure: capabilities.classifyError(error, 'mount')
              }))
          };
        case 'disposeMode':
          capabilities.dispose();
          return {};
      }
    }
  };
}
