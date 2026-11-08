import assert from 'node:assert/strict';
import fs from 'node:fs';
import { closeTestBrowser } from './browser-test-helpers';

// A body class alone does not exercise Chromium's accessibility tree costs.
process.env.MEO_TEST_FORCE_RENDERER_ACCESSIBILITY = process.argv.includes('--normal-launch') ? '0' : '1';
const { browser, server, open, frames } = await import('./input-presentation-test-helpers');
const rows = Array.from({ length: 18_000 }, (_, index) =>
  index === 0 ? '/* comment spanning reading windows' : index === 9001 ? '*/'
    : index === 1234 ? '' : index === 9003 ? 'const 文本 = "中文🙂";'
    : index === 17998 ? 'const wrapped = "' + 'long content '.repeat(30) + '";'
    : `const row${index} = { text: "content", number: 123 };`);
const source = rows.join('\n');
let primary: unknown;
try {
  assert.equal(browser.process()!.spawnargs.includes('--force-renderer-accessibility'),
    process.env.MEO_TEST_FORCE_RENDERER_ACCESSIBILITY === '1');
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    const observer = new MutationObserver(() => {
      if (!document.body) return;
      document.body.classList.add('vscode-using-screen-reader');
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  const host = await open(page, '# Accessible code\n\n```javascript\n' + source + '\n```\n\nAfter the code.');
  const ready = () => page.waitForFunction(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    return document.querySelector<HTMLElement>('#app')?.dataset.mode === 'preview'
      && !document.querySelector('.mode-group [aria-busy="true"]')
      && document.querySelector<HTMLElement>('.preview-status')?.hidden
      && !document.querySelector<HTMLElement>('.preview-host')?.hidden
      && doc?.readyState === 'complete' && !doc.documentElement.inert
      && !!doc.querySelector('main.meo-export-doc') && doc.defaultView!.getComputedStyle(doc.body).display !== 'none';
  }, { timeout: 10_000 });
  try {
    for (const stage of ['cold', 'warm']) {
      const started = performance.now();
      await page.click('.mode-group [data-mode="preview"]');
      await ready(); await frames(page);
      const ms = performance.now() - started;
      const state = await page.evaluate(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        const lines = [...doc.querySelectorAll<HTMLElement>('.meo-export-code-line-source')];
        return { count: lines.length, nodes: doc.querySelectorAll('*').length,
          source: lines.map(line => line.textContent).join('\n') };
      });
      console.log(JSON.stringify({ launch: process.env.MEO_TEST_FORCE_RENDERER_ACCESSIBILITY === '1' ? 'forced accessibility' : 'normal',
        stage, ms, nodes: state.nodes, rows: state.count }));
      assert.equal(state.count, rows.length, 'Screen readers must receive every authored code line, including offscreen lines');
      assert.equal(state.source, source);
      assert.ok(state.nodes < rows.length + 4000, 'Complete accessible code must avoid per-line wrapper/gutter and whole-fence fallback token trees');
      assert.ok(ms < (stage === 'cold' ? 5000 : 3000), `${stage} accessible Preview exceeded its switch budget (${ms}ms)`);
      if (stage === 'cold') {
        // A warm switch starts after the first visible syntax band has settled.
        await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
          .querySelector<HTMLElement>('.meo-export-code-line-source')?.dataset.meoShiki);
        await page.click('.mode-group [data-mode="source"]');
        await page.waitForFunction(() => document.querySelector('.meo-mode-source') && !document.querySelector('.mode-group [aria-busy="true"]'));
      }
    }
    const client = await page.createCDPSession();
    try {
      const { frameTree } = await client.send('Page.getFrameTree');
      const frameId = frameTree.childFrames![0]!.frame.id;
      const { nodes } = await client.send('Accessibility.getFullAXTree', { frameId });
      const text = nodes.filter(node => node.role?.value === 'StaticText' && !node.ignored).map(node => node.name?.value ?? '').join('');
      assert.ok(text.includes('row9000'), 'The actual accessibility tree exposes middle code without scrolling');
      assert.ok(text.includes('row17999'), 'The actual accessibility tree exposes final code without scrolling');
      assert.ok(!nodes.some(node => !node.ignored && node.role?.value === 'StaticText' && node.name?.value === '18000'),
        'Decorative line numbers must not be announced');
    } finally { await client.detach(); }
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value: string) => { (window as any).__copiedCode = value; }
    } }));
    await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
      .querySelector<HTMLButtonElement>('.meo-copy-code-btn')!.click());
    await page.waitForFunction(() => typeof (window as any).__copiedCode === 'string');
    assert.equal(await page.evaluate(() => (window as any).__copiedCode), source);
    await page.click('[data-action="find"]');
    await page.waitForSelector('.find-panel.is-visible');
    await page.focus('.find-input'); await page.keyboard.type('row17999'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const match = doc.querySelector('.meo-preview-search-match.is-active'), rect = match?.getBoundingClientRect();
      return match?.textContent === 'row17999' && rect && rect.bottom > 0 && rect.top < doc.defaultView!.innerHeight;
    });
    await page.click('.find-close-button');
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
      .querySelector<HTMLElement>('.meo-export-code-line-source:last-child')?.dataset.meoShiki);
    await page.setViewport({ width: 480, height: 900 }); await frames(page);
    const wrapped = await page.evaluate(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const lines = [...doc.querySelectorAll<HTMLElement>('.meo-export-code-line-source')];
      const previous = lines[17998]!, last = lines[17999]!;
      return { height: previous.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(doc.defaultView!.getComputedStyle(previous).lineHeight),
        gap: last.getBoundingClientRect().top - previous.getBoundingClientRect().bottom };
    });
    assert.ok(wrapped.height > wrapped.lineHeight * 2, 'Compact code retains multiline wrapping at narrow widths');
    assert.ok(Math.abs(wrapped.gap) < 1, 'Wrapped rows keep continuous source geometry');
    fs.mkdirSync('.local/input-presentation', { recursive: true });
    await page.screenshot({ path: '.local/input-presentation/preview-code-accessibility.png' });
    await page.evaluate(() => document.body.classList.remove('vscode-using-screen-reader'));
    await page.waitForFunction(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
      return doc?.documentElement.dataset.meoPreviewWindowed === 'true'
        && doc.querySelectorAll('.meo-export-code-line-source').length <= 256;
    });
    await ready();
    await page.evaluate(() => document.body.classList.add('vscode-using-screen-reader'));
    await page.waitForFunction(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
      return doc?.documentElement.dataset.meoPreviewWindowed === 'false'
        && doc.querySelectorAll('.meo-export-code-line-source').length === 18_000;
    });
    await ready();
    assert.deepEqual(host.errors, []);
    console.log('Accessible giant Preview: full AX text, bounded markup, copy, deep search, warm switching and runtime screen-reader changes passed');
  } finally { host.dispose(); await page.close(); }
} catch (error) { primary = error; throw error; }
finally { server.stop(true); if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary); }
