import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-fallback-highlight-'));
try {
  const entry = path.join(temporary, 'entry.ts');
  fs.writeFileSync(entry, `export { renderMarkdownToHtml } from ${JSON.stringify(path.resolve(import.meta.dir, '../src/export/renderMarkdown.ts'))};`);
  let instrumented = 0;
  const build = await Bun.build({
    entrypoints: [entry], target: 'node', format: 'cjs', minify: true,
    plugins: [{ name: 'observe-real-highlight-initialization', setup(builder) {
      builder.onLoad({ filter: /[\\/]highlight\.js[\\/]lib[\\/]index\.js$/ }, args => {
        instrumented++;
        // Observe initialization without replacing the library or the production renderer.
        return { contents: `globalThis.__fallbackHighlightInitializations = (globalThis.__fallbackHighlightInitializations ?? 0) + 1;\n${fs.readFileSync(args.path, 'utf8')}`,
          loader: 'js', resolveDir: path.dirname(args.path) };
      });
    } }]
  });
  assert.ok(build.success, build.logs.map(String).join('\n'));
  assert.equal(instrumented, 1, 'The actual bundled highlight.js entry must be observed');
  await Bun.write(path.join(temporary, 'runtime.cjs'), build.outputs[0]);
  const runner = path.join(temporary, 'check.cjs');
  fs.writeFileSync(runner, `
    const assert = require('node:assert/strict');
    const { renderMarkdownToHtml: render } = require('./runtime.cjs');
    const count = () => globalThis.__fallbackHighlightInitializations ?? 0;
    const options = { markdownFilePath: 'C:/highlight.md', target: 'html' };
    const fence = (language, source) => '\\x60\\x60\\x60' + language + '\\n' + source + '\\n\\x60\\x60\\x60';
    assert.equal(count(), 0, 'Loading the renderer must not initialize an unused fallback highlighter');
    render({ ...options, markdownText: '# Plain document\\n\\n**Readable text**' });
    render({ ...options, markdownText: fence('', '<b>plain & text</b>') });
    render({ ...options, markdownText: fence('ts', 'const injected = 1;'), highlightCode: () => '<span class="hljs-keyword">injected</span>' });
    assert.equal(count(), 0, 'Plain fences and an injected export highlighter must not initialize the fallback');
    for (const language of ['typescript', 'ts', 'js', 'python', 'ruby', 'rust', 'sql', 'powerquery', 'm']) {
      const source = language === 'powerquery' || language === 'm' ? 'let value = 42 in value' : 'const value = 42;';
      const output = render({ ...options, markdownText: fence(language, source) });
      assert.match(output.html, /hljs-(?:keyword|number)/, language + ' lost fallback highlighting');
      assert.equal(count(), 1, 'Fallback initialization must be reused across renders');
    }
    const escaped = render({ ...options, markdownText: fence('not-a-language', '<script>alert("x")</script> &') });
    assert.ok(!escaped.html.includes('<script>'), 'Unknown languages must remain escaped');
    assert.ok(escaped.html.includes('&lt;script&gt;'), 'Unknown language source must remain readable');
    assert.equal(count(), 1);
    console.log('Lazy fallback highlight initialization checks passed in Node');
  `);
  console.log(execFileSync('node', [runner], { encoding: 'utf8', timeout: 30_000 }).trim());
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}