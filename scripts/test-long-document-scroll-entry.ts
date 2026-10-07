import '../webview/src/index';
import { EditorView } from '@codemirror/view';
import { isolateHistory, redo, undo } from '@codemirror/commands';
import { getViewportController } from '../webview/src/helpers/viewportController';

(window as any).LongDocumentScrollHarness = { EditorView, getViewportController, isolateHistory, redo, undo };
