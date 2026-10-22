import { EditorState, StateEffect } from '@codemirror/state';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { TreeCursor } from '@lezer/common';
import type { MarkdownParser } from '@lezer/markdown';
import { editorMarkdownLanguage } from '../webview/src/liveMode';
import { getLiveRenderedBlocks, prepareLiveBlockContext } from '../webview/src/helpers/liveRenderedBlocks';
import { inlineMarkdownExtensions } from '../webview/src/helpers/inlineMarkdownParser';
import { htmlEditingRangeField, setHtmlEditingRangeEffect } from '../webview/src/helpers/htmlContent';

function run() {
  const text = '# Heading\n\n$$\na+b\n$$\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n<div>\nHTML body\n</div>\n\n```mermaid\ngraph LR\n A-->B\n```';
  let state = EditorState.create({ doc: text, extensions: [editorMarkdownLanguage, htmlEditingRangeField] });
  const samples: Array<{ phase: string; scans: number; kinds: string[] }> = [];
  const read = (phase: string, includeSelectedMath = false) => {
    (globalThis as any).__mathScans = 0;
    const blocks = getLiveRenderedBlocks(state, { includeSelectedMath });
    samples.push({ phase, scans: (globalThis as any).__mathScans, kinds: blocks.map(block => block.kind) });
  };
  read('initial');
  state = state.update({ selection: { anchor: text.indexOf('a+b') } }).state;
  read('inside-math');
  read('include-selected-math', true);
  state = state.update({ selection: { anchor: 0 } }).state;
  read('outside-math');
  state = state.update({ effects: setHtmlEditingRangeEffect.of({ from: text.indexOf('<div>'), to: text.indexOf('</div>') + 6 }) }).state;
  read('editing-html');
  state = state.update({ effects: setHtmlEditingRangeEffect.of(null) }).state;
  read('rendering-html');
  state = state.update({ effects: StateEffect.reconfigure.of([htmlEditingRangeField]) }).state;
  read('changed-parse');
  state = state.update({ effects: StateEffect.reconfigure.of([editorMarkdownLanguage, htmlEditingRangeField]) }).state;
  read('restored-parse');
  state = state.update({ changes: { from: 0, insert: '```text\n' } }).state;
  read('changed-document');
  return samples;
}

function fallbackBudget() {
  const example = '```text\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```\n\n'
    + '> ```text\n> | A | B |\n> | --- | --- |\n> | 1 | 2 |\n> ```\n\n'
    + '    Literal code:\n    | A | B |\n    | --- | --- |\n    | 1 | 2 |\n\n';
  const real = '| Real | Table |\n| --- | --- |\n| Value | 2 |\n\n';
  const doc = (example + real).repeat(400);
  const state = EditorState.create({ doc });
  const parser = (markdownLanguage.parser as MarkdownParser).configure(inlineMarkdownExtensions);
  const tree = parser.parse(doc);
  let seeks = 0;
  const original = TreeCursor.prototype.moveTo;
  TreeCursor.prototype.moveTo = function (...args) { seeks++; return original.apply(this, args); };
  try {
    const blocks = prepareLiveBlockContext(state, tree);
    const tables = blocks.filter(({ block }) => block.kind === 'table');
    return { seeks, tables: tables.length, starts: tables.map(({ block }) => block.startLine),
      expected: Array.from({ length: 400 }, (_, index) => example.split('\n').length + index * ((example + real).split('\n').length - 1)) };
  } finally { TreeCursor.prototype.moveTo = original; }
}

(globalThis as any).RenderedBlockDiscoveryHarness = { run, fallbackBudget };
