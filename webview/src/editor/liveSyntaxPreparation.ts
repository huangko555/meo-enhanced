import { ensureSyntaxTree, forceParsing, syntaxTreeAvailable } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';

const PARSE_SLICE_MS = 8;
const PREPARATION_DEADLINE_MS = 10_000;

function yieldForPresentation(): Promise<void> {
  return new Promise(resolve => {
    let frame: number | null = null;
    const finish = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      clearTimeout(fallback);
      resolve();
    };
    // Hidden Webviews can receive mode intents too. Let cancellation complete
    // even when the browser suspends their animation frames.
    const fallback = setTimeout(finish, 50);
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish); });
  });
}

/** Finish the shared parser while the old surface remains mounted. Installing
 * Live first would build a partial presentation and rebuild it on publication. */
export async function prepareLiveSyntax(view: EditorView, isCurrent: () => boolean): Promise<boolean> {
  const deadline = performance.now() + PREPARATION_DEADLINE_MS;
  while (isCurrent()) {
    const state = view.state;
    const tree = ensureSyntaxTree(state, state.doc.length, PARSE_SLICE_MS);
    if (!isCurrent()) return false;
    if (tree && syntaxTreeAvailable(state, state.doc.length)) {
      // Publish once before Live StateFields are installed. Both modes retain
      // this same language, so reconfiguration can reuse its completed parse.
      forceParsing(view, state.doc.length, 0);
      if (isCurrent() && view.state.doc === state.doc
        && syntaxTreeAvailable(view.state, view.state.doc.length)) return true;
    }
    if (performance.now() >= deadline) throw new Error('Live syntax preparation timed out');
    await yieldForPresentation();
  }
  return false;
}
