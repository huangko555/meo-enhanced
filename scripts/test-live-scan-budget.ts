import assert from 'node:assert/strict';
import { EditorState, StateEffect, Text, Transaction } from '@codemirror/state';
import { editorMarkdownLanguage, liveModeExtensions, refreshLiveDecorationsAfterSearchEffect, setLiveDocumentIdleEffect, setLivePointerSelectionActiveEffect } from '../webview/src/liveMode';
import { ensureSyntaxTree } from '@codemirror/language';
import { parseFootnotes } from '../webview/src/helpers/footnotes';
import { parseFrontmatter } from '../webview/src/helpers/frontmatter';
import { documentLines } from '../webview/src/helpers/documentLines';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { mapStableLiveDecorations } from '../webview/src/editor/liveWidgetPositions';
import { hasSameLiveMarkdownSyntax, hasSameLiveMarkdownOutsideBlock } from '../webview/src/helpers/livePresentationSyntax';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { parseMixed, Tree } from '@lezer/common';
import { javascriptLanguage } from '@codemirror/lang-javascript';
import { imagePresentationFactoryFacet, type ImagePresentationFactory } from '../webview/src/editor/imagePresentation';
import { longCodeBlockSessionUiExtension } from '../webview/src/helpers/longCodeBlocks';

{
  const text = 'EDIT\n\n' + '```json\n{ "value": 1 }\n```\n\n'.repeat(600);
  let state = EditorState.create({ doc: text, extensions: [editorMarkdownLanguage, longCodeBlockSessionUiExtension()] });
  ensureSyntaxTree(state, state.doc.length, 2_000);
  state = state.update({}).state;
  const read = Text.prototype.line;
  let calls = 0;
  Text.prototype.line = function(number: number) { calls++; return read.call(this, number); };
  try {
    state = state.update({ selection: { anchor: 2 } }).state;
    state = state.update({ effects: StateEffect.define<boolean>().of(true) }).state;
  } finally { Text.prototype.line = read; }
  assert.ok(calls < 50, `unchanged code block session UI must not rediscover all fences on caret/effect transactions (${calls} reads)`);
}

{
  const text = '```js\nlet value = 1;\n```\n\n**Paragraph** and reference[^note].\n\n[^note]: Definition.\n';
  const plain = markdownLanguage.parser.parse(text);
  const mixed = markdownLanguage.parser.configure({ wrap: parseMixed(node => node.name === 'CodeText'
    ? { parser: javascriptLanguage.parser } : null) }).parse(text);
  assert.notEqual(plain.toString(), mixed.toString(), 'the fixture must include completed embedded language syntax');
  assert.ok(hasSameLiveMarkdownSyntax(plain, mixed), 'embedded code parsing must not invalidate identical outer Markdown presentation');
  assert.equal(hasSameLiveMarkdownSyntax(plain, markdownLanguage.parser.parse(text.replace('**Paragraph**', 'Plain content'))), false,
    'actual Markdown structure changes must not be certified by embedded-language equivalence');
  assert.equal(hasSameLiveMarkdownSyntax(plain, markdownLanguage.parser.parse(text.slice(0, 24))), false,
    'an unfinished outer Markdown tree must not certify complete presentation');
  const missingTail = new Tree(plain.type, plain.children.slice(0, 1), plain.positions.slice(0, 1), plain.length);
  assert.equal(hasSameLiveMarkdownSyntax(missingTail, mixed), false,
    'matching document length must not hide unparsed paragraphs or late references outside embedded code');
  const edit = EditorState.create({ doc: text }).update({ changes: { from: text.indexOf('value'), insert: 'x' } });
  const changed = markdownLanguage.parser.parse(edit.newDoc.toString());
  const code = plain.topNode.firstChild!, changedCode = changed.topNode.firstChild!;
  assert.ok(hasSameLiveMarkdownOutsideBlock(plain, changed, edit.changes, code, changedCode));
  const changedMissingTail = new Tree(changed.type, changed.children.slice(0, 1), changed.positions.slice(0, 1), changed.length);
  assert.equal(hasSameLiveMarkdownOutsideBlock(plain, changedMissingTail, edit.changes, code, changedCode), false,
    'an inline edit must not certify missing Markdown outside its block even when document lengths match');
}

