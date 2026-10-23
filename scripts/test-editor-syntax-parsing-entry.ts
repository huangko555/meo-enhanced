import { preparedMarkdownStructure, isCompleteMarkdownStructure } from '../webview/src/editor/markdownStructure';
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

function preparedStructure(editor: ReturnType<typeof createEditor>) {
  const state = editor.view.state, tree = preparedMarkdownStructure(state) ?? currentSyntaxTree(state);
  const nodes: Array<{ name: string; from: number; to: number }> = [];
  tree.iterate({ enter(node) { if (node.name === 'Table' || node.name === 'FencedCode' || node.name === 'HTMLBlock')
    nodes.push({ name: node.name, from: node.from, to: node.to }); } });
  return { complete: isCompleteMarkdownStructure(tree, state.doc.length), length: tree.length, nodes };
}

(globalThis as typeof globalThis & {
  EditorSyntaxParsingHarness?: {
    createEditor: typeof createEditor;
    publishedNodeNamesAt: typeof publishedNodeNamesAt;
    preparedStructure: typeof preparedStructure;
  };
}).EditorSyntaxParsingHarness = { createEditor, publishedNodeNamesAt, preparedStructure };
