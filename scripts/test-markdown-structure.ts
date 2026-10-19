import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { Language, ParseContext, ensureSyntaxTree, syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { javascriptLanguage } from '@codemirror/lang-javascript';
import { Parser, Tree, type Input, type TreeFragment } from '@lezer/common';
import { certifyMarkdownStructure, isCompleteMarkdownStructure, markdownStructureAvailable,
  viewportCodeLanguage, withMarkdownPreparationViewport } from '../webview/src/editor/markdownStructure';
import { liveInputDerivedWorkExtensions } from '../webview/src/editor/liveInputDerivedWork';
import { resolvedSyntaxTree } from '../webview/src/helpers/markdownSyntax';

const text = '# Heading\n\n```javascript\nconst one = 1;\n```\n\n'
  + 'Paragraph with **formatting**.\n\n'.repeat(600)
  + '```javascript\nconst distantValue = "complete";\n```\n\n[^late]: Final definition.\n';
const calls: number[] = [];
class ObservedParser extends Parser {
  createParse(input: Input, fragments: readonly TreeFragment[], ranges: readonly { from: number; to: number }[]) {
    calls.push(ranges[0]!.from);
    return javascriptLanguage.parser.startParse(input, fragments, ranges);
  }
}
const observed = new Language(javascriptLanguage.data, new ObservedParser());
const language = markdown({ base: markdownLanguage, extensions: certifyMarkdownStructure,
  codeLanguages: () => viewportCodeLanguage(observed) });
let state = EditorState.create({ doc: text, extensions: [language, ...liveInputDerivedWorkExtensions({ largeDocument: true })] });
withMarkdownPreparationViewport(state, { from: 0, to: 100 }, () => ensureSyntaxTree(state, state.doc.length, 10_000));
state = state.update({}).state;
assert.ok(isCompleteMarkdownStructure(syntaxTree(state), state.doc.length), 'completed Markdown is certified even with skipped nested languages');
assert.equal(syntaxTreeAvailable(state, state.doc.length), false, 'this must exercise incomplete embedded-language work');
assert.equal(markdownStructureAvailable(state), true);
assert.ok(calls.length > 0 && calls.every(from => from < 100), 'structural preparation must not parse the distant code language');
assert.ok(syntaxTree(state).toString().includes('Paragraph'), 'the complete outer syntax remains present');
const published = syntaxTree(state);
for (let index = 0; index < 10; index++) assert.equal(resolvedSyntaxTree(state), published,
  'structural readers must not advance embedded languages after completeness is proven');
assert.ok(calls.every(from => from < 100));

const far = text.indexOf('const distantValue');
withMarkdownPreparationViewport(state, { from: far, to: far + 40 }, () => ensureSyntaxTree(state, state.doc.length, 10_000));
state = state.update({}).state;
assert.ok(calls.includes(far), 'the same original code parser runs when its source is demanded');
assert.ok(isCompleteMarkdownStructure(syntaxTree(state), state.doc.length));

const plain = EditorState.create({ doc: text, extensions: language });
ensureSyntaxTree(plain, plain.doc.length, 10_000);
assert.ok(syntaxTreeAvailable(plain, plain.doc.length), 'ordinary documents retain complete embedded parsing');

const parser = markdownLanguage.parser.configure(certifyMarkdownStructure);
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
let suspended = EditorState.create({ doc: text, extensions: markdown({ base: markdownLanguage,
  extensions: certifyMarkdownStructure, codeLanguages: () => deferred }) });
ensureSyntaxTree(suspended, suspended.doc.length, 10_000);
suspended = suspended.update({}).state;
assert.equal(syntaxTreeAvailable(suspended, suspended.doc.length), false);
assert.ok(isCompleteMarkdownStructure(syntaxTree(suspended), suspended.doc.length),
  'an asynchronous language cannot hold complete Markdown semantics hostage');
console.log('Markdown structure: full proof, partial rejection, skipped-code demand, suspended languages and normal parsing passed');
