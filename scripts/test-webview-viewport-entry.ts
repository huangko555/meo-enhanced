import '../webview/src/index';
import { EditorView } from '@codemirror/view';
import { getViewportController } from '../webview/src/helpers/viewportController';
import { createChangesReviewControl } from '../webview/src/adapters/changesReviewControl';
import { usesLargeDocumentDerivedWorkBudget } from '../webview/src/editor/liveInputDerivedWork';
import { getGitDiffSummary } from '../webview/src/helpers/gitDiffGutter';

(window as any).__viewportTestChangesReviewControl = createChangesReviewControl;
(window as any).__viewportTestLargeBudget = () => usesLargeDocumentDerivedWorkBudget(EditorView.findFromDOM(
  document.querySelector<HTMLElement>('.editor-host > .cm-editor')!
)!.state);
(window as any).__viewportTestGitDiffSummary = () => getGitDiffSummary(EditorView.findFromDOM(
  document.querySelector<HTMLElement>('.editor-host > .cm-editor')!
)!.state);

(window as any).__viewportTestText = () => EditorView.findFromDOM(
  document.querySelector<HTMLElement>('.editor-host > .cm-editor')!
)!.state.doc.toString();

(window as any).__viewportTestRetainReadingLine = async (text: string, top: number) => {
  const view = EditorView.findFromDOM(document.querySelector<HTMLElement>('.editor-host > .cm-editor')!)!;
  const position = view.state.doc.toString().indexOf(text);
  const line = Array.from(view.contentDOM.querySelectorAll<HTMLElement>('.cm-line'))
    .find(line => line.textContent === text);
  const coords = position >= 0 ? view.coordsAtPos(position) : null;
  if (!line || !coords) throw new Error('Reading navigation requires a rendered source line');
  const controller = getViewportController(view);
  controller.retainPositionTop(position, top + coords.top - line.getBoundingClientRect().top,
    controller.beginNavigationReveal());
  for (let frame = 0; frame < 12; frame++) await new Promise(requestAnimationFrame);
};