{
  const text = '**Filler**\n\n'.repeat(80_000) + 'Late reference[^late].\n\n[^late]: Definition.';
  const state = EditorState.create({ doc: text, extensions: editorMarkdownLanguage });
  parseFootnotes(state);
  assert.ok(ensureSyntaxTree(state, state.doc.length, 2_000), 'the late-footnote fixture must finish parsing');
  const complete = parseFootnotes(state);
  assert.equal(complete.references.length, 1, 'publishing the complete tree must invalidate a partial footnote cache for the same text');
  assert.equal(complete.references[0].definition?.label, 'late');
}

// Cover empty/final lines, text-tree branch boundaries and UTF-16 positions.
for (const text of ['', '\n', 'a\n', '\n\n', '汉字\n😀\nlast',
  Array.from({ length: 4_097 }, (_, index) => index % 7 ? `line ${index} 😀` : '').join('\n')]) {
  const document = EditorState.create({ doc: text }).doc;
  const actual = [...documentLines(document)];
  assert.equal(actual.length, document.lines);
  for (const line of actual) {
    const expected = document.line(line.number);
    assert.deepEqual(line, { from: expected.from, to: expected.to, number: expected.number,
      text: expected.text, length: expected.length });
  }
}

// A plain document still exercises Live's HTML, list, table, tag and conflict
// fallbacks. Count random line lookups rather than imposing machine-speed limits.
const original = 'Plain paragraph with ordinary words.\n\n'.repeat(2_500) + 'EDIT';
const readLine = Text.prototype.line;
let lookups = 0;
Text.prototype.line = function(number: number) {
  lookups += 1;
  return readLine.call(this, number);
};
try {
  let state = EditorState.create({
    doc: original,
    extensions: liveModeExtensions({ largeDocument: true })
  });
  state = state.update({
    changes: { from: original.length, insert: 'x' },
    annotations: Transaction.userEvent.of('input.type')
  }).state;
  lookups = 0;
  state = state.update({
    changes: { from: original.length, to: original.length + 1 },
    annotations: Transaction.userEvent.of('undo')
  }).state;
  assert.equal(state.doc.toString(), original, 'history must restore the exact text');
  console.log(`Live plain-text undo: ${lookups} random line lookups for ${state.doc.lines} lines`);
  assert.ok(lookups < state.doc.lines * 2,
    'whole-document fallbacks must traverse text sequentially instead of repeatedly seeking every line');
} finally {
  Text.prototype.line = readLine;
}

const checkpointText = 'EDIT\n\n' + '**Formatted paragraph**\n\n'.repeat(500);
const mainDecorations = (state: EditorState): DecorationSet => state.facet(EditorView.decorations)
  .filter((value): value is DecorationSet => typeof value !== 'function')
  .sort((left, right) => right.size - left.size)[0];
let checkpointState = EditorState.create({ doc: checkpointText, selection: { anchor: 4 },
  extensions: liveModeExtensions({ largeDocument: true }) });
const beforeInput = mainDecorations(checkpointState);
for (let index = 0; index < 5; index += 1) {
  checkpointState = checkpointState.update({ changes: { from: 4 + index, insert: 'x' },
    selection: { anchor: 5 + index }, annotations: Transaction.userEvent.of('input.type') }).state;
}
checkpointState = checkpointState.update({ changes: { from: 4, to: 9 }, selection: { anchor: 4 },
  annotations: Transaction.userEvent.of('undo') }).state;
assert.equal(checkpointState.doc.toString(), checkpointText);
assert.equal(mainDecorations(checkpointState), beforeInput,
  'undoing plain prose to the exact text and selection must reuse its complete Live presentation');

