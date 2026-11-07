import './browser-page-identity-test-helpers';
import '../webview/src/index';
import { EditorView } from '@codemirror/view';
import { applyUiTheme } from '../webview/src/helpers/uiTheme';

// Keep test setup and line observation behind a narrow adapter; never expose
// the editor or the syntax runtime to browser assertions.
const currentView = () => EditorView.findFromDOM(document.querySelector('.cm-editor')!)!;
(window as any).ThemeAcceptance = {
  refreshUiTheme() { applyUiTheme('dark', true); },
  replaceText(text: string, caret: 'start' | 'end' = 'start') {
    const view = currentView();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: caret === 'end' ? text.length : 0 }, scrollIntoView: true });
  },
  lineIndex(element: HTMLElement) {
    const view = currentView();
    return view.state.doc.lineAt(view.posAtDOM(element)).number - 1;
  },
  focusEnd() {
    const view = currentView();
    view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
    view.focus();
  }
};
