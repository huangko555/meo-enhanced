import { EditorView } from '@codemirror/view';
import '../webview/src/index';

(window as any).__fontTestView = () => EditorView.findFromDOM(
  document.querySelector<HTMLElement>('.editor-host > .cm-editor')!
);

(window as any).__fontTestScrollToLine = (lineNumber: number) => {
  const view = (window as any).__fontTestView() as EditorView;
  view.scrollDOM.scrollTop = view.lineBlockAt(view.state.doc.line(lineNumber).from).top;
  view.requestMeasure();
};
