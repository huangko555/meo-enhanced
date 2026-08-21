import { createEditorModeApplication, type EditorMode } from '../webview/src/application/editorMode';
import {
  createEditorModeEffectAdapter,
  type EditorModeFailure
} from '../webview/src/adapters/editorModeEffectAdapter';
import { createEditorModeRuntime } from '../webview/src/adapters/editorModeRuntime';
import { createEditor } from './test-editor-factory';
import { handleEditorShortcut } from '../webview/src/helpers/shortcuts';

type Editor = ReturnType<typeof createEditor>;
type TaggedError = Error & { failure: EditorModeFailure };

const events: string[] = [];
const notices: string[] = [];
const errors: string[] = [];
let editor: Editor | null = null;
let mountAttempts = 0;
let failNextLive = true;
let previewActive = false;
let disposed = false;
let runtimeStarts = 0;
let persistedMode: string | null = null;
let releaseHeldMount: (() => void) | null = null;
const editorCreateModes: EditorMode[] = [];
const legacyModeCoordinatorStarts = 0;

const element = (id: string): HTMLElement => {
  const value = document.querySelector<HTMLElement>(`#${id}`);
  if (!value) throw new Error(`Missing #${id}`);
  return value;
};

const taggedError = (failure: EditorModeFailure): TaggedError =>
  Object.assign(new Error(failure), { failure });

const application = createEditorModeApplication();
const adapter = createEditorModeEffectAdapter({
  commitTransientEdits: () => events.push('commit'),
  async mountEditor(mode, signal) {
    mountAttempts += 1;
    events.push(`mount:${mountAttempts}:${mode}`);
    if (mountAttempts === 1 && releaseHeldMount) {
      events.push(`mount-wait:${mode}`);
      await new Promise<void>((resolve) => { releaseHeldMount = resolve; });
      if (signal.aborted) {
        events.push(`mount-aborted:${mode}`);
        return;
      }
    }
    if (mountAttempts === 1) throw taggedError('transient-live');
    editorCreateModes.push(mode);
    editor = createEditor({
      parent: element('editor'),
      text: '# Editor Mode\n\nalpha\nbeta\ngamma',
      initialMode: mode,
      initialGitGutter: false,
      onApplyChanges: () => undefined,
      onOpenLink: () => undefined,
      onSelectionChange: () => undefined,
    });
  },
  applyEditorMode(mode) {
    events.push(`apply:${mode}`);
    if (mode === 'live' && failNextLive) {
      failNextLive = false;
      throw taggedError('live-incompatible');
    }
    if (!editor) throw taggedError('fatal');
    editor.setMode(mode);
  },
  setPreviewActive(active, restoreLine) {
    previewActive = active;
    element('preview').hidden = !active;
    events.push(`preview:${active}:${restoreLine ?? 'none'}`);
  },
  setEditorVisible(visible) {
    element('editor').hidden = !visible;
    events.push(`editor:${visible}`);
  },
  presentModeControl(mode) {
    element('mode').dataset.mode = mode;
  },
  closeFind: () => events.push('close-find'),
  setSearchOwner(owner) {
    element('search').dataset.owner = owner;
  },
  setOutlineOwner(owner) {
    element('outline').dataset.owner = owner;
  },
  setReplaceEnabled(enabled) {
    element('replace').toggleAttribute('disabled', !enabled);
  },
  hideSelectionMenu() {
    element('selection-menu').hidden = true;
  },
  captureViewport() {
    if (previewActive) return { owner: 'preview', topLine: 27, topLineOffset: 0.25 };
    const position = editor?.getTopVisiblePosition();
    return position
      ? { owner: 'editor', topLine: position.line, topLineOffset: position.lineOffset }
      : null;
  },
  restoreViewport(viewport) {
    events.push(`restore:${viewport.owner}:${viewport.topLine}`);
    if (viewport.owner === 'preview') editor?.restoreTopLine(viewport.topLine, viewport.topLineOffset, {
      syncCursor: false,
      force: true
    });
  },
  focusEditor() {
    editor?.focus();
    events.push('focus');
  },
  persistMode(mode, lastEditableMode) {
    events.push(`persist:${mode}:${lastEditableMode}`);
    persistedMode = JSON.stringify({ mode, lastEditableMode });
  },
  postMode(mode) {
    events.push(`post:${mode}`);
  },
  showNotice(notice) {
    notices.push(notice);
    events.push(`notice:${notice}`);
  },
  reportError(operation, error) {
    errors.push(`${operation}:${String(error)}`);
  },
  classifyError(error, operation) {
    events.push(`classify:${operation}`);
    return typeof error === 'object' && error !== null && 'failure' in error
      ? (error as TaggedError).failure
      : 'fatal';
  },
  dispose() {
    if (disposed) return;
    disposed = true;
    editor?.destroy();
    editor = null;
    events.push('dispose');
  }
});
runtimeStarts += 1;
const runtime = createEditorModeRuntime(application, adapter, (error) => errors.push(`runtime:${String(error)}`));