const unrelatedEffect = StateEffect.define<boolean>();
for (const invalidation of ['selection', 'effect', 'presentation', 'reconfigure', 'syntax', 'external', 'small'] as const) {
  let state = EditorState.create({ doc: checkpointText, selection: { anchor: 4 },
    extensions: liveModeExtensions({ largeDocument: invalidation !== 'small' }) });
  const initial = mainDecorations(state);
  const inserted = invalidation === 'syntax' ? '*' : 'x';
  state = state.update({ changes: { from: 4, insert: inserted }, selection: { anchor: 5 },
    annotations: invalidation === 'external' ? [] : Transaction.userEvent.of('input.type') }).state;
  if (invalidation === 'selection') {
    state = state.update({ selection: { anchor: 0 } }).state;
    state = state.update({ selection: { anchor: 5 } }).state;
  } else if (invalidation === 'effect') {
    state = state.update({ effects: unrelatedEffect.of(true) }).state;
  } else if (invalidation === 'presentation') {
    state = state.update({ effects: setLiveDocumentIdleEffect.of(true) }).state;
  } else if (invalidation === 'reconfigure') {
    state = state.update({ effects: StateEffect.appendConfig.of(EditorState.tabSize.of(8)) }).state;
  }
  state = state.update({ changes: { from: 4, to: 5 }, selection: { anchor: 4 },
    annotations: Transaction.userEvent.of('undo') }).state;
  assert.equal(state.doc.toString(), checkpointText);
  assert.notEqual(mainDecorations(state), initial, `${invalidation}: rebuild instead of restoring an inapplicable checkpoint`);
}
console.log('Live history checkpoints preserve exact text/selection and reject changed presentation contexts');

const decorationShape = (set: DecorationSet) => {
  const ranges: unknown[] = [];
  for (const cursor = set.iter(); cursor.value; cursor.next()) {
    const spec = cursor.value.spec;
    ranges.push([cursor.from, cursor.to, spec.class, spec.attributes, spec.block, spec.widget?.constructor.name]);
  }
  return ranges;
};
const prosePrefix = '**Prefix formatting**\n\n' + 'Ordinary filler.\n\n'.repeat(100);
for (const paragraph of ['Plain prose', '中文正文', 'NATIVE_EDIT_TARGET', 'Sentence with punctuation.', 'Two lines\nPlain second line']) {
  const text = prosePrefix + paragraph;
  for (const operation of ['insert', 'delete', 'space'] as const) {
    const from = operation === 'delete'
      ? prosePrefix.length + paragraph.search(/[\p{L}\p{N}][^\p{L}\p{N}]*$/u) : text.length;
    const to = operation === 'delete' ? from + 1 : from;
    const insert = operation === 'delete' ? '' : operation === 'space' ? ' ' : 'x';
    const state = EditorState.create({ doc: text, selection: { anchor: to }, extensions: liveModeExtensions({ largeDocument: true }) });
    const next = state.update({ changes: { from, to, insert }, selection: { anchor: from + insert.length },
      annotations: Transaction.userEvent.of('input.type') }).state;
    const fresh = EditorState.create({ doc: next.doc, selection: next.selection, extensions: liveModeExtensions({ largeDocument: true }) });
    assert.deepEqual(decorationShape(mainDecorations(next)), decorationShape(mainDecorations(fresh)),
      `${paragraph}/${operation}: the input frame must match a fresh authoritative presentation`);
    const positioned = next.update({ selection: { anchor: next.selection.main.head - 1 } }).state;
    assert.equal(mainDecorations(positioned), mainDecorations(next), 'same-line plain caret navigation must reuse the full presentation');
  }
}
for (const paragraph of ['plain $raw', 'plain #tag', 'plain file:///tmp/example', 'plain | table', '[^unclosed', 'x'.repeat(4_100)]) {
  const text = prosePrefix + paragraph;
  const state = EditorState.create({ doc: text, selection: { anchor: text.length }, extensions: liveModeExtensions({ largeDocument: true }) });
  const next = state.update({ changes: { from: text.length, insert: 'x' }, selection: { anchor: text.length + 1 },
    annotations: Transaction.userEvent.of('input.type') }).state;
  const full = next.update({ effects: refreshLiveDecorationsAfterSearchEffect.of(true) }).state;
  assert.deepEqual(decorationShape(mainDecorations(next)), decorationShape(mainDecorations(full)),
    'local inline input must rebuild raw helper presentation from the complete Markdown context');
}
for (const paragraph of ['<div>unclosed', 'x'.repeat(32_769)]) {
  const text = prosePrefix + paragraph;
  const state = EditorState.create({ doc: text, selection: { anchor: text.length }, extensions: liveModeExtensions({ largeDocument: true }) });
  const next = state.update({ changes: { from: text.length, insert: 'x' }, selection: { anchor: text.length + 1 },
    annotations: Transaction.userEvent.of('input.type') }).state;
  assert.ok(mainDecorations(next).size < mainDecorations(state).size,
    'raw helper syntax and oversized paragraphs must keep the bounded fallback path');
}
{
  const text = prosePrefix + 'Plain middle paragraph.\n\n**Later formatting**\n\n[local](sample.md)\n\n$$\nx^2\n$$';
  const state = EditorState.create({ doc: text, selection: { anchor: prosePrefix.length + 2 },
    extensions: liveModeExtensions({ largeDocument: true }) });
  const next = state.update({ selection: { anchor: prosePrefix.length + 3 } }).state;
  const fresh = EditorState.create({ doc: next.doc, selection: next.selection,
    extensions: liveModeExtensions({ largeDocument: true }) });
  assert.equal(mainDecorations(next), mainDecorations(state), 'plain caret navigation must preserve later rich blocks');
  assert.deepEqual(decorationShape(mainDecorations(next)), decorationShape(mainDecorations(fresh)),
    'middle paragraph caret navigation must match a fresh authoritative presentation');
}
console.log('Inline input matches full builds; definitions, HTML and oversized blocks retain conservative refresh');

