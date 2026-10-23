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
    readonly loadedLanguages: string[];
    readonly tokenizedCodes: string[];
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
      disposeCalls: 0, loadedLanguages: [], tokenizedCodes: [],
      baseColor: globalThis.__lifecycleColor ?? "#aa2255"
    };
    metrics.initCalls += 1;
    metrics.instances.push(instance);
    return {
      async loadLanguage(...grammars) {
        instance.loadCalls += 1;
        metrics.loadCalls += 1;
        for (const grammar of grammars.flat(Infinity)) {
          loaded.add(grammar.name);
          instance.loadedLanguages.push(grammar.name);
        }
      },
      codeToTokens(code, options) {
        instance.tokenizeCalls += 1;
        metrics.tokenizeCalls += 1;
        instance.tokenizedCodes.push(code);
        globalThis.__onShikiTokenize?.(code);
        if (!loaded.has(options.lang)) {
          throw new Error('tokenization attempted without an instance-owned grammar');
        }
        let offset = 0;
        return {
          tokens: code.split('\\n').map(content => {
            const syntaxToken = { offset, content,
              color: code.includes('latest_second_') ? '#338855' : instance.baseColor, fontStyle: 0 };
            offset += content.length + 1;
            return [syntaxToken];
          })
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
          contents: `export default [{ name: ${JSON.stringify(args.path)}, scopeName: 'test.' + ${JSON.stringify(args.path)}, patterns: [],
            repository: { fenced_code_block_latex: { begin: '(?:la|)tex', patterns: [{ patterns: [] }] } } }];`
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
      content: ':root{--meo-background:#fff;--meo-foreground:#24292f;--meo-code-background:#f4f4f4;--meo-surface-background:#fff;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--meo-line-height-live:1.6;--meo-line-height-source:1.5;--meo-token-foreground-color:#24292f;--meo-token-monospace-color:#0550ae}'
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
    await page.waitForSelector('#first .meo-source-token');
    let initial = await readMetrics(page);
    assert.equal(initial.initCalls, 1);
    assert.equal(initial.tokenizeCalls, 1, 'Source tokenizes the whole Markdown document once');
    assert.deepEqual(initial.instances[0].loadedLanguages.sort(), ['html', 'html-derivative', 'markdown', 'meo-math', 'typescript', 'yaml']);
    assert.deepEqual(initial.instances[0].tokenizedCodes, [firstText]);

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
    assert.equal(metrics.initCalls, 2, 'Live owns a separate shared runtime');
    assert.equal(metrics.instances[0].disposeCalls, 0, 'The editor session retains Source across mode switches');
    assert.deepEqual(metrics.instances[1].loadedLanguages, ['typescript']);
    assert.equal(metrics.instances[1].tokenizeCalls, 2, 'Two Live consumers share grammar and tokenize each distinct fence');
    assert.equal(metrics.instances[1].disposeCalls, 0);

    const latestSecondCode = Array.from(
      { length: 24 },
      (_, index) => `const latest_second_${index} = ${index};`
    ).join('\n');
    const latestSecondText = secondText.replace('const second_value = 2;', latestSecondCode);
    const pendingSecondPresentation = await page.evaluate((latestCode) => {
      const state = (window as any).__shikiEditors;
      const harness = (window as any).SourceLightweightShikiHarness;
      state.first.setMode('source');
      state.first.setMode('source');
      const previousCode = 'const second_value = 2;';
      const from = state.second.view.state.doc.toString().indexOf(previousCode);
      harness.pasteText(state.second, from, from + previousCode.length, latestCode);
      const line = Array.from(document.querySelectorAll<HTMLElement>('#second .cm-line'))
        .find((candidate) => candidate.textContent?.includes('latest_second_23'));
      const matchingSpans = Array.from(line?.querySelectorAll<HTMLElement>('span') ?? [])
        .filter((candidate) => candidate.textContent?.includes('latest_second_23'));
      const presentationNode = matchingSpans.at(-1) ?? line;
      return presentationNode ? getComputedStyle(presentationNode).color : null;
    }, latestSecondCode);
    assert.deepEqual(
      pendingSecondPresentation,
      'rgb(170, 34, 85)',
      'Pasting into an existing code block must retain its presentation until new tokens are ready'
    );
    // Current tokens have a different color so retained old spans cannot satisfy
    // the readiness check before the remaining consumer has really tokenized.
    await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>('#second span[style*="color:"]'))
      .some((node) => node.children.length === 0 && node.textContent?.includes('latest_second_23')
        && getComputedStyle(node).color === 'rgb(51, 136, 85)'));
    metrics = await readMetrics(page);
    await page.waitForSelector('#first .meo-source-token');
    metrics = await readMetrics(page);
    assert.equal(metrics.initCalls, 2, 'Returning to Source reuses the session runtime');
    assert.equal(metrics.instances[1].tokenizeCalls, 3, 'The remaining Live consumer produces latest code tokens');
    assert.equal(metrics.instances[1].disposeCalls, 0, 'Live 2→1 consumers keeps its runtime');
    assert.ok(metrics.instances[0].tokenizedCodes.includes(firstText), 'Source retains its own whole-document tokens');

    await page.evaluate(() => {
      const state = (window as any).__shikiEditors;
      state.second.setMode('source');
      state.second.setMode('source');
    });
    await waitForFrames(page);
    metrics = await readMetrics(page);
    assert.equal(metrics.instances[1].disposeCalls, 0, 'The editor session retains Live across mode switches');
    assert.equal(metrics.instances[0].disposeCalls, 0, 'Two editor sessions retain the shared Source runtime');
    assert.ok(metrics.instances[0].tokenizedCodes.includes(latestSecondText));

    // Hidden Source owns a whole-document scope stack, but must defer all work
    // until reveal and publish only the latest revision.
    await page.evaluate(() => {
      document.getElementById('first')!.hidden = true;
      (window as any).__shikiEditors.first.view.requestMeasure();
    });
    await page.waitForFunction(() => !(window as any).__shikiEditors.first.view.inView);
    const beforeHiddenSource = (await readMetrics(page)).tokenizeCalls;
    const sourceRevision = (name: string) => '# Source ' + name + '\n\n' + Array.from({ length: 30 }, (_, index) =>
      '```typescript\nconst source_' + name + '_' + index + ' = 1;\n```').join('\n\n');
    for (const revision of ['old', 'latest']) {
      await page.evaluate(text => (window as any).__shikiEditors.first.setText(text), sourceRevision(revision));
      await waitForFrames(page);
      assert.equal((await readMetrics(page)).tokenizeCalls, beforeHiddenSource, 'Hidden Source must do zero token work');
    }
    await page.evaluate(() => {
      document.getElementById('first')!.hidden = false;
      (window as any).__shikiEditors.first.view.requestMeasure();
    });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#first .meo-source-token')).some(node => node.textContent?.includes('source_latest_0')));
    await page.waitForFunction(() => (window as any).__shikiLifecycleMetrics.instances[0].tokenizedCodes.some((code: string) => code.includes('source_latest_0')));
    metrics = await readMetrics(page);
    assert.ok(metrics.instances[0].tokenizedCodes.some(code => code.includes('source_latest_0')));
    assert.equal(metrics.instances[0].tokenizedCodes.some(code => code.includes('source_old_0')), false);

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
    await waitForFrames(page);
    metrics = await readMetrics(page);
    assert.equal(metrics.instances[0].disposeCalls, 0, 'The remaining Source consumer retains its independent runtime');
    assert.equal(metrics.instances.filter(instance => instance.disposeCalls === 0).length, 2,
      'Rapid changes leave exactly one active runtime per live surface');
    assert.equal(
      await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('#first span[style*="color:"]'))
        .some((node) => node.textContent?.includes('first_value'))),
      false,
      'stale completion must not restore old token DOM'
    );

    // Preview keeps its editor alive but hidden. External revisions must not
    // expand highlighting to that hidden editor's whole-document viewport.
    await page.evaluate(() => {
      document.getElementById('first')!.hidden = true;
      (window as any).__shikiEditors.first.view.requestMeasure();
    });
    await page.waitForFunction(() => !(window as any).__shikiEditors.first.view.inView);
    const beforeHidden = (await readMetrics(page)).tokenizeCalls;
    const hiddenText = (revision: string) => '# Hidden revision\n\n' + Array.from(
      { length: 30 },
      (_, index) => '```typescript\nconst hidden_' + revision + '_' + index + ' = ' + index + ';\n```'
    ).join('\n\n');
    await page.evaluate((text) => (window as any).__shikiEditors.first.setText(text), hiddenText('old'));
    await waitForFrames(page);
    await page.evaluate((text) => (window as any).__shikiEditors.first.setText(text), hiddenText('latest'));
    await waitForFrames(page);
    const afterHidden = (await readMetrics(page)).tokenizeCalls;
    assert.equal(afterHidden, beforeHidden + 5,
      'Hidden revisions must maintain known blocks and prepare at most one unseen block per revision');

    await page.evaluate(() => {
      const state = (window as any).__shikiEditors;
      state.second.setText('# Visible\n\n```typescript\nconst still_visible = 7;\n```');
    });
    await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>('#second span[style*="color:"]'))
      .some(node => node.textContent?.includes('still_visible')));
    assert.equal((await readMetrics(page)).tokenizeCalls, afterHidden + 1,
      'Hiding one editor must not pause another consumer');

    await page.evaluate(() => {
      document.getElementById('first')!.hidden = false;
      (window as any).__shikiEditors.first.view.requestMeasure();
    });
    await page.waitForFunction(() => (window as any).__shikiEditors.first.view.inView
      && Array.from(document.querySelectorAll<HTMLElement>('#first span[style*="color:"]'))
        .some(node => node.textContent?.includes('hidden_latest_0')));
    await waitForFrames(page);
    assert.ok((await readMetrics(page)).tokenizeCalls < afterHidden + 31,
      'Reveal must highlight the visible band rather than shift all hidden work to mode switching');
    assert.equal(await page.evaluate(() => document.getElementById('first')!.textContent!.includes('hidden_old_')), false);

    await page.evaluate(() => {
      document.getElementById('first')!.hidden = true;
      (window as any).__shikiEditors.first.view.requestMeasure();
    });
    await page.waitForFunction(() => !(window as any).__shikiEditors.first.view.inView);
    const beforeLanguageChange = (await readMetrics(page)).tokenizeCalls;
    await page.evaluate(() => {
      const editor = (window as any).__shikiEditors.first;
      editor.setText(editor.view.state.doc.toString().replace('```typescript', '```javascript'));
    });
    await waitForFrames(page);
    const languageChangeCalls = (await readMetrics(page)).tokenizeCalls - beforeLanguageChange;
    assert.ok(languageChangeCalls >= 1 && languageChangeCalls <= 2,
      'A language change must refresh the known block and prepare at most one unseen block');

    const beforeTheme = await readMetrics(page);
    const beforeThemeChange = beforeTheme.tokenizeCalls;
    await page.evaluate(() => { (window as any).__lifecycleColor = '#2255aa'; (window as any).SourceLightweightShikiHarness.applyTheme('#2255aa'); });
    await waitForFrames(page);
    metrics = await readMetrics(page);
    assert.equal(metrics.initCalls, beforeTheme.initCalls + 2, 'Theme invalidation refreshes both active surfaces');
    assert.ok(metrics.tokenizeCalls > beforeThemeChange
      && metrics.tokenizeCalls < beforeThemeChange + 31,
    'A theme change must refresh known presentations without requesting every hidden fence');
    await page.evaluate(() => {
      document.getElementById('first')!.hidden = false;
      (window as any).__shikiEditors.first.view.requestMeasure();
    });
    await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>('#first span[style*="color:"]'))
      .some(node => node.textContent?.includes('hidden_latest_0')
        && getComputedStyle(node).color === 'rgb(34, 85, 170)'));
    await page.evaluate(() => { const editor = (window as any).__shikiEditors.second; editor.setMode('live'); editor.setText('# No code yet'); });
    await waitForFrames(page);
    await page.evaluate(() => {
      document.getElementById('second')!.hidden = true;
      (window as any).__shikiEditors.second.view.requestMeasure();
    });
    await page.waitForFunction(() => !(window as any).__shikiEditors.second.view.inView);
    // A hidden editor may receive its first supported block after initial layout.
    // An unsupported fence before it must not consume the one-block preparation.
    const introducedText = '```unsupported-test-language\nplain text\n```\n\n' + hiddenText('introduced');
    await page.evaluate((text) => (window as any).__shikiEditors.second.setText(text), introducedText);
    await waitForFrames(page);
    assert.deepEqual((await readMetrics(page)).instances.flatMap(instance => instance.tokenizedCodes)
      .filter(code => code.includes('hidden_introduced_')), ['const hidden_introduced_0 = 0;'],
      'A hidden editor must prepare the first supported block without cascading into all unseen blocks');
    await page.evaluate(() => {
      document.getElementById('second')!.hidden = false;
      (window as any).__shikiEditors.second.view.requestMeasure();
    });
    await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>('#second span[style*="color:"]'))
      .some(node => node.textContent?.includes('hidden_introduced_0')
        && getComputedStyle(node).color === 'rgb(34, 85, 170)'));
    await page.evaluate(() => (window as any).__shikiEditors.second.setText('```typescript\nconst existing_small = 1;\n```'));
    await waitForFrames(page);
    await page.evaluate(() => {
      document.getElementById('second')!.hidden = true;
      (window as any).__shikiEditors.second.view.requestMeasure();
    });
    await page.waitForFunction(() => !(window as any).__shikiEditors.second.view.inView);
    await page.evaluate((text) => {
      const editor = (window as any).__shikiEditors.second;
      editor.setText(editor.view.state.doc.toString() + '\n\n' + text);
    }, hiddenText('after_cached'));
    await waitForFrames(page);
    assert.deepEqual((await readMetrics(page)).instances.flatMap(instance => instance.tokenizedCodes)
      .filter(code => code.includes('hidden_after_cached_')), ['const hidden_after_cached_0 = 0;'],
      'Cached or known blocks must not consume the one unseen-block preparation');
    for (const mode of ['source', 'live']) {
      await page.evaluate((mode) => {
        const state = (window as any).__shikiEditors;
        const editor = state.first;
        document.getElementById('first')!.hidden = false;
        editor.setMode(mode);
        editor.view.requestMeasure();
        (window as any).__cancelledBatchCalls = 0;
        (window as any).__onShikiTokenize = (code: string) => {
          if (!code.includes('pending_batch_')) return;
          (window as any).__cancelledBatchCalls++;
          if ((window as any).__cancelledBatchCalls === 1) queueMicrotask(() => {
            editor.setText('# Replacement\n\n\u0060\u0060\u0060typescript\nconst current_batch_' + mode + ' = 1;\n\u0060\u0060\u0060');
          });
        };
        editor.setText('\u0060\u0060\u0060typescript\n' + Array.from({length: 410}, (_, index) =>
          'const pending_batch_' + mode + '_' + index + ' = 1;').join('\n') + '\n\u0060\u0060\u0060');
      }, mode);
      await page.waitForFunction((mode) => Array.from(document.querySelectorAll('#first span[style*="color:"]'))
        .some(node => node.textContent?.includes('current_batch_' + mode)), {}, mode);
      await waitForFrames(page);
      assert.equal(await page.evaluate(() => (window as any).__cancelledBatchCalls), 1,
        mode + ' must stop obsolete document tokenization while another editor remains active');
      await page.evaluate(() => { delete (window as any).__onShikiTokenize; });
    }
    const scrollBounds = await page.evaluate(async () => {
      const editor = (window as any).__shikiEditors.first;
      editor.setText([...Array.from({ length: 240 }, (_, i) => `ssr ${i}`), '',
        '```typescript', 'const cold_scroll_highlight = 1;', '```', '',
        ...Array.from({ length: 30 }, (_, i) => `tail ${i}`)].join('\n'));
      editor.view.scrollDOM.scrollTop = 0;
      for (let n = 0; n < 8; n++) {
        editor.view.scrollDOM.dispatchEvent(new WheelEvent('wheel', { deltaY: 1 }));
        await new Promise(requestAnimationFrame);
      }
      const rect = editor.view.scrollDOM.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(scrollBounds.x, scrollBounds.y);
    await page.mouse.wheel({ deltaY: 5300 });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#first .cm-line'))
      .some(line => line.textContent?.includes('cold_scroll_highlight')));
    for (let n = 0; n < 5; n++) {
      await page.mouse.wheel({ deltaY: 1 });
      await new Promise(resolve => setTimeout(resolve, 80));
      assert.equal((await readMetrics(page)).instances.some(instance =>
        instance.tokenizedCodes.some(code => code.trim() === 'const cold_scroll_highlight = 1;')), false,
      'A newly encountered Live fence must not tokenize during continuous native scrolling');
      assert.equal((await readMetrics(page)).instances.some(instance =>
        instance.tokenizedCodes.some(code => code.startsWith('ssr 0'))), false,
      'Background Source preparation must yield to continuous Live scrolling too');
    }
    await page.waitForFunction(() => (window as any).__shikiLifecycleMetrics.instances.some((instance: any) =>
      instance.tokenizedCodes.some((code: string) => code.trim() === 'const cold_scroll_highlight = 1;')));
    await page.waitForFunction(() => (window as any).__shikiLifecycleMetrics.instances.some((instance: any) =>
      instance.tokenizedCodes.some((code: string) => code.startsWith('ssr 0'))));
    const foregroundTransition = await page.evaluate(async () => {
      const editor = (window as any).__shikiEditors.first;
      const harness = (window as any).SourceLightweightShikiHarness;
      editor.setText('# Cold mode transition\n\n' + editor.getText());
      const anchor = editor.getText().indexOf('cold_scroll_highlight');
      editor.view.dispatch({ selection: { anchor, head: anchor + 'cold_scroll_highlight'.length } });
      const selection = JSON.stringify(editor.view.state.selection.toJSON());
      const markScrolling = () => editor.view.scrollDOM.dispatchEvent(new WheelEvent('wheel', { deltaY: 1 }));
      markScrolling();
      const timer = setInterval(markScrolling, 50);
      try {
        // Use the same preparation boundary as index.ts before exposing Source.
        const prepared = await editor.prepareSourceSyntax(() => true);
        const liveCoverRetained = editor.view.dom.classList.contains('meo-mode-live');
        editor.setMode('source');
        const sourcePaintedImmediately = Boolean(editor.view.contentDOM.querySelector('.meo-source-token'));
        editor.setMode('live');
        const beforeCachedReturn = (window as any).__shikiLifecycleMetrics.tokenizeCalls;
        const cached = await editor.prepareSourceSyntax(() => true);
        editor.setMode('source');
        const cacheReused = beforeCachedReturn === (window as any).__shikiLifecycleMetrics.tokenizeCalls;
        editor.setMode('live');
        return { prepared, cached, liveCoverRetained, sourcePaintedImmediately, cacheReused,
          hasSourceTokens: harness.hasSourceTokens(editor),
          selectionRetained: selection === JSON.stringify(editor.view.state.selection.toJSON()) };
      } finally { clearInterval(timer); }
    });
    assert.deepEqual(foregroundTransition, {
      prepared: true, cached: true, liveCoverRetained: true, sourcePaintedImmediately: true,
      cacheReused: true, hasSourceTokens: true, selectionRetained: true
    }, 'Explicit mode changes must finish during scrolling, retain prepared paint and reuse tokens on return');
    const highlighterCount = (await readMetrics(page)).initCalls;

    await page.evaluate(() => {
      const state = (window as any).__shikiEditors;
      const view = state.first.view;
      view.scrollDOM.dispatchEvent(new WheelEvent('wheel', { deltaY: 1 }));
      const from = view.state.doc.toString().indexOf('cold_scroll_highlight');
      view.dispatch({ changes: { from, to: from + 'cold_scroll_highlight'.length, insert: 'cancelled_scroll_highlight' } });
      state.second.destroy();
      state.first.destroy();
    });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal((await readMetrics(page)).instances.some(instance =>
      instance.tokenizedCodes.some(code => code.trim() === 'const cancelled_scroll_highlight = 1;')), false,
    'Destroying the Live editor must cancel its deferred fence refresh');
    await page.waitForFunction((count) => (window as any).__shikiLifecycleMetrics.disposeCalls === count, {}, highlighterCount);
    metrics = await readMetrics(page);
    assert.equal(metrics.disposeCalls, highlighterCount);
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
