import { forceParsing } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { createEditor } from './test-editor-factory';
import { currentSyntaxTree } from '../webview/src/helpers/markdownSyntax';

// Keep CodeMirror's projection representation inside the test-owned measuring seam.
// The driver receives only a before/after work observation, never a DecorationSet.
function captureLiveProjectionWork(editor: ReturnType<typeof createEditor>): () => boolean {
  const current = () => editor.view.state.facet(EditorView.decorations).find((source) => {
    if (typeof source === 'function') return false;
    let heading = false;
    source.between(0, 10, (_from, _to, value) => {
      if (value.spec.class === 'meo-md-h1') heading = true;
    });
    return heading;
  });
  const before = current();
  if (!before) throw Error('Live heading projection is missing');
  return () => current() !== before;
}

(globalThis as any).ModeParserReuse = { createEditor, currentSyntaxTree, forceParsing, captureLiveProjectionWork };
