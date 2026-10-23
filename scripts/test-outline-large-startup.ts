import assert from 'node:assert/strict';
import fs from 'node:fs';
import { closeTestBrowser } from './browser-test-helpers';
import { browser, server, open, frames } from './input-presentation-test-helpers';

const count = 1_300;
const text = '# Cold outline\n\n' + Array.from({ length: count }, (_, index) =>
  `## Section ${index}\n\n${'A long paragraph with **formatted** text and an inline `code` witness. '.repeat(14)}\n\n`
  + '```markdown\n# Literal fenced heading\n```\n\n').join('');
fs.mkdirSync('.local/outline-startup', { recursive: true });
let primaryError: unknown;
async function initialPreview() {
  const page = await browser.newPage();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const opening = open(page, '# 目录加载测试\n\n## 子标题\n\n正文。', false, 'preview', {
    outlineVisible: true, uiLanguage: 'zh-CN', beforePreviewRender: async () => { entered(); await held; }
  });
  try {
    await started;
    await page.waitForFunction(() => document.querySelector('.outline-empty')?.textContent === '正在生成目录…');
    await page.waitForFunction(() => !document.querySelector('.meo-preload-editor-shell')
      && !document.querySelector('.meo-preload-toolbar')
      && !document.querySelector<HTMLElement>('.preview-loading')?.hidden, { timeout: 2_000 });
    await frames(page);
    await page.screenshot({ path: '.local/outline-startup/preview-loading.png' });
    release();
    const host = await opening;
    await page.waitForFunction(() => document.querySelectorAll('.outline-item').length === 2
      && document.querySelector('.outline-content')?.getAttribute('aria-busy') === 'false');
    assert.deepEqual(host.errors, []);
    host.dispose();
    console.log('Initial Preview outline waits for accepted heading metadata');
  } finally { release(); await opening.catch(() => {}); await page.close(); }
}
try {
  await initialPreview();
  for (const mode of ['live', 'source'] as const) {
    const page = await browser.newPage();
    const host = await open(page, text, false, mode, { outlineVisible: true });
    try {
      assert.equal(await page.$eval('#app', e => (e as HTMLElement).dataset.mode), mode);
      await page.waitForFunction(count => document.querySelectorAll('.outline-item').length === count + 1,
        { timeout: 3_000 }, count).catch(() => {});
      const live = await page.evaluate(() => ({ rows: document.querySelectorAll('.outline-item').length,
        busy: document.querySelector('.outline-content')?.getAttribute('aria-busy'),
        text: document.querySelector('.outline-content')?.textContent?.slice(0, 160) }));
      console.log(`Cold ${mode} outline:`, JSON.stringify(live), 'bytes:', Buffer.byteLength(text));
      assert.equal(live.rows, count + 1, 'Cold startup must publish the complete outline without visiting Preview');
      assert.equal(live.busy, 'false', 'Complete outline must not remain in a pending loop');
      assert.equal(host.renders.length, 0, 'A large Live outline must not require hidden Preview rendering');
      await page.screenshot({ path: `.local/outline-startup/${mode}.png` });
      await page.evaluate(() => { (window as any).__outlineWitness = [...document.querySelectorAll<HTMLElement>('.outline-item')]
        .find(e => e.dataset.tooltip === 'Section 1'); });
      const prefix = 'An ordinary paragraph inserted before the headings.\n\n';
      await host.replaceHostText(prefix + text);
      await page.waitForFunction(from => [...document.querySelectorAll<HTMLElement>('.outline-item')]
        .some(e => e.dataset.tooltip === 'Section 1' && e.dataset.headingFrom === String(from)),
      {}, prefix.length + text.indexOf('## Section 1\n'));
      assert.equal(await page.evaluate(() => (window as any).__outlineWitness.isConnected), true,
        'Unchanged outline rows must survive ordinary edits even when source positions shift');
      await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.outline-item')]
        .find(e => e.dataset.tooltip === 'Section 1')!.click());
      await page.waitForFunction(from => {
        const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
        const coords = view.coordsAtPos(from), bounds = view.scrollDOM.getBoundingClientRect();
        return coords && coords.top >= bounds.top - 2 && coords.top <= bounds.top + 24;
      }, {}, prefix.length + text.indexOf('## Section 1\n'));
      // Folding is UI state and must survive body edits that merely move headings.
      await page.click('.outline-header [data-action="collapse-top2"]');
      assert.equal(await page.$$eval('.outline-item', items => items.length), 1);
      await host.replaceHostText(prefix + text + '\nAnother body paragraph.\n');
      await page.waitForFunction(() => document.querySelector('.outline-content')?.getAttribute('aria-busy') === 'false');
      assert.equal(await page.$$eval('.outline-item', items => items.length), 1);
      await page.click('.outline-header [data-action="expand-all"]');
      await page.click('[data-mode="preview"]');
      await page.waitForFunction(count => document.querySelectorAll('.outline-item').length === count + 1,
        {}, count);
      await frames(page, 6);
      console.log('Preview outline:', await page.$$eval('.outline-item', items => items.length));
      await page.click('[data-mode="live"]');
      await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'live');
      const small = '---\nname: "# hidden"\n---\n\n# **New** *title*\n\nSetext heading\n---\n\n```markdown\n# Literal\n```\n';
      await host.replaceHostText(small);
      await page.waitForFunction(() => document.querySelectorAll('.outline-item').length === 2
        && document.querySelector('.outline-content')?.getAttribute('aria-busy') === 'false');
      assert.deepEqual(await page.$$eval('.outline-item', items => items.map(e => e.textContent)), ['New title', 'Setext heading']);
      assert.equal(await page.$eval('.outline-item strong', e => e.textContent), 'New');
      assert.equal(await page.$eval('.outline-item em', e => e.textContent), 'title');
      for (const empty of ['A document without any headings.\n', '']) {
        await host.replaceHostText(empty);
        await page.waitForFunction(() => document.querySelectorAll('.outline-item').length === 0
          && document.querySelector('.outline-content')?.getAttribute('aria-busy') === 'false');
        assert.equal(await page.$eval('.outline-empty', e => e.textContent), 'No headings');
      }
      assert.deepEqual(host.errors, []);
      console.log(`Large ${mode} startup, row retention, navigation, folding, mode changes and empty outline passed`);
    } finally { host.dispose(); await page.close(); }
  }
} catch (error) { primaryError = error; }
finally { server.stop(true); if (primaryError === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primaryError); }
