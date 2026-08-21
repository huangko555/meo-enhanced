import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

type ShikiMetrics = {
  readonly initCalls: number;
  readonly loadCalls: number;
  readonly tokenizeCalls: number;
  readonly disposeCalls: number;
  readonly instances: Array<{
    readonly id: number;
    readonly loadCalls: number;
    readonly tokenizeCalls: number;
    readonly disposeCalls: number;
  }>;
};

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-source-shiki-lifecycle-'));

const readMetrics = (page: import('puppeteer-core').Page): Promise<ShikiMetrics> => (
  page.evaluate(() => structuredClone((window as any).__shikiLifecycleMetrics))
);

const waitForFrames = async (page: import('puppeteer-core').Page, count = 8): Promise<void> => {
  await page.evaluate(async (frameCount) => {
    for (let frame = 0; frame < frameCount; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
};

const fakeCore = `
  const metrics = globalThis.__shikiLifecycleMetrics ??= {
    initCalls: 0,
    loadCalls: 0,
    tokenizeCalls: 0,
    disposeCalls: 0,
    instances: []
  };

  export function createHighlighterCore() {
    const loaded = new Set();
    const instance = {
      id: metrics.instances.length + 1,
      loadCalls: 0,
      tokenizeCalls: 0,
      disposeCalls: 0
    };
    metrics.initCalls += 1;
    metrics.instances.push(instance);
    return {
      async loadLanguage(grammar) {
        instance.loadCalls += 1;
        metrics.loadCalls += 1;
        loaded.add(grammar.name);
      },
      codeToTokens(code, options) {
        instance.tokenizeCalls += 1;
        metrics.tokenizeCalls += 1;
        if (!loaded.has(options.lang)) {
          throw new Error('tokenization attempted without an instance-owned grammar');
        }
        return {
          tokens: [[{
            offset: 0,
            content: code,
            color: instance.id % 2 === 0 ? '#2255aa' : '#aa2255',
            fontStyle: 0
          }]]
        };
      },
      dispose() {
        instance.disposeCalls += 1;
        metrics.disposeCalls += 1;
      }
    };
  }
`;

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-source-lightweight-shiki-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js',
    plugins: [{
      name: 'shiki-external-lifecycle-seam',
      setup(builder) {
        builder.onResolve({ filter: /^shiki\/core$/ }, () => ({
          path: 'core',
          namespace: 'shiki-lifecycle-test'
        }));
        builder.onResolve({ filter: /^shiki\/engine\/oniguruma$/ }, () => ({
          path: 'engine',
          namespace: 'shiki-lifecycle-test'
        }));
        builder.onResolve({ filter: /^shiki\/wasm$/ }, () => ({
          path: 'wasm',
          namespace: 'shiki-lifecycle-test'
        }));
        builder.onResolve({ filter: /^@shikijs\/langs\// }, (args) => ({
          path: args.path.slice('@shikijs/langs/'.length),
          namespace: 'shiki-language-test'
        }));
        builder.onLoad({ filter: /^core$/, namespace: 'shiki-lifecycle-test' }, () => ({
          loader: 'js',
          contents: fakeCore
        }));
        builder.onLoad({ filter: /^engine$/, namespace: 'shiki-lifecycle-test' }, () => ({
          loader: 'js',
          contents: 'export async function createOnigurumaEngine() { return {}; }'
        }));
        builder.onLoad({ filter: /^wasm$/, namespace: 'shiki-lifecycle-test' }, () => ({
          loader: 'js',
          contents: 'export default {};'
        }));
        builder.onLoad({ filter: /.*/, namespace: 'shiki-language-test' }, (args) => ({
          loader: 'js',
          contents: `export default { name: ${JSON.stringify(args.path)} };`
        }));
      }
    }]
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 760, deviceScaleFactor: 1 });
    await page.setContent([
      '<!doctype html><style>html,body{height:100%;margin:0}.host{height:48%;}</style>',
      '<div id="first" class="host"></div><div id="second" class="host"></div>'
    ].join(''));
    await page.evaluate(() => {
      (window as any).__shikiLifecycleMetrics = {
        initCalls: 0,
        loadCalls: 0,
        tokenizeCalls: 0,
        disposeCalls: 0,
        instances: []
      };
    });
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#fff;--meo-foreground:#111;--meo-code-background:#f4f4f4;--meo-surface-background:#fff;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--meo-line-height-live:1.6;--meo-line-height-source:1.5}'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const firstText = '# First\n\n```typescript\nconst first_value = 1;\n```';
    const secondText = '# Second\n\n```typescript\nconst second_value = 2;\n```';
    await page.evaluate(({ first, second }) => {
      const harness = (window as any).SourceLightweightShikiHarness;
      harness.applyTheme();
      (window as any).__shikiEditors = {
        first: harness.createEditor({
          parent: document.getElementById('first'),
          text: first,
          initialMode: 'source',
          onApplyChanges() {}
        }),
        secondText: second
      };
    }, { first: firstText, second: secondText });
    await waitForFrames(page);
    assert.deepEqual(
      await readMetrics(page),
      { initCalls: 0, loadCalls: 0, tokenizeCalls: 0, disposeCalls: 0, instances: [] },
      'production Source bootstrap must do zero Shiki init/load/tokenize/dispose work'
    );

    await page.evaluate(() => (window as any).__shikiEditors.first.setMode('live'));
    await page.waitForFunction(() => document.querySelectorAll('#first span[style*="color:"]').length > 0);
    await page.evaluate(() => {
      const state = (window as any).__shikiEditors;
      state.second = (window as any).SourceLightweightShikiHarness.createEditor({
        parent: document.getElementById('second'),
        text: state.secondText,
        initialMode: 'live',
        onApplyChanges() {}
      });
    });
    await page.waitForFunction(() => document.querySelectorAll('#second span[style*="color:"]').length > 0);

    let metrics = await readMetrics(page);
    assert.equal(metrics.initCalls, 1, 'two Live editors must share one HighlighterCore');
    assert.equal(metrics.loadCalls, 1, 'one HighlighterCore must load one shared grammar once');
    assert.equal(metrics.tokenizeCalls, 2);
    assert.equal(metrics.disposeCalls, 0);

    const latestSecondText = '# Latest second\n\n```typescript\nconst latest_second = 3;\n```';
    await page.evaluate((latest) => {
      const state = (window as any).__shikiEditors;
      state.first.setMode('source');
      state.first.setMode('source');
      state.second.setText(latest);
    }, latestSecondText);
    await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>('#second span[style*="color:"]'))
      .some((node) => node.textContent?.includes('latest_second')));
    metrics = await readMetrics(page);
    assert.equal(metrics.initCalls, 1);
    assert.equal(metrics.loadCalls, 1);
    assert.equal(metrics.tokenizeCalls, 3, 'remaining Live consumer must keep producing current tokens');
    assert.equal(metrics.disposeCalls, 0, '2→1 consumers must not dispose');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#first span[style*="color:"]').length), 0);

    await page.evaluate(() => {
      const state = (window as any).__shikiEditors;
      state.second.setMode('source');
      state.second.setMode('source');
    });
    await page.waitForFunction(() => (window as any).__shikiLifecycleMetrics.disposeCalls === 1);
    metrics = await readMetrics(page);
    assert.equal(metrics.disposeCalls, 1, '1→0 consumers must dispose exactly once');
    assert.equal(metrics.instances[0].disposeCalls, 1, 'repeated Source transition must be idempotent');

    const rapidText = '# Rapid latest\n\n```typescript\nconst rapid_latest = 4;\n```';
    await page.evaluate((latest) => {
      const editor = (window as any).__shikiEditors.first;
      editor.setText(latest);
      editor.setMode('live');
      editor.setMode('source');
      editor.setMode('live');
    }, rapidText);
    await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>('#first span[style*="color:"]'))
      .some((node) => node.textContent?.includes('rapid_latest')));
    await page.waitForFunction(() => (window as any).__shikiLifecycleMetrics.instances.length === 3);
    await waitForFrames(page);
    metrics = await readMetrics(page);
    assert.equal(metrics.instances[1].disposeCalls, 1, 'rapid abandoned generation must dispose once');
    assert.equal(metrics.instances[1].tokenizeCalls, 0, 'rapid abandoned generation must not tokenize or publish DOM');
    assert.equal(metrics.instances[2].loadCalls, 1);
    assert.equal(metrics.instances[2].tokenizeCalls, 1, 'latest generation must render the latest Document');
    assert.equal(
      await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('#first span[style*="color:"]'))
        .some((node) => node.textContent?.includes('first_value'))),
      false,
      'stale completion must not restore old token DOM'
    );

    await page.evaluate(() => {
      const state = (window as any).__shikiEditors;
      state.second.destroy();
      state.first.destroy();
    });
    await page.waitForFunction(() => (window as any).__shikiLifecycleMetrics.disposeCalls === 3);
    metrics = await readMetrics(page);
    assert.equal(metrics.disposeCalls, 3);
    assert.equal(metrics.instances.every((instance) => instance.disposeCalls === 1), true);
  } finally {
    await browser.close();
  }

  console.log('Source lightweight Shiki lifecycle production trace passed');
}

main()
  .finally(() => fs.rmSync(tempDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
