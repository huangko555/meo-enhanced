import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import * as tables from '../webview/src/helpers/tables';
import { editorMarkdownLanguage, liveModeExtensions } from '../webview/src/liveMode';
import { tableStickyHeaderAdapterFactoryFacet } from '../webview/src/editor/tableStickyHeaderAdapter';
import { tableCommandEnvironmentFacet } from '../webview/src/editor/tableCommandAdapter';

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

// Compensating whitespace can move a cell's source range while preserving
// normalized text, total length, and the table's content signature.
const stickyFactory = { create: () => ({ mount() {}, update() {}, invalidate() {}, unmount() {}, dispose() {} }) };
function tableWidget(text: string) {
  const state = EditorState.create({ doc: text, extensions: [
    tableCommandEnvironmentFacet.of({} as any), tableStickyHeaderAdapterFactoryFacet.of(stickyFactory), liveModeExtensions()
  ] });
  for (const set of state.facet(EditorView.decorations)) {
    if (typeof set === 'function') continue;
    for (const cursor = set.iter(); cursor.value; cursor.next()) {
      const widget = cursor.value.spec.widget;
      if (widget?.constructor.name === 'HtmlTableWidget') return widget as any;
    }
  }
  throw new Error('Table fixture must expose its rendered widget');
}
const prefix = 'Before\n\n| A | B |\n| --- | --- |\n';
const before = tableWidget(prefix + '| a | b |\n');
const unchanged = tableWidget(prefix + '| a | b |\n');
const moved = tableWidget(prefix + '|  a| b |\n');
assert.equal(before.tableData.signature, moved.tableData.signature);
assert.equal(before.tableData.from, moved.tableData.from);
assert.equal(before.tableData.to, moved.tableData.to);
assert.notDeepEqual(before.tableData.sourceRanges, moved.tableData.sourceRanges);
assert.equal(before.eq(unchanged), true, 'identical table source retains its widget');
assert.equal(before.eq(moved), false, 'changed source ranges must reach DOM reconciliation even when cell text is unchanged');
assert.equal(moved.eq(before), false, 'source coordinate invalidation must work in both directions');
console.log('Table equality distinguishes compensating whitespace without discarding identical source');
