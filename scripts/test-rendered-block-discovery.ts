import assert from 'node:assert/strict';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const actualMath = path.resolve('webview/src/helpers/math.ts').replaceAll('\\', '/');
const build = await Bun.build({
  entrypoints: ['scripts/test-rendered-block-discovery-entry.ts'], target: 'browser', format: 'iife',
  plugins: [{ name: 'math-discovery-work', setup(builder) {
    builder.onResolve({ filter: /(?:^|\/)math$/ }, () => ({ path: 'math-work', namespace: 'math-work' }));
    builder.onLoad({ filter: /.*/, namespace: 'math-work' }, () => ({ loader: 'js', contents: `
      export * from ${JSON.stringify(actualMath)};
      import { collectLatexMathRanges as actual } from ${JSON.stringify(actualMath)};
      export function collectLatexMathRanges(...args) {
        globalThis.__mathScans = (globalThis.__mathScans ?? 0) + 1;
        return actual(...args);
      }
    ` }));
  } }]
});
if (!build.success) throw Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const samples = await page.evaluate(() => (globalThis as any).RenderedBlockDiscoveryHarness.run());
  console.log(JSON.stringify(samples));
  const sample = (phase: string) => samples.find((item: any) => item.phase === phase);
  assert.deepEqual(sample('initial').kinds, ['math', 'table', 'html', 'mermaid']);
  assert.equal(sample('initial').scans, 1);
  for (const phase of ['inside-math', 'include-selected-math', 'outside-math', 'editing-html', 'rendering-html']) {
    assert.equal(sample(phase).scans, 0, `${phase} must reuse document discovery`);
  }
  assert.equal(sample('inside-math').kinds.includes('math'), false);
  assert.equal(sample('include-selected-math').kinds.includes('math'), true);
  assert.equal(sample('outside-math').kinds.includes('math'), true);
  assert.equal(sample('editing-html').kinds.includes('html'), false);
  assert.equal(sample('rendering-html').kinds.includes('html'), true);
  assert.equal(sample('changed-parse').scans, 1, 'A different parse of the same Document must invalidate discovery');
  assert.equal(sample('changed-parse').kinds.includes('mermaid'), false);
  assert.equal(sample('restored-parse').scans, 1);
  assert.deepEqual(sample('restored-parse').kinds, sample('initial').kinds);
  assert.equal(sample('changed-document').scans, 1, 'A changed Document must be rediscovered');
  assert.notDeepEqual(sample('changed-document').kinds, sample('initial').kinds);
  console.log('Rendered block discovery reuses semantic work while updating selection projection');
} finally { await browser.close(); }
