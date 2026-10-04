import { findDocumentFragmentPosition } from '../webview/src/helpers/linkNavigation';
import { createEditor } from './test-editor-factory';
import { handleEditorShortcut } from '../webview/src/helpers/shortcuts';
import { EditorState, StateEffect, EditorSelection } from '@codemirror/state';
import { parseHtmlTableClipboard } from '../webview/src/editor/tableClipboard';
import { clipboardHtmlToMarkdown } from '../webview/src/editor/htmlPaste';
import { parseDelimitedTable, serializeDelimitedTable, markdownTableFromCells, parseMarkdownTable } from '../webview/src/application/delimitedTable';
(window as any).EditingFeaturesHarness = { createEditor, EditorState, StateEffect, handleEditorShortcut, EditorSelection, findDocumentFragmentPosition, parseHtmlTableClipboard, clipboardHtmlToMarkdown, parseDelimitedTable, serializeDelimitedTable, markdownTableFromCells, parseMarkdownTable };
