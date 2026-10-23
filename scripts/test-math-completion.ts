import assert from 'node:assert/strict';
import katex from 'katex';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { getMathCompletionBody } from '../webview/src/helpers/displayMathBlocks';
import { detectMathCompletion, mathCompletionSuggestions, planMathCompletion } from '../webview/src/editor/mathCompletion';

function fixture(marked: string) {
  const position = marked.indexOf('|');
  const state = EditorState.create({ doc: marked.replace('|', ''), extensions: [markdown()] });
  return { state, context: detectMathCompletion(state, position, () => getMathCompletionBody(state, position)) };
}
const prose = EditorState.create({ doc: 'ordinary text' });
assert.equal(detectMathCompletion(prose, prose.doc.length, () => { throw new Error('prose must not scan math'); }), null);
for (const marked of ['$\\al|$', '$\\al|', '$$\\al|$$', '$$\n\\al|\n$$', '$$\n\\al|',
  '> $$\n> \\al|\n> $$', '- $$\n  \\al|\n  $$',
  ...['math', 'latex', 'tex', 'katex'].flatMap(language => ['```' + language + '\n\\al|\n```', '```' + language + '\n\\al|'])]) {
  const { context } = fixture(marked);
  assert.ok(context, 'recognizes editable math: ' + marked);
  assert.equal(mathCompletionSuggestions(context)[0]?.label, '\\alpha');
}
for (const marked of ['\\al|', 'Price $20 and \\al|', '`$\\al|$`', '```js\n$\\al|$\n```',
  '[file]($\\al|)', '---\nname: $\\al|$\n---', '<!-- $\\al|$ -->', '$\\\\al|$',
  '$$\n% \\al|\n$$', '$$\n\\al\n$$\n\\be|', '\\$\\al|']) {
  assert.equal(fixture(marked).context, null, 'excludes literal/prose contexts: ' + marked);
}
const edit = (marked: string, label: string) => {
  const { state, context } = fixture(marked);
  assert.ok(context);
  const item = mathCompletionSuggestions(context).find(item => item.label === label);
  assert.ok(item, 'suggests ' + label);
  const plan = planMathCompletion(state, context, item);
  return { ...plan, text: state.update({ changes: { from: plan.from, to: plan.to, insert: plan.insert } }).state.doc.toString() };
};
for (const separator of ['\n', '\n\n']) for (const [opening, content, boundary] of [
  ['$$', '\\al', '## Next'],
  ['$$', '\\al', '```text'],
  ['$$', '\\al', '~~~text'],
  ['> $$', '> \\al', '> ## Next'],
  ['- $$', '  \\al', '  ## Next'],
  ['> - $$', '>   \\al', '>   ## Next'],
  ['> $$', '> \\al', '> ```text'],
  ['> $$', '> \\al', 'outside'],
  ['> > $$', '> > \\al', '> outside'],
  ['- $$', '  \\al', 'outside'],
  ['- $$', '  \\al', '- sibling'],
  ['12. $$', '    \\al', 'outside'],
  ['> - $$', '>   \\al', '> outside'],
  ['> - $$', '>   \\al', '> - sibling']
]) {
  const text = opening + '\n' + content + separator + boundary + '\n\\beta';
  const state = EditorState.create({ doc: text, extensions: [markdown()] });
  const body = getMathCompletionBody(state, opening.length + 1 + content.length);
  assert.ok(body, 'unfinished formula remains editable before ' + boundary);
  assert.equal(body.to, text.indexOf(boundary), 'unfinished formula stops before ' + boundary);
  assert.equal(getMathCompletionBody(state, text.length), null, 'later prose is outside math after ' + boundary);
}
for (const marked of ['$$\n\\al|\n\n\\beta', '$$\n\n\\al|', '```math\n\\al|\n\n## literal heading\n\\beta']) {
  const { state, context } = fixture(marked);
  assert.ok(context, 'blank lines and literal math-fence contents remain editable');
  assert.equal(getMathCompletionBody(state, marked.indexOf('|'))?.to, state.doc.length);
}
assert.equal(edit('$\\fr|ac{x}{y}$', '\\frac').text, '$\\frac{x}{y}$', 'replaces a whole command without duplicating arguments');
assert.equal(edit('$\\sq|$', '\\sqrt').text, '$\\sqrt{}$');
assert.equal(edit('$$\n\\begin{ali|}\nx &= y\n\\end{aligned}\n$$', '\\begin{aligned}').text,
  '$$\n\\begin{aligned}\nx &= y\n\\end{aligned}\n$$', 'preserves the existing matching end');
assert.equal(edit('> $$\n> \\begin{ali|\n> $$', '\\begin{aligned}').text,
  '> $$\n> \\begin{aligned}\n>   \n> \\end{aligned}\n> $$', 'new environment lines retain the quote prefix');
assert.equal(edit('$$\n\\begin{aligned}\n\\begin{ali|\n\\end{aligned}\n$$', '\\begin{aligned}').text,
  '$$\n\\begin{aligned}\n\\begin{aligned}\n  \n\\end{aligned}\n\\end{aligned}\n$$', 'does not reuse an enclosing environment closer');
assert.equal(edit('$$\n\\begin{ali|\n% \\end{aligned}\n$$', '\\begin{aligned}').text,
  '$$\n\\begin{aligned}\n  \n\\end{aligned}\n% \\end{aligned}\n$$', 'commented closers do not close a template');
assert.equal(edit('$$\n\\begin{ali|\n## Next\n\\end{aligned}', '\\begin{aligned}').text,
  '$$\n\\begin{aligned}\n  \n\\end{aligned}\n## Next\n\\end{aligned}', 'a closer beyond the Markdown boundary does not close a template');
for (const [query, first] of [['ga', '\\gamma'], ['Ga', '\\Gamma']]) {
  const { context } = fixture('$\\' + query + '|$');
  assert.equal(mathCompletionSuggestions(context!)[0]?.label, first, 'case-aware ranking');
}
const { context } = fixture('$$\n\\b|\n$$');
const all = mathCompletionSuggestions({ ...context!, query: '' });
assert.ok(all.length >= 100);
assert.equal(new Set(all.map(item => item.label)).size, all.length);
for (const item of all) {
  assert.ok(item.preview, item.label + ': has a fixed menu preview');
  assert.doesNotThrow(() => katex.renderToString(item.preview, { throwOnError: true, trust: false }), item.label + ': valid preview');
  let sample = item.insert;
  for (const offset of [...item.fields].reverse()) sample = sample.slice(0, offset) + 'x' + sample.slice(offset);
  // A delimiter command is valid only as part of its matching pair.
  const pairs: Record<string, string> = { '\\langle': '\\rangle', '\\lceil': '\\rceil', '\\lfloor': '\\rfloor' };
  sample += pairs[item.label] ?? '';
  assert.doesNotThrow(() => katex.renderToString(sample, { displayMode: true, throwOnError: true, trust: false }), item.label);
}
console.log('Math completion context, replacement, templates and installed KaTeX compatibility passed');