{
  const text = '# Heading **bold**\n\nBody *italic* with a [**link**](sample.md).\n\nSecond heading\n---\n\n'
    + 'More ~~strike~~ ==highlight== `literal # $ []` and H~2~ x^2^.\n\n<https://example.com>\n\n'
    + '- List **item**\n- [ ] Checklist\n\n> Quoted **body**\n> second line\n\n1. Ordered *item*\n2. next\n\n'
    + ('## Distant **heading**\n\nParagraph *with* `code`.\n\n').repeat(600)
    + '[Distant link](far.md)';
  let state = EditorState.create({ doc: text, selection: { anchor: text.indexOf('Body') + 2 },
    extensions: liveModeExtensions({ largeDocument: true }) });
  ensureSyntaxTree(state, state.doc.length, 2_000);
  state = state.update({}).state;
  for (const position of [2, text.indexOf('Body') + 5, text.indexOf('Second heading') + 2, text.indexOf('More') + 2,
    text.indexOf('https') + 4, text.indexOf('List') + 2, text.indexOf('Checklist') + 2, text.indexOf('Quoted') + 2,
    text.indexOf('Ordered') + 2, text.indexOf('\n\n') + 1]) {
    const read = Text.prototype.line;
    let calls = 0;
    Text.prototype.line = function(number: number) { calls++; return read.call(this, number); };
    try {
      state = state.update({ effects: setLivePointerSelectionActiveEffect.of({ active: true, preservedLine: null }) }).state;
      state = state.update({ selection: { anchor: position } }).state;
      state = state.update({ effects: setLivePointerSelectionActiveEffect.of({ active: false, preservedLine: null }) }).state;
    } finally { Text.prototype.line = read; }
    assert.ok(calls < 200, `collapsed pointer selection must update nearby presentation instead of the whole document (${calls} line reads)`);
    const fresh = EditorState.create({ doc: state.doc, selection: state.selection, extensions: liveModeExtensions({ largeDocument: true }) });
    assert.deepEqual(decorationShape(mainDecorations(state)), decorationShape(mainDecorations(fresh)),
      'pointer selection must retain authoritative formatting and distant widgets');
  }
}
console.log('Live pointer selection keeps local work bounded and matches complete presentation');

