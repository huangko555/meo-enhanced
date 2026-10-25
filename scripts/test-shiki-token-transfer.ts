import assert from 'node:assert/strict';
import { createHighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import wasm from 'shiki/wasm';
import { packShikiTokens, unpackShikiTokens } from '../webview/src/helpers/shikiTokenTransfer';

const engine = await createHighlighterCore({ themes: [import('@shikijs/themes/dark-plus')],
  langs: [import('@shikijs/langs/javascript')], engine: await createOnigurumaEngine(wasm) });
try {
  for (const code of ['', 'const x = "你好😀";\r\n/* multi\r\nline */\r\n', 'const x = `line1\nline2`;\n\n']) {
    const original = engine.codeToTokens(code, { lang: 'javascript', theme: 'dark-plus', includeExplanation: 'scopeName' }).tokens;
    const decoded = await unpackShikiTokens(packShikiTokens(original), code, () => true);
    assert.deepEqual(decoded, original.map(line => line.map(syntaxToken => ({ offset: syntaxToken.offset, content: syntaxToken.content,
      color: syntaxToken.color, fontStyle: (syntaxToken.fontStyle ?? 0) & 15,
      isStringComment: syntaxToken.explanation?.some(part => part.scopes.some(scope => /^(string|comment)/.test(scope.scopeName))) ?? false }))));
  }
  const packed = packShikiTokens([Array.from({ length: 100000 }, () => ({ offset: 0, content: 'x' }))]);
  let needed = true;
  setTimeout(() => { needed = false; }, 0);
  assert.equal(await unpackShikiTokens(packed, 'x', () => needed), null, 'A retired large reconstruction yields and stops');
} finally { engine.dispose(); }
console.log('Transferable Shiki tokens preserve CRLF, Unicode, grammar scopes and cancellation');
