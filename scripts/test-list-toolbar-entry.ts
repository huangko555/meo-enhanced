import './browser-page-identity-test-helpers';
import '../webview/src/index';
import { EditorSelection, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo, redo } from '@codemirror/commands';

(window as any).ListToolbarHarness = { EditorView, EditorSelection, Transaction, undo, redo };
