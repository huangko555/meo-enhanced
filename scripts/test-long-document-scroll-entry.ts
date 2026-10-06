import '../webview/src/index';
import { EditorView } from '@codemirror/view';
import { getViewportController } from '../webview/src/helpers/viewportController';

(window as any).LongDocumentScrollHarness = { EditorView, getViewportController };
