import assert from 'node:assert/strict';
import { browser, server, open, frames } from './input-presentation-test-helpers';
import { closeTestBrowser } from './browser-test-helpers';

const rows = Array.from({ length: 18000 }, (_, index) => index === 0 ? '/* start spanning comment'
  : index === 10000 ? '*/' : `const row${index} = { text: "content", number: 123 };`);
const source = rows.join('\n');
let primary: unknown;
let stage = 'open';
try {
  const page = await browser.newPage();
  const host = await open(page, '```javascript\n' + source + '\n```', false, 'preview');
  try {
    await page.evaluate(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async (value: string) => { (window as any).__copiedCode = value; },
        write: async (items: ClipboardItem[]) => {
          (window as any).__selectionCopy = { text: await (await items[0]!.getType('text/plain')).text(),
            html: await (await items[0]!.getType('text/html')).text() };
        }
      } });
    });
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
      .querySelector('.meo-export-code-line-source[data-meo-shiki]'), { timeout: 30000 });
    const state = () => page.evaluate(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const rows = [...doc.querySelectorAll<HTMLElement>('.meo-export-code-line-source')];
      const visible = rows.filter(row => { const r = row.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
      return { count: rows.length, visible: visible.map(row => row.textContent),
        line: visible[0]?.dataset.sourceLine, top: visible[0]?.getBoundingClientRect().top,
        seams: [...doc.querySelectorAll<HTMLElement>('[data-meo-code-part]')].slice(1).map(block => {
          const previous = block.previousElementSibling;
          return previous?.matches('[data-meo-code-part]') ? block.getBoundingClientRect().top - previous.getBoundingClientRect().bottom : 0;
        }) };
    });
    assert.ok((await state()).count <= 256);
    stage = 'full code copy';
    await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
      .querySelector<HTMLButtonElement>('.meo-copy-code-btn')!.click());
    await page.waitForFunction(() => typeof (window as any).__copiedCode === 'string');
    assert.equal(await page.evaluate(() => (window as any).__copiedCode), source);
    stage = 'deep search';
    await page.click('[data-action="find"]');
    await page.waitForSelector('.find-panel.is-visible');
    await page.focus('.find-input'); await page.keyboard.type('row9000'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const match = doc.querySelector('.meo-preview-search-match.is-active'), rect = match?.getBoundingClientRect();
      return match?.textContent === 'row9000' && rect && rect.bottom > 0 && rect.top < doc.defaultView!.innerHeight;
    });
    await page.click('.find-close-button'); await frames(page, 12);
    stage = 'deep highlight';
    await page.waitForFunction(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      return doc.querySelector<HTMLElement>('.meo-export-code-line-source[data-source-line="9002"]')?.dataset.meoShiki;
    });
    const color = () => page.evaluate(() => {
      const row = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
        .querySelector<HTMLElement>('.meo-export-code-line-source[data-source-line="9002"]')!;
      return { colors: [...row.querySelectorAll<HTMLElement>('span')].map(span => span.style.color), version: row.dataset.meoShiki };
    });
    const comment = await color();
    assert.equal(new Set(comment.colors).size, 1, 'A deep band inherits the comment opened 9000 lines earlier');
    const before = await state();
    await page.evaluate(() => {
      (window as any).__blankCodeFrames = 0;
      (window as any).__watchCodeFrames = true;
      const tick = () => {
        if (!(window as any).__watchCodeFrames) return;
        const row = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
          .querySelector<HTMLElement>('.meo-export-code-line-source[data-source-line="9002"]');
        if (!row?.dataset.meoShiki || !row.querySelector('span[style]')) (window as any).__blankCodeFrames++;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    stage = 'edit outside mounted window';
    // Same visible text, different grammar context outside the mounted window.
    await host.replaceHostText('```javascript\n' + ['// ordinary comment', ...rows.slice(1)].join('\n') + '\n```');
    await page.waitForFunction(version => {
      const row = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
        .querySelector<HTMLElement>('.meo-export-code-line-source[data-source-line="9002"]');
      return row?.dataset.meoShiki && row.dataset.meoShiki !== version;
    }, { timeout: 30000 }, comment.version);
    assert.ok(new Set((await color()).colors).size > 1, 'Editing the unseen comment opener recolors an unchanged visible band');
    assert.equal(await page.evaluate(() => { (window as any).__watchCodeFrames = false; return (window as any).__blankCodeFrames; }), 0,
      'Every sampled edit frame retains fully themed reading rows');
    const after = await state();
    assert.equal(after.line, before.line);
    assert.ok(Math.abs(after.top! - before.top!) <= 1, JSON.stringify({ before, after }));
    for (const width of [820, 1280]) {
      await page.setViewport({ width, height: 900 }); await frames(page, 16);
      const result = await state();
      assert.ok(result.count < 512 && result.visible.length > 0);
      assert.ok(result.seams.every(gap => Math.abs(gap) < 1), 'Code bands join without visual gaps');
      assert.ok(await page.evaluate(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        return [...doc.querySelectorAll<HTMLElement>('.meo-export-code-line-number')].every(number =>
          number.getBoundingClientRect().height <= Number.parseFloat(doc.defaultView!.getComputedStyle(number).lineHeight) + 1);
      }), 'Line-number width is shared across all bands and never wraps');
    }
    stage = 'cross-band selection copy';
    const selectedText = await page.evaluate(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const rows = [...doc.querySelectorAll<HTMLElement>('.meo-export-code-line-source')];
      const start = rows[0]!, end = rows[40]!;
      const range = doc.createRange(); range.setStartBefore(start); range.setEndAfter(end);
      const selection = doc.defaultView!.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      doc.dispatchEvent(new (doc.defaultView as any).ClipboardEvent('copy', { bubbles: true, cancelable: true }));
      return rows.slice(0, 41).map(row => row.textContent).join('\n');
    });
    await page.waitForFunction(() => (window as any).__selectionCopy);
    const selectedCopy = await page.evaluate(() => (window as any).__selectionCopy);
    assert.equal(selectedCopy.text, selectedText);
    assert.equal((selectedCopy.html.match(/class="meo-export-code-block-wrap"/g) ?? []).length, 1);
    await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentWindow!.getSelection()!.removeAllRanges());
    await page.screenshot({ path: '.local/preview-code-bands-reading.png' });
    stage = 'Source mode roundtrip';
    const beforeMode = await state();
    await page.click('[data-mode="source"]');
    await page.waitForFunction(() => document.querySelector('.meo-mode-source') && !document.querySelector('[data-mode][aria-busy="true"]'), { timeout: 30000 });
    await page.click('[data-mode="preview"]');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-status')?.hidden);
    await frames(page, 16);
    const afterMode = await state();
    assert.ok(Math.abs(Number(afterMode.line) - Number(beforeMode.line)) <= 1,
      `Source roundtrip retains the deep reading line: ${JSON.stringify({ beforeMode, afterMode })}`);
    stage = 'bottom navigation';
    await page.evaluate(() => {
      const scroll = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!;
      scroll.scrollTop = scroll.scrollHeight;
    });
    await frames(page, 24);
    assert.ok((await state()).visible.some(text => text?.includes('row17999')), 'Bottom navigation reaches the final authored line');
    assert.deepEqual(host.errors, []);
    console.log('Production giant Preview code: bounded DOM, full copy, deep search, cross-band grammar, edit refresh, resize and bottom navigation passed');
  } finally { host.dispose(); await page.close(); }
} catch (error) { console.error('Failed stage:', stage); primary = error; throw error; }
finally { server.stop(true); if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary); }
