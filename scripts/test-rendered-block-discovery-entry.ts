import { EditorState, StateEffect } from '@codemirror/state';
import { editorMarkdownLanguage } from '../webview/src/liveMode';
import { getLiveRenderedBlocks } from '../webview/src/helpers/liveRenderedBlocks';
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

(globalThis as any).RenderedBlockDiscoveryHarness = { run };
