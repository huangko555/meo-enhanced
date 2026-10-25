import assert from 'node:assert/strict';
import { browser, server, open, frames } from './input-presentation-test-helpers';
import { closeTestBrowser } from './browser-test-helpers';
import { preparePreviewDocument } from '../src/export/runtime';

const fixture = (kind: string, count: number) => Array.from({ length: count }, (_, index) =>
  kind === 'blockquote' ? `> Item ${index} with **important text** and [a link](https://example.com).\n>`
    : `${kind === 'ol' ? `${index + 7}.` : '-'} Item ${index} with **important text** and [a link](https://example.com).`).join('\n');
let primary: unknown, stage = 'band geometry';
try {
  for (const preset of ['default', 'newsprint'] as const) for (const kind of ['ul', 'ol', 'blockquote']) {
    const page = await browser.newPage();
    try {
      const prepared = preparePreviewDocument({ markdownText: fixture(kind, 600), sourceDocumentPath: 'C:/container.md', uiLanguage: 'en', preset }, true);
      const measure = async (html: string) => {
        await page.setContent(`<html data-meo-preview-preset="${preset}"><style>${prepared.styles.dark}</style><main class="meo-export-doc">${html}</main></html>`);
        return page.evaluate(kind => [...document.querySelectorAll<HTMLElement>(`main > ${kind}`)]
          .flatMap(root => [...root.children].map(child => ({ text: child.textContent, top: child.getBoundingClientRect().top,
            height: child.getBoundingClientRect().height }))), kind);
      };
      const full = await measure(prepared.renderAll().html);
      const banded = await measure(prepared.blocks.map(block => prepared.renderBlock(block.index).html).join(''));
      assert.equal(banded.length, full.length);
      assert.ok(banded.every((row, index) => row.text === full[index]!.text && Math.abs(row.top - full[index]!.top) < 1
        && Math.abs(row.height - full[index]!.height) < 1), `${preset}/${kind}: reading bands preserve complete-renderer geometry`);
    } finally { await page.close(); }
  }
  for (const kind of ['ol', 'blockquote']) {
    stage = `${kind} production`;
    const text = '# Container fixture\n\n' + fixture(kind, 6000) + '\n\nAfter container.';
    const page = await browser.newPage(), host = await open(page, text, false, 'preview');
    try {
      const state = () => page.evaluate(kind => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        const rows = [...doc.querySelectorAll<HTMLElement>(`[data-meo-container-part] > ${kind === 'blockquote' ? 'p' : 'li'}`)];
        const visible = rows.filter(row => { const r = row.getBoundingClientRect(); return r.bottom > 100 && r.top < 800; });
        return { count: rows.length, visible: visible.map(row => row.textContent), line: visible[0]?.dataset.sourceLine,
          top: visible[0]?.getBoundingClientRect().top };
      }, kind);
      assert.ok((await state()).count > 0 && (await state()).count < 256);
      const point = await page.$eval('.preview-frame', element => { const r = element.getBoundingClientRect(); return { x: r.left + 160, y: r.top + 350 }; });
      await page.mouse.move(point.x, point.y); await page.mouse.wheel({ deltaY: 18000 }); await frames(page, 20);
      assert.ok((await state()).count < 256 && Number((await state()).line) > 100);
      stage = `${kind} deep search`;
      await page.click('[data-action="find"]'); await page.waitForSelector('.find-panel.is-visible');
      await page.focus('.find-input'); await page.keyboard.type('Item 5990'); await page.keyboard.press('Enter');
      await page.waitForFunction(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        const match = doc.querySelector('.meo-preview-search-match.is-active'), r = match?.getBoundingClientRect();
        return match?.textContent === 'Item 5990' && r && r.bottom > 0 && r.top < doc.defaultView!.innerHeight;
      });
      await page.click('.find-close-button'); await frames(page, 12);
      const before = await state();
      stage = `${kind} prefix edit`;
      const previousId = host.readPresentation().id;
      await host.replaceHostText('# Added heading\n\n' + text);
      await page.waitForFunction(id => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
        .querySelector<HTMLElement>('main')?.dataset.meoPreviewDocument !== id, {}, previousId);
      await frames(page, 20);
      const after = await state();
      stage = `${kind} edit/resize stability`;
      assert.deepEqual(after.visible, before.visible);
      assert.ok(Math.abs(after.top! - before.top!) < 1, `${kind}: prefix edit retains the reading witness`);
      for (const width of [820, 1280]) {
        await page.setViewport({ width, height: 900 }); await frames(page, 16);
        const result = await state(); assert.ok(result.count < 256 && result.visible.length > 0);
      }
      await page.screenshot({ path: `.local/preview-${kind}-bands-reading.png` });
      stage = `${kind} logical whole-document copy`;
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
          write: async (items: ClipboardItem[]) => { (window as any).__containerCopy = {
            text: await (await items[0]!.getType('text/plain')).text(), html: await (await items[0]!.getType('text/html')).text()
          }; }
        } });
        document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.body.focus({ preventScroll: true });
      });
      await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
      await page.evaluate(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        doc.dispatchEvent(new (doc.defaultView as any).ClipboardEvent('copy', { bubbles: true, cancelable: true }));
      });
      await page.waitForFunction(() => (window as any).__containerCopy);
      const copied = await page.evaluate(kind => {
        const copy = (window as any).__containerCopy, template = document.createElement('template'); template.innerHTML = copy.html;
        return { rows: (copy.text.match(/Item \d+/g) ?? []).length, roots: template.content.querySelectorAll(kind).length };
      }, kind);
      assert.deepEqual(copied, { rows: 6000, roots: 1 }, 'Logical copy includes unmounted content in one semantic container');
      await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentWindow!.getSelection()!.removeAllRanges());
      stage = `${kind} bottom`;
      await page.evaluate(() => {
        const scroll = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!;
        scroll.scrollTop = scroll.scrollHeight;
      });
      await frames(page, 24);
      assert.ok((await state()).visible.some(text => text?.includes('Item 5999')));
      assert.deepEqual(host.errors, []);
    } finally { host.dispose(); await page.close(); }
  }
  console.log('Production list/quote bands preserve geometry, bounded DOM, deep search, prefix edits, resize and bottom intent');
} catch (error) { console.error('Failed stage:', stage); primary = error; throw error; }
finally { server.stop(true); if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary); }
