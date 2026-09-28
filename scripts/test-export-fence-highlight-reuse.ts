import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-fence-reuse-'));
try {
  const entry = path.join(temporary, 'entry.ts');
  fs.writeFileSync(entry, `export { renderMarkdownToHtml } from ${JSON.stringify(path.resolve(import.meta.dir, '../src/export/renderMarkdown.ts'))};`);
  let observed = 0;
  const build = await Bun.build({
    entrypoints: [entry], target: 'node', format: 'cjs', minify: true,
    plugins: [{ name: 'observe-real-fence-highlighter', setup(builder) {
      builder.onLoad({ filter: /[\\/]highlight\.js[\\/]lib[\\/]index\.js$/ }, args => {
        observed++;
        return { loader: 'js', resolveDir: path.dirname(args.path), contents: fs.readFileSync(args.path, 'utf8') + `
          const originalHighlight = module.exports.highlight;
          module.exports.highlight = (...args) => {
            globalThis.__fenceHighlightCalls = (globalThis.__fenceHighlightCalls ?? 0) + 1;
            if (globalThis.__fenceFailure === 'throw') {
              globalThis.__fenceFailure = null; throw new Error('one transient failure');
            }
            const result = originalHighlight(...args);
            if (globalThis.__fenceFailure === 'illegal') {
              globalThis.__fenceFailure = null; return { ...result, illegal: true };
            }
            if (globalThis.__fenceFailure === 'result') {
              globalThis.__fenceFailure = null; return { ...result, errorRaised: new Error('one failed result') };
            }
            return result;
          };
        ` };
      });
    } }]
  });
  assert.ok(build.success, build.logs.map(String).join('\n'));
  assert.equal(observed, 1);
  await Bun.write(path.join(temporary, 'runtime.cjs'), build.outputs[0]);
  const runner = path.join(temporary, 'check.cjs');
  fs.writeFileSync(runner, `
    const assert = require('node:assert/strict');
    const { renderMarkdownToHtml } = require('./runtime.cjs');
    const options = { markdownFilePath: 'C:/fences.md', target: 'html' };
    const calls = () => globalThis.__fenceHighlightCalls ?? 0;
    const fence = (language, source) => '\\x60\\x60\\x60' + language + '\\n' + source + '\\n\\x60\\x60\\x60';
    const render = (text, extra = {}) => renderMarkdownToHtml({ ...options, markdownText: text, ...extra });
    const firstFence = fence('typescript', 'const first = 42;');
    const secondFence = fence('typescript', 'const second = 43;');
    const text = firstFence + '\\n\\n' + secondFence;
    const first = render(text);
    assert.equal(calls(), 2, 'The initial render must highlight both fences before returning');
    assert.match(first.html, /hljs-keyword/);
    assert.deepEqual(render(text), first);
    assert.equal(calls(), 2, 'An unchanged render must reuse both successful highlights');
    render('New prose\\n\\n' + text);
    assert.equal(calls(), 2, 'Changing prose or source line positions must not re-highlight fences');
    render(firstFence + '\\n\\n' + fence('typescript', 'const second = 44;'));
    assert.equal(calls(), 3, 'Editing one fence must recompute only that fence');
    render(fence('javascript', 'const first = 42;'));
    assert.equal(calls(), 4, 'Language must participate in the cache identity');
    assert.deepEqual(render(text, { markdownFilePath: 'C:/another.md', uiLanguage: 'zh-CN' }), first);
    assert.equal(calls(), 4, 'Context-free highlights may be reused across documents');
    const custom = render(firstFence, { highlightCode: () => '<span style="color:#112233">custom A</span>' });
    const changedCustom = render(firstFence, { highlightCode: () => '<span style="color:#445566">custom B</span>' });
    assert.notEqual(custom.html, changedCustom.html, 'Injected theme-aware highlighters must remain uncached');
    assert.equal(calls(), 4);
    const escaped = render(fence('not-a-language', '<script>alert("x")</script> &'));
    assert.ok(escaped.html.includes('&lt;script&gt;') && !escaped.html.includes('<script>'));
    assert.equal(calls(), 4);
    render(fence('M', 'let value = 12 in value'));
    const afterAlias = calls();
    render(fence('powerquery', 'let value = 12 in value'));
    assert.equal(calls(), afterAlias, 'Normalized aliases share an identity');
    for (const failure of ['throw', 'result', 'illegal']) {
      const failing = fence('typescript', 'const failed_' + failure + ' = 91;');
      globalThis.__fenceFailure = failure;
      const before = calls(); render(failing); const recovered = render(failing);
      assert.equal(calls(), before + 2, 'Failed highlights must be retried rather than cached');
      assert.match(recovered.html, /hljs-number/);
      assert.deepEqual(render(failing), recovered);
      assert.equal(calls(), before + 2);
    }
    const oldest = fence('typescript', 'const evictionOldest = 0;');
    render(oldest);
    for (let index = 0; index < 300; index++) render(fence('typescript', 'const eviction_' + index + ' = 0;'));
    let before = calls();
    render(fence('typescript', 'const eviction_299 = 0;'));
    assert.equal(calls(), before, 'Recently used fences remain reusable');
    render(oldest);
    assert.equal(calls(), before + 1, 'Entry count must be bounded');
    const recent = index => fence('typescript', 'const recency_' + index + ' = 0;');
    for (let index = 0; index < 256; index++) render(recent(index));
    before = calls(); render(recent(0)); assert.equal(calls(), before);
    render(recent(256));
    before = calls(); render(recent(0)); assert.equal(calls(), before, 'A cache hit must refresh recency');
    render(recent(1)); assert.equal(calls(), before + 1, 'Eviction must remove the least recently used entry');
    const large = index => fence('plaintext', 'x'.repeat(50000) + index);
    const largeFirst = render(large(0));
    for (let index = 1; index < 50; index++) render(large(index));
    before = calls(); render(large(49)); assert.equal(calls(), before);
    assert.deepEqual(render(large(0)), largeFirst);
    assert.equal(calls(), before + 1, 'Text payload capacity must also be bounded below 256 entries');
    for (const oversized of [fence('plaintext', 'x'.repeat(140000)), fence('plaintext', '\\u0001'.repeat(60000))]) {
      before = calls(); const output = render(oversized);
      assert.deepEqual(render(oversized), output);
      assert.equal(calls(), before + 2, 'Oversized source or serialized entries must bypass retention');
    }
    const untrusted = firstFence + '\\n\\n<img src="javascript:alert(1)" onerror="alert(1)">';
    for (let i = 0; i < 2; i++) {
      const output = render(untrusted);
      assert.ok(!output.html.includes('javascript:') && !output.html.includes('onerror='), 'Every render still sanitizes the document');
    }
    // Small plain highlights must not keep the original multi-megabyte document alive.
    global.gc(); const beforeLargeDocuments = process.memoryUsage().heapUsed;
    const renderLargeDocument = index => render('<!-- ' + 'x'.repeat(2 * 1024 * 1024)
      + ' -->\\n\\n' + fence('plaintext', 'small retained source ' + index));
    for (let index = 0; index < 8; index++) renderLargeDocument(index);
    global.gc();
    assert.ok(process.memoryUsage().heapUsed - beforeLargeDocuments < 8 * 1024 * 1024,
      'Small cached highlights must not retain their large parent documents');
    console.log('Fallback fence reuse, invalidation, retry, and capacity checks passed in Node');
  `);
  console.log(execFileSync('node', ['--expose-gc', runner], { encoding: 'utf8', timeout: 60_000 }).trim());
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}