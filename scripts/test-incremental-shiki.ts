import assert from 'node:assert/strict';
import { createHighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import wasm from 'shiki/wasm';
import { createIncrementalShiki } from '../webview/src/helpers/incrementalShiki';
import { toShikiTheme } from '../webview/src/helpers/shikiTheme';

const highlighter = await createHighlighterCore({ themes: [toShikiTheme({ name: 'test', type: 'dark', colors: {},
  tokenColors: [{ scope: 'comment', settings: { foreground: '#999999' } }, { scope: 'string', settings: { foreground: '#ff0000' } }] })],
  langs: [import('@shikijs/langs/javascript'), import('@shikijs/langs/markdown')], engine: await createOnigurumaEngine(wasm) });
let parsedLines = 0;
const native = highlighter.codeToTokens.bind(highlighter);
highlighter.codeToTokens = ((code, options) => { parsedLines += code.split(/\r?\n/).length; return native(code, options); }) as typeof highlighter.codeToTokens;
try {
  const engine = createIncrementalShiki(highlighter);
  const lines = Array.from({ length: 1800 }, (_, index) => `const row${index} = { text: "content" };`);
  await engine.tokenize('javascript', lines.join('\n'), () => true);
  parsedLines = 0;
  lines[900] = 'const row900 = { text: "changed" };';
  const result = await engine.tokenize('javascript', lines.join('\n'), () => true);
  assert.ok(parsedLines <= 128, `One changed line should stop after grammar convergence, parsed ${parsedLines} lines`);
  assert.equal(result?.[900]?.map(syntax => syntax.content).join(''), lines[900]);
  const expected = (lang: string, code: string) => native(code, { lang, theme: 'meo-code-theme', includeExplanation: 'scopeName' }).tokens
    .map(line => line.map(syntax => ({ offset: syntax.offset, content: syntax.content, color: syntax.color, fontStyle: syntax.fontStyle,
      isStringComment: syntax.explanation?.some(part => part.scopes.some(scope => /^(string|comment)/.test(scope.scopeName))) ?? false })));
  assert.deepEqual(result, expected('javascript', lines.join('\n')));
  for (const edit of [
    () => lines.splice(500, 0, '/* begin'),
    () => lines.splice(1300, 0, '*/'),
    () => lines.splice(500, 1),
    () => lines.splice(1200, 20),
    () => lines.splice(0, 0, 'const text = `multi', '', 'line ${ { field: "😀" } }`;')
  ]) {
    edit(); const code = lines.join('\n');
    assert.deepEqual(await engine.tokenize('javascript', code, () => true), expected('javascript', code));
  }
  const crlf = lines.join('\r\n');
  assert.deepEqual(await engine.tokenize('javascript', crlf, () => true), expected('javascript', crlf));
  const markdown = Array.from({ length: 200 }, (_, index) => index % 4 ? 'paragraph **text**' : '').join('\n');
  for (const code of [markdown, '<div>\n' + markdown, '---\nname: value\n---\n' + markdown, '# Heading\n\n' + markdown]) {
    assert.deepEqual(await engine.tokenize('markdown', code, () => true), expected('markdown', code));
  }
  engine.clear(); parsedLines = 0;
  let current = true, progressLines = 0;
  const retired = await engine.tokenize('javascript', lines.join('\n'), () => current, prefix => { progressLines = prefix.length; current = false; });
  assert.equal(retired, null);
  assert.equal(progressLines, 128, 'The initial reading prefix is ready before the whole fence');
  assert.ok(parsedLines <= 128, 'Retired work stops at a bounded grammar checkpoint');
  parsedLines = 0;
  assert.deepEqual(await engine.tokenize('javascript', lines.join('\n'), () => true), expected('javascript', lines.join('\n')));
  assert.ok(parsedLines < lines.length, 'The next revision can reuse valid work completed before cancellation');
} finally { highlighter.dispose(); }
console.log('Incremental Shiki recomputes only changed grammar ranges');