{
  const text = '---\ntitle: Example\naliases: [one, two]\ndraft: false\nhomepage: https://example.com\nvalue: "`code`"\n---\n\n# Body\n\n'
    + '## Distant **heading**\n\n'.repeat(600);
  let state = EditorState.create({ doc: text, selection: { anchor: text.indexOf('title:') + 2 },
    extensions: liveModeExtensions({ largeDocument: true }) });
  ensureSyntaxTree(state, state.doc.length, 2_000);
  state = state.update({}).state;
  assert.ok(parseFrontmatter(state), 'the frontmatter projection fixture must contain valid YAML');
  for (const position of [text.indexOf('draft:') + 2, text.indexOf('aliases:') + 2, 1,
    text.indexOf('value:') + 2, text.indexOf('# Body') + 2, text.lastIndexOf('---') + 1]) {
    for (const spec of [
      { effects: setLivePointerSelectionActiveEffect.of({ active: true, preservedLine: null }) },
      { selection: { anchor: position } },
      { effects: setLivePointerSelectionActiveEffect.of({ active: false, preservedLine: null }) }
    ]) {
      const read = Text.prototype.line;
      let calls = 0;
      Text.prototype.line = function(number: number) { calls++; return read.call(this, number); };
      try { state = state.update(spec).state; } finally { Text.prototype.line = read; }
      assert.ok(calls < 300, `frontmatter caret work must stay local (${calls} line reads)`);
      const authoritative = state.update({ effects: refreshLiveDecorationsAfterSearchEffect.of(true) }).state;
      assert.deepEqual(decorationShape(mainDecorations(state)), decorationShape(mainDecorations(authoritative)),
        'frontmatter pointer phases must preserve array pills, boundary labels, URLs and inline style ordering');
    }
  }
}
console.log('Frontmatter pointer phases match authoritative presentation with bounded local work');

{
  const block = '## Section\n\nParagraph with an image ![shape](shape.svg), $x^2$, <kbd>Ctrl</kbd>, #aabbcc and a footnote[^n].\n\n'
    + '1. Parent\n   - Child **bold**\n\n   ```json\n   { "value": 1 }\n   ```\n\n> [!NOTE]\n> Quoted *text*.\n\n'
    + '```math\nx^2 + y^2\n```\n\nAfter formula.\n\n';
  const text = block.repeat(200) + '\n[^n]: Definition with **formatting**.\n\n    Continued paragraph.\n';
  const images: ImagePresentationFactory = { acquire: () => () => {}, preload: async () => {}, getIntrinsicSize: () => null,
    create() { throw new Error('State-only presentation checks must not mount image DOM'); },
    whenVisiblePresentationsSettle: async () => {}, externalDocumentPresented() {}, dispose() {} };
  let state = EditorState.create({ doc: text, extensions: [liveModeExtensions({ largeDocument: true }), imagePresentationFactoryFacet.of(images)] });
  ensureSyntaxTree(state, state.doc.length, 2_000);
  state = state.update({ effects: refreshLiveDecorationsAfterSearchEffect.of(true) }).state;
  let placeholders = 0, controls = 0;
  for (const cursor = mainDecorations(state).iter(); cursor.value; cursor.next()) {
    const widget = cursor.value.spec.widget;
    if (!widget) continue;
    if (widget.constructor.name === 'ViewportWidgetPlaceholder') placeholders++;
    else controls++;
  }
  assert.ok(placeholders > 500 && controls < 300,
    `large documents must retain offscreen source/height without thousands of UI instances (${placeholders}/${controls})`);
  for (const target of ['Child', '"value"', 'image', 'Quoted', 'x^2 +', 'After formula', 'Definition', 'Continued', '\n\n']) {
    const position = text.indexOf(target, target === 'Definition' || target === 'Continued' ? 0 : block.length * 99)
      + (target === '\n\n' ? 1 : 2);
    for (const spec of [
      { effects: setLivePointerSelectionActiveEffect.of({ active: true, preservedLine: null }) },
      { selection: { anchor: position } },
      { effects: setLivePointerSelectionActiveEffect.of({ active: false, preservedLine: null }) }
    ]) {
      const read = Text.prototype.line;
      let calls = 0;
      Text.prototype.line = function(number: number) { calls++; return read.call(this, number); };
      try { state = state.update(spec).state; } finally { Text.prototype.line = read; }
      assert.ok(calls < 1_000, `${target}: rich pointer work must not traverse distant document lines (${calls} reads)`);
      const authoritative = state.update({ effects: refreshLiveDecorationsAfterSearchEffect.of(true) }).state;
      assert.deepEqual(decorationShape(mainDecorations(state)), decorationShape(mainDecorations(authoritative)),
        `${target}: local rich presentation must match a complete rebuild in every pointer phase`);
    }
  }
}
console.log('Rich Live caret invalidation preserves complete presentation with local work');

