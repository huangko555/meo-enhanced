import { ensureSyntaxTree, forceParsing, syntaxTree } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';
import { assertBackgroundMarkdownPreparation, isBackgroundMarkdownPreparationPending, prepareBackgroundMarkdownPresentation } from './backgroundMarkdownStructure';
import { hasPreparedMarkdownStructure, isCompleteMarkdownStructure, markdownStructureAvailable, withMarkdownPreparationViewport } from './markdownStructure';
import { yieldForPresentation } from './presentationTask';

const PARSE_SLICE_MS = 8;
const PREPARATION_DEADLINE_MS = 10_000;

/** Layout/mode changes must not force every embedded language to finish after
 * structural preparation has already made the document ready to edit. */
export function refreshLiveSyntax(view: EditorView, bounded: boolean): void {
  if (!bounded) { forceParsing(view, view.state.doc.length, 500); return; }
  if (markdownStructureAvailable(view.state)) return;
  withMarkdownPreparationViewport(view.state, view.viewport, () => forceParsing(view, view.state.doc.length, PARSE_SLICE_MS));
}

/** Finish the shared parser while the old surface remains mounted. Installing
 * Live first would build a partial presentation and rebuild it on publication. */
export async function prepareLiveSyntax(view: EditorView, isCurrent: () => boolean): Promise<boolean> {
  const deadline = performance.now() + PREPARATION_DEADLINE_MS;
  while (isCurrent()) {
    const state = view.state;
    assertBackgroundMarkdownPreparation(state);
    const presentationReady = prepareBackgroundMarkdownPresentation(state);
    if (isBackgroundMarkdownPreparationPending(state) || !presentationReady) {
      if (performance.now() >= deadline) throw new Error('Live syntax preparation timed out');
      await new Promise(resolve => setTimeout(resolve, 16));
      continue;
    }
    if (isCompleteMarkdownStructure(syntaxTree(state), state.doc.length)) return true;
    withMarkdownPreparationViewport(state, view.viewport, () => {
      ensureSyntaxTree(state, state.doc.length, PARSE_SLICE_MS);
      // Avoid publishing every slice: Source subscribers would otherwise turn
      // preparation into repeated presentation and embedded-parser work.
      // Publishing must request the editing viewport. A second full-document
      // request would invalidate every deliberately skipped code range again.
      if (hasPreparedMarkdownStructure(state) || markdownStructureAvailable(state)) forceParsing(view, view.viewport.to, 0);
    });
    if (!isCurrent()) return false;
    // The outer Markdown tree owns complete document semantics. Embedded code
    // languages can finish on demand after the first editable Live surface.
    if (view.state.doc === state.doc && markdownStructureAvailable(view.state)) return true;
    if (performance.now() >= deadline) throw new Error('Live syntax preparation timed out');
    await yieldForPresentation();
  }
  return false;
}
