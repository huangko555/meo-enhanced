import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { Language, ParseContext, ensureSyntaxTree, syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { javascriptLanguage } from '@codemirror/lang-javascript';
import { htmlLanguage } from '@codemirror/lang-html';
import type { MarkdownParser } from '@lezer/markdown';
import { NodeType, Parser, Tree, TreeCursor, type Input, type TreeFragment } from '@lezer/common';
import { certifyMarkdownStructure, isCompleteMarkdownStructure, markdownStructureAvailable,
  withMarkdownPreparationViewport } from '../webview/src/editor/markdownStructure';
import { markdownMixedLanguages } from '../webview/src/editor/markdownMixedLanguages';
import { liveInputDerivedWorkExtensions } from '../webview/src/editor/liveInputDerivedWork';
import { resolvedSyntaxTree } from '../webview/src/helpers/markdownSyntax';

const text = '# Heading\n\n```javascript\nconst one = 1;\n```\n\n'
  + 'Paragraph with **formatting**.\n\n'.repeat(600)
  + '```javascript\nconst distantValue = "complete";\n```\n\n[^late]: Final definition.\n\n'
  + '<script>\nconst distantHtml = 2;\n</script>\n';
const calls: number[] = [];
class ObservedParser extends Parser {
  createParse(input: Input, fragments: readonly TreeFragment[], ranges: readonly { from: number; to: number }[]) {
    calls.push(ranges[0]!.from);
    return javascriptLanguage.parser.startParse(input, fragments, ranges);
  }
}
const observed = new Language(javascriptLanguage.data, new ObservedParser());
const htmlCalls: number[] = [];
class ObservedHtmlParser extends Parser {
  createParse(input: Input, fragments: readonly TreeFragment[], ranges: readonly { from: number; to: number }[]) {
    htmlCalls.push(ranges[0]!.from);
    return htmlLanguage.parser.startParse(input, fragments, ranges);
  }
}
const certifiedBase = new Language(markdownLanguage.data, (markdownLanguage.parser as MarkdownParser).configure(certifyMarkdownStructure));
const language = new Language(markdownLanguage.data, (certifiedBase.parser as MarkdownParser)
  .configure(markdownMixedLanguages({ codeLanguage: () => observed, htmlParser: new ObservedHtmlParser() })));
let state = EditorState.create({ doc: text, extensions: [language, ...liveInputDerivedWorkExtensions({ largeDocument: true })] });
state = state.update({ selection: { anchor: 5 } }).state;
withMarkdownPreparationViewport(state, { from: 0, to: 100 }, () => ensureSyntaxTree(state, state.doc.length, 10_000));
state = state.update({}).state;
assert.ok(isCompleteMarkdownStructure(syntaxTree(state), state.doc.length), 'completed Markdown is certified even with skipped nested languages');
assert.ok(!calls.includes(text.indexOf('const distantValue')), 'deferred viewport grammars have not run even when Markdown is complete');
assert.equal(markdownStructureAvailable(state), true);
assert.ok(calls.length > 0 && calls.every(from => from < 100), 'structural preparation must not parse the distant code language');
assert.ok(syntaxTree(state).toString().includes('Paragraph'), 'the complete outer syntax remains present');
const published = syntaxTree(state);
for (let index = 0; index < 10; index++) assert.equal(resolvedSyntaxTree(state), published,
  'structural readers must not advance embedded languages after completeness is proven');
assert.ok(calls.every(from => from < 100));
assert.deepEqual(htmlCalls, [], 'distant HTML must not parse during near-source preparation');

const far = text.indexOf('const distantValue');
withMarkdownPreparationViewport(state, { from: far, to: far + 40 }, () => ensureSyntaxTree(state, state.doc.length, 10_000));
state = state.update({}).state;
assert.ok(calls.includes(far), 'the same original code parser runs when its source is demanded');
assert.ok(isCompleteMarkdownStructure(syntaxTree(state), state.doc.length));
const farHtml = text.indexOf('<script>');
withMarkdownPreparationViewport(state, { from: farHtml, to: farHtml + 20 }, () => ensureSyntaxTree(state, state.doc.length, 10_000));
state = state.update({}).state;
assert.ok(htmlCalls.includes(farHtml), 'entering deferred HTML must run its original embedded parser');
assert.ok(isCompleteMarkdownStructure(syntaxTree(state), state.doc.length));

const plain = EditorState.create({ doc: text, extensions: language });
ensureSyntaxTree(plain, plain.doc.length, 10_000);
assert.ok(syntaxTreeAvailable(plain, plain.doc.length), 'ordinary documents retain complete embedded parsing');

const parser = (markdownLanguage.parser as MarkdownParser).configure(certifyMarkdownStructure);
const full = parser.parse(text);
assert.ok(isCompleteMarkdownStructure(full, text.length));
const unknown = new Tree(full.type, full.children.slice(0, 1), full.positions.slice(0, 1), full.length);
assert.equal(isCompleteMarkdownStructure(unknown, text.length), false, 'a same-length tree with missing late content cannot claim completeness');
const partial = parser.startParse(text); partial.stopAt(30);
let partialTree: Tree | null;
while (!(partialTree = partial.advance())) { /* deterministic parser completion */ }
assert.equal(isCompleteMarkdownStructure(partialTree, text.length), false, 'a stopped parser cannot certify its unread suffix');

const pending = ParseContext.getSkippingParser(new Promise<void>(() => {}));
const deferred = new Language(javascriptLanguage.data, pending);
let suspended = EditorState.create({ doc: text, extensions: markdown({ base: certifiedBase, codeLanguages: () => deferred }) });
ensureSyntaxTree(suspended, suspended.doc.length, 10_000);
suspended = suspended.update({}).state;
assert.equal(syntaxTreeAvailable(suspended, suspended.doc.length), false);
assert.ok(isCompleteMarkdownStructure(syntaxTree(suspended), suspended.doc.length),
  'an asynchronous language cannot hold complete Markdown semantics hostage');
let slowAdvances = 0;
class SlowParser extends Parser {
  createParse(_input: Input, _fragments: readonly TreeFragment[], ranges: readonly { from: number; to: number }[]) {
    let stopped: number | null = null;
    const from = ranges[0]!.from;
    return { parsedPos: from, get stoppedAt() { return stopped; }, stopAt(position: number) { stopped = position; },
      advance() { slowAdvances++; return stopped === null ? null : new Tree(NodeType.none, [], [], Math.max(0, stopped - from)); } };
  }
}
const slow = new Language(javascriptLanguage.data, new SlowParser());
const duringInner = markdown({ base: certifiedBase, codeLanguages: () => slow }).language.parser.startParse(text);
while (slowAdvances === 0) assert.equal(duringInner.advance(), null);
// Stop only the unfinished inner pass after the full outer pass has completed.
// This uses the public parser boundary: CodeMirror may defer publication while
// a nested parser's progress is behind a previously published prefix.
duringInner.stopAt(text.indexOf('const one'));
let stoppedInner: Tree | null;
while (!(stoppedInner = duringInner.advance())) { /* finish the requested inner prefix */ }
assert.ok(isCompleteMarkdownStructure(stoppedInner, text.length),
  'the certificate precedes the mixed pass and survives stopping unfinished inner work');
const opaque = certifyMarkdownStructure.wrap(ParseContext.getSkippingParser().startParse(text),
  { length: text.length, lineChunks: false, chunk: from => text.slice(from), read: (from, to) => text.slice(from, to) },
  [], [{ from: 0, to: text.length }]).advance()!;
assert.equal(isCompleteMarkdownStructure(opaque, text.length), false, 'a full-length asynchronous placeholder is not Markdown structure');

// A completed worker tree must not cause parseMixed to visit every distant
// Markdown node merely to discover that its embedded language is offscreen.
const corpus = ('Paragraph with **bold**, *emphasis* and [link](https://example.test).\n\n'
  + '```javascript\nconst bounded = 1;\n```\n\n').repeat(2_000);
const outer = parser.parse(corpus);
const boundedCalls: number[] = [];
class BoundedCode extends Parser {
  createParse(input: Input, fragments: readonly TreeFragment[], ranges: readonly { from: number; to: number }[]) {
    boundedCalls.push(ranges[0]!.from);
    return javascriptLanguage.parser.startParse(input, fragments, ranges);
  }
}
const boundedCode = new Language(javascriptLanguage.data, new BoundedCode());
const boundedMixed = markdownMixedLanguages({ codeLanguage: () => boundedCode });
class CompletedOuter extends Parser {
  createParse(input: Input, fragments: readonly TreeFragment[], ranges: readonly { from: number; to: number }[]) {
    let stoppedAt: number | null = null;
    return boundedMixed.wrap({ parsedPos: input.length, get stoppedAt() { return stoppedAt; },
      stopAt(pos) { stoppedAt = pos; }, advance: () => outer }, input, fragments, ranges);
  }
}
let visits = 0;
const firstChild = TreeCursor.prototype.firstChild;
TreeCursor.prototype.firstChild = function () { visits++; return firstChild.call(this); };
try {
  const completedLanguage = new Language(markdownLanguage.data, new CompletedOuter());
  let scoped = EditorState.create({ doc: corpus,
    extensions: [completedLanguage, ...liveInputDerivedWorkExtensions({ largeDocument: true })] });
  withMarkdownPreparationViewport(scoped, { from: 0, to: 200 }, () => ensureSyntaxTree(scoped, corpus.length, 10_000));
  scoped = scoped.update({}).state;
  assert.ok(isCompleteMarkdownStructure(syntaxTree(scoped), corpus.length));
  assert.ok(boundedCalls.length > 0 && boundedCalls.every(from => from < 3_000));
  assert.ok(visits < 2_000, `mixed discovery must skip distant subtrees: ${visits} visits`);
  const initialVisits = visits;
  for (const position of [corpus.lastIndexOf('const bounded'), corpus.indexOf('const bounded')]) {
    visits = 0;
    const before = boundedCalls.length;
    withMarkdownPreparationViewport(scoped, { from: position, to: position + 20 },
      () => ensureSyntaxTree(scoped, corpus.length, 10_000));
    scoped = scoped.update({}).state;
    assert.ok(boundedCalls.slice(before).some(from => Math.abs(from - position) < 200),
      'each newly demanded viewport must run the real embedded parser');
    assert.ok(visits < 2_000, `viewport return must also skip distant subtrees: ${visits} visits`);
    assert.ok(isCompleteMarkdownStructure(syntaxTree(scoped), corpus.length));
  }
  console.log(`Completed outer tree: ${initialVisits} initial mixed-discovery visits; distant/return grammar demand preserved`);
} finally { TreeCursor.prototype.firstChild = firstChild; }
console.log('Markdown structure: full proof, partial rejection, skipped-code demand, suspended languages and normal parsing passed');
