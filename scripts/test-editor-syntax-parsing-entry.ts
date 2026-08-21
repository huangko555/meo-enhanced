import { createEditor } from './test-editor-factory';
import { currentSyntaxTree } from '../webview/src/helpers/markdownSyntax';

function publishedNodeNamesAt(editor: ReturnType<typeof createEditor>, position: number): string[] {
  const names: string[] = [];
  let node = currentSyntaxTree(editor.view.state).resolveInner(position, 1);
  while (node) {
    names.push(node.name);
    node = node.parent;
  }
  return names;
}

(globalThis as typeof globalThis & {
  EditorSyntaxParsingHarness?: {
    createEditor: typeof createEditor;
    publishedNodeNamesAt: typeof publishedNodeNamesAt;
  };
}).EditorSyntaxParsingHarness = { createEditor, publishedNodeNamesAt };