{
  const text = 'First[^a][^b] and repeated[^a].\n\nOrdinary **body**.\n\n'
    + '[^a]: Definition paragraph.\n\n    Continued paragraph.\n\n    - Nested item.\n\n'
    + '[^b]: Other definition.\n';
  for (const position of [text.indexOf('Definition') + 3, text.indexOf('paragraph.') + 'paragraph.'.length,
    text.indexOf('Continued') + 3, text.indexOf('Nested') + 3, text.indexOf('][^b]') + 1,
    text.indexOf('body') + 2, text.indexOf('[^a]') + 2]) {
    let state = EditorState.create({ doc: text, selection: { anchor: position }, extensions: liveModeExtensions({ largeDocument: true }) });
    ensureSyntaxTree(state, state.doc.length, 2_000);
    state = state.update({ effects: refreshLiveDecorationsAfterSearchEffect.of(true) }).state;
    const next = state.update({ changes: { from: position, insert: 'x' }, selection: { anchor: position + 1 },
      annotations: Transaction.userEvent.of('input.type') }).state;
    // A new Text identity prevents an incorrect projected cache from becoming
    // its own reference result during a forced presentation refresh.
    const fresh = EditorState.create({ doc: next.doc.toString(), extensions: editorMarkdownLanguage });
    ensureSyntaxTree(fresh, fresh.doc.length, 2_000);
    assert.deepEqual(parseFootnotes(next), parseFootnotes(fresh), 'inline footnote projection must match independent source parsing');
  }
}

{
  const prefix = '**Prefix formatting**\n\nPlain middle paragraph';
  const text = prefix + '\n\n' + 'Ordinary filler.\n\n'.repeat(2_500) + '**Later formatting**\n\n[local](sample.md)';
  const state = EditorState.create({ doc: text, selection: { anchor: prefix.length },
    extensions: liveModeExtensions({ largeDocument: true }) }).update({}).state;
  const next = state.update({ changes: { from: prefix.length, insert: 'x' },
    selection: { anchor: prefix.length + 1 }, annotations: Transaction.userEvent.of('input.type') }).state;
  const fresh = EditorState.create({ doc: next.doc, selection: next.selection,
    extensions: liveModeExtensions({ largeDocument: true }) });
  assert.deepEqual(decorationShape(mainDecorations(next)), decorationShape(mainDecorations(fresh)),
    'plain middle input must retain the authoritative presentation and positions of later rich blocks');
}
for (const suffix of ['**Formatted paragraph**\n\n'.repeat(1_500), '$x$\n\n'.repeat(550)]) {
  const state = EditorState.create({ doc: 'EDIT\n\n' + suffix, selection: { anchor: 4 },
    extensions: liveModeExtensions({ largeDocument: true }) }).update({}).state;
  const next = state.update({ changes: { from: 4, insert: 'x' }, selection: { anchor: 5 },
    annotations: Transaction.userEvent.of('input.type') }).state;
  assert.equal(mainDecorations(next).size, mainDecorations(state).size,
    'dense ordinary marks and supported widgets must preserve complete geometry without a full rebuild');
  const fresh = EditorState.create({ doc: next.doc, selection: next.selection, extensions: liveModeExtensions({ largeDocument: true }) });
  assert.deepEqual(decorationShape(mainDecorations(next)), decorationShape(mainDecorations(fresh)));
}
{
  const state = EditorState.create({ doc: 'x'.repeat(140_000) });
  const change = state.update({ changes: { from: 0, insert: 'a' } });
  const unknown = Decoration.set([Decoration.widget({ widget: new class extends WidgetType {}(), side: 1 }).range(1)]);
  assert.equal(mapStableLiveDecorations(unknown, change.changes, change.state), undefined,
    'unknown widget position semantics must retain the authoritative fallback');
  const mark = Decoration.mark({ class: 'budget' });
  const excessive = Decoration.set(Array.from({ length: 131_073 }, (_, index) => mark.range(index, index + 1)));
  assert.equal(mapStableLiveDecorations(excessive, change.changes, change.state), undefined,
    'the initial partition must remain bounded for extreme decoration counts');
}
console.log('Middle prose preserves supported widgets; partitioned dense presentation keeps bounded work and conservative fallbacks');
