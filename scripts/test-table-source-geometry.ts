import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import * as tables from '../webview/src/helpers/tables';
import { editorMarkdownLanguage } from '../webview/src/liveMode';

const detailed = tables.parseTableInfo;
let detailedCalls = 0;
mock.module('../webview/src/helpers/tables', () => ({ ...tables,
  parseTableInfo: (...args: Parameters<typeof detailed>) => { detailedCalls++; return detailed(...args); }
}));
const { getLiveRenderedBlocks } = await import('../webview/src/helpers/liveRenderedBlocks');

const examples = [
  '| A | B |\n| --- | ---: |\n| **one** | `two` |',
  '> | A | B |\n> | --- | --- |\n> | one | two |',
  '- item\n\n  | A | B |\n  | --- | --- |\n  | one | two |',
  '> - item\n>\n>   | A | B |\n>   | --- | --- |\n>   | one | two |',
  '| Single |\n| --- |\n| one |\n| two |',
  'A | B\n--- | ---\none | two',
  'Reference[^n].\n\n[^n]: Note\n\n    | A | B |\n    | --- | --- |\n    | one | two |'
];
const text = [...examples, ...Array.from({ length: 100 }, (_, i) =>
  `| Value ${i} | Rich |\n| --- | --- |\n| [label](https://example.test/${i}) | **bold** and \u0060code\u0060 |\n| $x^2$ | plain |`)].join('\n\n');
let state = EditorState.create({ doc: text, extensions: editorMarkdownLanguage });
ensureSyntaxTree(state, state.doc.length, 10_000);
state = state.update({}).state;
const expected: Array<{ startLine: number; endLine: number; delimiterLine: number | null }> = [];
syntaxTree(state).iterate({ enter(node) {
  if (node.name !== 'Table') return;
  const info = detailed(state, node);
  expected.push({ startLine: info.startLine, endLine: info.endLine, delimiterLine: info.delimiterRow?.lineNo ?? null });
  return false;
} });
assert.ok(expected.length >= 105, 'nested and rich table fixtures must be recognized');
detailedCalls = 0;
const actual = getLiveRenderedBlocks(state).filter(block => block.kind === 'table');
assert.equal(detailedCalls, 0, 'global geometry readers must not construct detailed cell models for offscreen tables');
assert.deepEqual(actual.map(({ startLine, endLine, delimiterLine }) => ({ startLine, endLine, delimiterLine })), expected,
  'lightweight geometry must match the authoritative table content model, including nested containers and footnotes');
console.log(`Table geometry preserves ${expected.length} source ranges without constructing cell models`);
