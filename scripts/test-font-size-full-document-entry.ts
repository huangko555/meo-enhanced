import { EditorView } from '@codemirror/view';
import '../webview/src/index';
import { getViewportController } from '../webview/src/helpers/viewportController';

(window as any).__fontTestView = () => EditorView.findFromDOM(
  document.querySelector<HTMLElement>('.editor-host > .cm-editor')!
);

(window as any).__fontTestScrollToLine = (lineNumber: number) => {
  const view = (window as any).__fontTestView() as EditorView;
  const controller = getViewportController(view);
  controller.revealPositionUntilStable(view.state.doc.line(lineNumber).from,
    { y: 'start', geometry: 'line-block' }, controller.beginNavigationReveal());
};

(window as any).__fontTestPreserveLayout = (mutate: () => void) => {
  const view = (window as any).__fontTestView() as EditorView;
  getViewportController(view).preserveDocumentAnchorWhileMutation(mutate, true);
};
