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
let stage = 'initial';
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
      await page.waitForFunction(() => document.querySelectorAll('.outline-item').length > 0
        && document.querySelector('.outline-content')?.getAttribute('aria-busy') === 'false', { timeout: 3_000 });
      const live = await page.evaluate(() => ({ rows: document.querySelectorAll('.outline-item').length,
        busy: document.querySelector('.outline-content')?.getAttribute('aria-busy'),
        text: document.querySelector('.outline-content')?.textContent?.slice(0, 160) }));
      console.log(`Cold ${mode} outline:`, JSON.stringify(live), 'bytes:', Buffer.byteLength(text));
      assert.ok(live.rows > 0 && live.rows <= 120,
        `Cold startup must keep mounted outline rows bounded while retaining complete navigation: ${live.rows}`);
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
      await frames(page, 4);
      const outlinePoint = await page.$eval('.outline-content', element => {
        const rect = element.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      });
      const scrollOutline = async (direction: number) => {
        await page.mouse.move(outlinePoint.x, outlinePoint.y);
        await page.mouse.wheel({ deltaY: direction * 100_000 });
        await frames(page, 4);
      };
      stage = `${mode} deep outline scroll`; await scrollOutline(1);
      await page.waitForSelector(`.outline-item[data-tooltip="Section ${count - 1}"]`);
      assert.ok(await page.$$eval('.outline-item', items => items.length) <= 120, 'Deep outline scrolling retains the DOM budget');
      assert.deepEqual(await page.$eval(`.outline-item[data-tooltip="Section ${count - 1}"]`, item => {
        const row = item.closest('li')!;
        return [row.getAttribute('aria-posinset'), row.getAttribute('aria-setsize'), item.closest('.outline-tree-children') !== null];
      }), [String(count), String(count), true], 'Virtual rows retain full sibling metadata and hierarchy');
      stage = `${mode} deep navigation`; await page.locator(`.outline-item[data-tooltip="Section ${count - 1}"]`).click();
      await page.waitForFunction(from => {
        const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
        const coords = view.coordsAtPos(from), bounds = view.scrollDOM.getBoundingClientRect();
        // The final heading cannot align to the top when the remaining source
        // is shorter than a viewport. Native end-of-document clamping wins.
        return coords && coords.top >= bounds.top - 2 && coords.bottom <= bounds.bottom + 2;
      }, {}, prefix.length + text.indexOf(`## Section ${count - 1}\n`));
      await frames(page, 4);
      // Heading navigation deliberately returns focus to the editor. Establish
      // the independent keyboard-reading target before scrolling its pane.
      await page.focus(`.outline-item[data-tooltip="Section ${count - 1}"]`);
      await scrollOutline(-1);
      assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.tooltip), `Section ${count - 1}`,
        'Native outline scrolling must retain the focused row outside the reading window');
      assert.ok(await page.$$eval('.outline-item', items => items.length) <= 121);
      stage = `${mode} keyboard crossing`;
      await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
      await page.waitForFunction(label => (document.activeElement as HTMLElement)?.dataset.tooltip === label, {}, `Section ${count - 2}`);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.tooltip), `Section ${count - 1}`);
      await scrollOutline(-1);
      await page.locator('.outline-item[data-tooltip="Cold outline"]').click();
      await frames(page, 4);
      // Folding is UI state and must survive body edits that merely move headings.
      await page.click('.outline-header [data-action="collapse-top2"]');
      assert.equal(await page.$$eval('.outline-item', items => items.length), 1);
      await host.replaceHostText(prefix + text + '\nAnother body paragraph.\n');
      await page.waitForFunction(() => document.querySelector('.outline-content')?.getAttribute('aria-busy') === 'false');
      assert.equal(await page.$$eval('.outline-item', items => items.length), 1);
      await page.click('.outline-header [data-action="expand-all"]');
      await page.click('[data-mode="preview"]');
      await page.waitForFunction(() => document.querySelectorAll('.outline-item').length > 0
        && document.querySelectorAll('.outline-item').length <= 120
        && document.querySelector('.outline-content')?.getAttribute('aria-busy') === 'false');
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
      for (const headings of [160, 161]) {
        await host.replaceHostText(Array.from({ length: headings }, (_, index) => `# Boundary ${index}\n\nBody\n\n`).join(''));
        await page.waitForFunction(() => document.querySelector('.outline-item')?.textContent === 'Boundary 0'
          && document.querySelector('.outline-content')?.getAttribute('aria-busy') === 'false');
        const mounted = await page.$$eval('.outline-item', items => items.length);
        assert.ok(headings === 160 ? mounted === 160 : mounted <= 120, 'Growing past the outline budget must switch to a bounded window');
      }
      for (const empty of ['A document without any headings.\n', '']) {
        await host.replaceHostText(empty);
        await page.waitForFunction(() => document.querySelectorAll('.outline-item').length === 0
          && document.querySelector('.outline-content')?.getAttribute('aria-busy') === 'false');
        assert.equal(await page.$eval('.outline-empty', e => e.textContent), 'No headings');
      }
      assert.deepEqual(host.errors, []);
      console.log(`Large ${mode} startup, row retention, navigation, folding, mode changes and empty outline passed`);
    } catch (error) {
      console.error(stage, await page.evaluate(() => {
        const pane = document.querySelector('.outline-content')!;
        const items = [...pane.querySelectorAll<HTMLElement>('.outline-item')];
        const view = (document.querySelector('.editor-host .cm-content') as any)?.cmTile?.root?.view;
        return { top: pane.scrollTop, height: pane.scrollHeight, client: pane.clientHeight,
          first: items[0]?.dataset.tooltip, last: items.at(-1)?.dataset.tooltip,
          active: (document.activeElement as HTMLElement)?.dataset.tooltip,
          editor: view?.scrollDOM.scrollTop, visible: view?.viewport };
      })); throw error;
    } finally { host.dispose(); await page.close(); }
  }
} catch (error) { primaryError = error; console.error(stage); }
finally { server.stop(true); if (primaryError === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primaryError); }
