import assert from 'node:assert/strict';
import { closeTestBrowser } from './browser-test-helpers';
import { browser, server, open, frames } from './input-presentation-test-helpers';

const text = '# Wrapped reading position\n\n' + Array.from({ length: 25_000 }, (_, i) => `word${i}`).join(' ')
  + '\n\n## End of long paragraph\n\nTail content.\n';
let primary: unknown;
try {
  const coldText = '# Strategy comparison\n\nBENCH_EDIT_TARGET\n\nStable **bold** content and [link](https://example.com).\n\n'
    + '```\nplain code content\n```\n\n'.repeat(60);
  for (let attempt = 0; attempt < 5; attempt++) {
    const coldPage = await browser.newPage(), coldHost = await open(coldPage, coldText, false, 'live');
    try {
      assert.ok(await coldPage.$('.editor-host .cm-line.meo-md-h1'),
        `the first editable Live surface must already have its heading geometry (attempt ${attempt})`);
      const target = coldText.indexOf('BENCH_EDIT_TARGET') + 17;
      const point = await coldPage.evaluate(target => {
        const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
        const rect = view.coordsAtPos(target);
        return { x: rect.left, y: (rect.top + rect.bottom) / 2 };
      }, target);
      await coldPage.mouse.click(point.x, point.y);
      await coldPage.keyboard.type('7'); await frames(coldPage, 2);
      assert.equal(coldHost.readHost(), coldText.slice(0, target) + '7' + coldText.slice(target),
        `the first visible Live surface must accept a click and first digit at the intended position (attempt ${attempt})`);
      assert.deepEqual(coldHost.errors, []);
    } finally { coldHost.dispose(); await coldPage.close(); }
  }
  const page = await browser.newPage(), host = await open(page, text);
  try {
    const read = () => page.evaluate(() => {
      const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
      const bounds = view.scrollDOM.getBoundingClientRect(), content = view.contentDOM.getBoundingClientRect();
      return { position: view.posAtCoords({ x: Math.max(bounds.left + 50, content.left + 2), y: bounds.top + view.scrollDOM.clientHeight / 3 }),
        scroll: view.scrollDOM.scrollTop };
    });
    await page.focus('.editor-host .cm-content');
    await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control');
    await page.mouse.move(700, 500); await page.mouse.wheel({ deltaY: -600 }); await frames(page, 10);
    const before = await read();
    assert.ok(before.position && before.position > text.length * 0.8, 'fixture must read near the end inside the wrapped paragraph');
    await page.click('button[data-mode="live"]');
    await page.waitForFunction(() => document.querySelector('.cm-editor.meo-mode-live') && !document.querySelector('.mode-group [aria-busy="true"]'));
    await frames(page, 8);
    const live = await read();
    assert.ok(live.position !== null && Math.abs(live.position - before.position!) < 200,
      `switching a wrapped paragraph to Live must preserve the actual reading text: ${JSON.stringify({ before, live })}`);
    await page.click('button[data-mode="preview"]');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-status')?.hidden === true
      && !!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('main.meo-export-doc'));
    await frames(page, 8);
    const previewPosition = await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!, doc = frame.contentDocument!;
      const paragraph = [...doc.querySelectorAll('p')].find(element => element.textContent?.startsWith('word0 '))!;
      const rect = paragraph.getBoundingClientRect();
      const range = doc.caretRangeFromPoint(rect.left + 3, frame.clientHeight / 3);
      return range && paragraph.contains(range.startContainer) ? range.startOffset : null;
    });
    assert.ok(previewPosition !== null && Math.abs(previewPosition + text.indexOf('word0 ') - before.position!) < 400,
      `Preview must show the same region inside the long paragraph: ${JSON.stringify({ before, previewPosition })}`);
    await page.click('button[data-mode="source"]');
    await page.waitForFunction(() => document.querySelector('.cm-editor.meo-mode-source') && !document.querySelector('.mode-group [aria-busy="true"]'));
    await frames(page, 8);
    const returned = await read();
    assert.ok(returned.position !== null && Math.abs(returned.position - before.position!) < 200,
      `returning to Source must retain the wrapped reading text: ${JSON.stringify({ before, returned })}`);
    assert.equal(host.readHost(), text);
    assert.deepEqual(host.errors, []);
    console.log('Wrapped-line Source/Live/Preview mode transitions retain the actual reading text');
  } finally { host.dispose(); await page.close(); }
} catch (error) { primary = error; throw error; }
finally { server.stop(true); if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary); }
