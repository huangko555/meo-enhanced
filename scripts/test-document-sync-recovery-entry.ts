import { EditorView } from '@codemirror/view';
import '../webview/src/index';

(window as typeof window & { __EditorView?: typeof EditorView }).__EditorView = EditorView;
