import { forceParsing } from '@codemirror/language';
import { createEditor } from './test-editor-factory';
import { currentSyntaxTree } from '../webview/src/helpers/markdownSyntax';

(globalThis as any).ModeParserReuse = { createEditor, currentSyntaxTree, forceParsing };