element('live-mode').addEventListener('click', () => {
  void runtime.dispatch({ type: 'requestMode', mode: 'live', source: 'user' });
});
element('source-mode').addEventListener('click', () => {
  void runtime.dispatch({ type: 'requestMode', mode: 'source', source: 'user' });
});
element('preview-mode').addEventListener('click', () => {
  void runtime.dispatch({ type: 'requestMode', mode: 'preview', source: 'user' });
});
window.addEventListener('keydown', (event) => {
  handleEditorShortcut(event, {
    editor,
    editableMode: application.getState().mode === 'preview'
      ? application.getState().lastEditableMode
      : application.getState().mode,
    requestSave: () => undefined,
    openFindPanel: () => undefined,
    requestMode: (mode) => { void runtime.dispatch({ type: 'requestMode', mode, source: 'user' }); }
  });
}, { capture: true });

const candidate = {
  async initialize() {
    await runtime.dispatch({ type: 'restoreLocal', mode: 'live', lastEditableMode: 'live' });
    await runtime.dispatch({ type: 'initialize', hostMode: 'source' });
  },
  async initializeWithHeldMount() {
    releaseHeldMount = () => undefined;
    await runtime.dispatch({ type: 'restoreLocal', mode: 'live', lastEditableMode: 'live' });
    await runtime.dispatch({ type: 'initialize', hostMode: 'live' });
  },
  releaseMount() {
    const release = releaseHeldMount;
    releaseHeldMount = null;
    release?.();
  },
  allowLive() {
    failNextLive = false;
  },
  request(mode: EditorMode, restoreEditorFocus = false) {
    return runtime.dispatch({ type: 'requestMode', mode, source: 'user', restoreEditorFocus });
  },
  toggle(restoreEditorFocus = false) {
    return runtime.dispatch({ type: 'toggleMode', source: 'user', restoreEditorFocus });
  },
  whenIdle: () => runtime.whenIdle(),
  focusEditor: () => editor?.focus(),
  undo: () => editor?.undo(),
  redo: () => editor?.redo(),
  snapshot() {
    return {
      state: runtime.getState(),
      runtimeStarts,
      legacyModeCoordinatorStarts,
      mountAttempts,
      editorCreateModes: [...editorCreateModes],
      editorMounted: editor !== null,
      text: editor?.getText() ?? null,
      editorMode: element('mode').dataset.mode ?? null,
      editorVisible: !element('editor').hidden,
      previewVisible: !element('preview').hidden,
      searchOwner: element('search').dataset.owner ?? null,
      outlineOwner: element('outline').dataset.owner ?? null,
      replaceEnabled: !element('replace').hasAttribute('disabled'),
      editorFocused: editor?.hasFocus() ?? false,
      events: [...events],
      notices: [...notices],
      errors: [...errors],
      persisted: persistedMode,
      disposed
    };
  },
  dispose: () => runtime.dispose()
};

(window as typeof window & { __editorModeCandidate: typeof candidate }).__editorModeCandidate = candidate;
