import { EditorView } from '@codemirror/view';
import './browser-page-identity-test-helpers';
import '../webview/src/index';

// Reach the real Source editor without adding test hooks to the product.
(window as typeof window & { __sourceMermaidEditor: () => EditorView }).__sourceMermaidEditor = () => {
  const element = document.querySelector<HTMLElement>('.editor-host .cm-editor');
  const view = element && EditorView.findFromDOM(element);
  if (!view) throw new Error('Source editor is not mounted');
  return view;
};
