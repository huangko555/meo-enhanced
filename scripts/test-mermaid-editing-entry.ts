import { StateEffect, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { isLiveInputDerivedWorkPending, isLiveInputDerivedWorkRefresh, requestLiveInputDerivedWork, usesLargeDocumentDerivedWorkBudget } from '../webview/src/editor/liveInputDerivedWork';
import { createEditor, refreshMermaidTheme } from './test-editor-factory';
import { editorViewportBounds } from '../webview/src/editor/editorViewportBounds';
import darkPlus from '@shikijs/themes/dark-plus';
import lightPlus from '@shikijs/themes/light-plus';
import { setShikiTheme, type RawVscodeTheme } from '../webview/src/helpers/shikiHighlighter';
import { applyUiTheme } from '../webview/src/helpers/uiTheme';
import { applyBuiltInVisualBaseline } from '../webview/src/helpers/theme';
import { createMermaidToolbarWidget } from '../webview/src/helpers/mermaidEditing';
import { createWidgetRemountProbe } from './widget-remount-test-helpers';

function applyCodeTheme(appearance: 'light' | 'dark'): void {
  const theme = (appearance === 'light' ? lightPlus : darkPlus) as RawVscodeTheme;
  setShikiTheme(theme);
  setShikiTheme(theme, 'source');
}

function refreshPresentation(editor: ReturnType<typeof createEditor>): void {
  editor.view.dispatch({ effects: StateEffect.define<true>().of(true) });
}

function createMermaidDerivedPointerProbe(parent: HTMLElement) {
  const editor = createEditor({
    parent, text: '```mermaid\nflowchart LR\nA --> B\n```\n\nplain',
    initialMode: 'live', onApplyChanges() {}
  });
  let refreshes = 0;
  let acceptedRuns = 0;
  let releaseSettlement = () => {};
  const acceptedKey = {};

  editor.view.dispatch({
    effects: StateEffect.appendConfig.of(EditorView.updateListener.of((update) => {
      refreshes += update.transactions.filter(isLiveInputDerivedWorkRefresh).length;
    }))
  });
  return {
    input() {
      refreshes = 0;
      editor.view.dispatch({
        changes: { from: editor.view.state.doc.length, insert: ' accepted' },
        annotations: Transaction.userEvent.of('input.type')
      });
    },
    holdSettlement() {
      const original = window.queueMicrotask;
      const callbacks: VoidFunction[] = [];
      window.queueMicrotask = callback => { callbacks.push(callback); };
      releaseSettlement = () => {
        window.queueMicrotask = original;
        callbacks.splice(0).forEach(callback => original(callback));
        releaseSettlement = () => {};
      };
    },
    releaseSettlement() { releaseSettlement(); },
    requestAccepted() { requestLiveInputDerivedWork(editor.view, acceptedKey, () => { acceptedRuns += 1; }); },
    announce() { editor.view.dispatch({ effects: EditorView.announce.of('Background presentation settled') }); },
    acceptsImmediately() {
      let ran = false;
      requestLiveInputDerivedWork(editor.view, {}, () => { ran = true; });
      return ran;
    },
    snapshot() {
      return { refreshes, acceptedRuns, pending: isLiveInputDerivedWorkPending(editor.view.state), text: editor.getText() };
    },
    destroy() { releaseSettlement(); editor.destroy(); }
  };
}

(globalThis as typeof globalThis & {
  MermaidEditingHarness?: {
    createEditor: typeof createEditor;
    createWidgetRemountProbe: typeof createWidgetRemountProbe;
    refreshPresentation: typeof refreshPresentation;
    usesLargeDocumentDerivedWorkBudget: typeof usesLargeDocumentDerivedWorkBudget;
      createMermaidDerivedPointerProbe: typeof createMermaidDerivedPointerProbe;
    refreshMermaidTheme: typeof refreshMermaidTheme;
    applyCodeTheme: typeof applyCodeTheme;
    editorViewportBounds: typeof editorViewportBounds;
    applyUiTheme: typeof applyUiTheme;
    applyBuiltInVisualBaseline: typeof applyBuiltInVisualBaseline;
    createMermaidToolbarWidget: typeof createMermaidToolbarWidget;
  };
}).MermaidEditingHarness = { createEditor, createWidgetRemountProbe, refreshPresentation, usesLargeDocumentDerivedWorkBudget, createMermaidDerivedPointerProbe, refreshMermaidTheme, applyCodeTheme, editorViewportBounds, applyUiTheme, applyBuiltInVisualBaseline, createMermaidToolbarWidget };
