import assert from 'node:assert/strict';
import { browser, server, open, frames, assertStablePaint } from './input-presentation-test-helpers';
import { closeTestBrowser } from './browser-test-helpers';

const text = '# Giant Preview table\n\nTyping target.\n\n| Name | Value |\n| --- | --- |\n'
  + Array.from({ length: 1600 }, (_, row) => `| ROW-${row} | **Value** ${row % 73 === 0 ? 'long content '.repeat(12) : row}<br>next |`).join('\n')
  + '\n\nAfter table.\n';
let primary: unknown;
let stage = 'Preview opening';
const linked = process.argv.includes('--sync');
try {
  // A direct Preview open has no earlier Live geometry to hide a bad source
  // projection. In particular tbody must never represent all 1600 source rows
  // while only one reading band is mounted.
  for (const width of [1280, 820]) {
    const coldPage = await browser.newPage(), coldHost = await open(coldPage, text, false, 'preview');
    try {
      await coldPage.setViewport({ width, height: 900 }); await frames(coldPage, 12);
      const rowAtReadingBand = (live: boolean) => coldPage.evaluate(live => {
        const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
        const view = (document.querySelector('.editor-host > .cm-editor .cm-content') as any).cmTile.root.view;
        const doc = live ? document : frame.contentDocument!;
        const bounds = live ? view.scrollDOM.getBoundingClientRect() : { top: 0, height: frame.clientHeight };
        const point = bounds.top + bounds.height / 3;
        const rows = [...doc.querySelectorAll<HTMLElement>(live
          ? 'table[data-meo-table-windowed] > tbody > tr[data-table-body-row]'
          : 'table[data-meo-preview-table-part] > tbody > tr[data-source-line]')];
        const row = rows.find(row => { const r = row.getBoundingClientRect(); return r.top <= point && r.bottom > point; });
        return { line: row ? Number(live ? row.dataset.sourceLineNumber : row.dataset.sourceLine) : null,
          top: live ? view.scrollDOM.scrollTop : doc.scrollingElement!.scrollTop };
      }, live);
      const before = await rowAtReadingBand(false);
      await coldPage.click('[data-mode="live"]');
      await coldPage.waitForFunction(() => document.querySelector('.meo-mode-live') && !document.querySelector('[data-mode][aria-busy="true"]'));
      await frames(coldPage, 12);
      const after = await rowAtReadingBand(true);
      assert.ok(before.line !== null && after.line !== null && Math.abs(before.line - after.line) <= 2,
        `Cold Preview to Live keeps the actual row (${width}px): ${JSON.stringify({ before, after })}`);
      assert.ok(await coldPage.$eval('tr[data-table-body-row="0"]', row => {
        const r = row.getBoundingClientRect(), s = row.closest('.cm-scroller')!.getBoundingClientRect();
        return r.bottom > s.top && r.top < s.bottom;
      }), 'The first authored row remains visible after the first mode switch');
      await coldPage.click('[data-mode="preview"]');
      await coldPage.waitForFunction(() => document.querySelector<HTMLElement>('.preview-status')?.hidden);
      const point = await coldPage.$eval('.preview-frame', frame => { const r = frame.getBoundingClientRect(); return { x: r.left + 160, y: r.top + 300 }; });
      await coldPage.mouse.move(point.x, point.y); await coldPage.mouse.wheel({ deltaY: 18_000 }); await frames(coldPage, 24);
      const middle = await rowAtReadingBand(false);
      assert.ok(middle.line !== null && middle.line > 100, 'The second case reads a distant band');
      await coldPage.click('[data-mode="live"]');
      await coldPage.waitForFunction(() => document.querySelector('.meo-mode-live') && !document.querySelector('[data-mode][aria-busy="true"]'));
      await frames(coldPage, 16);
      const returned = await rowAtReadingBand(true);
      assert.ok(returned.line !== null && Math.abs(middle.line - returned.line) <= 2,
        `Distant Preview rows project to the same Live rows (${width}px): ${JSON.stringify({ middle, returned })}`);
      assert.equal(coldHost.readHost(), text);
      assert.deepEqual(coldHost.errors, []);
    } finally { coldHost.dispose(); await coldPage.close(); }
  }
  const page = await browser.newPage(), host = await open(page, text);
  try {
    await page.click('[data-mode="preview"]');
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
      ?.querySelector('table[data-meo-preview-table-part]') && document.querySelector<HTMLElement>('.preview-status')?.hidden);
    await frames(page, 8);
    const state = () => page.evaluate(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!, scroll = doc.scrollingElement!;
      const tables = [...doc.querySelectorAll<HTMLTableElement>('table')];
      const rows = [...doc.querySelectorAll<HTMLTableRowElement>('tbody > tr')];
      return { rows: rows.length, tables: tables.length, nodes: doc.querySelectorAll('*').length,
        top: scroll.scrollTop, maximum: scroll.scrollHeight - scroll.clientHeight,
        visible: rows.filter(row => row.getBoundingClientRect().bottom > 0 && row.getBoundingClientRect().top < doc.defaultView!.innerHeight)
          .map(row => row.cells[0].textContent),
        columns: tables.map(table => [...table.querySelectorAll<HTMLTableColElement>('colgroup > col')].map(column => column.getBoundingClientRect().width)),
        overhang: tables.map(table => table.getBoundingClientRect().right - table.parentElement!.getBoundingClientRect().right) };
    });
    const initial = await state();
    assert.ok(initial.rows > 0 && initial.rows <= 128, `Initial giant table DOM must be bounded: ${JSON.stringify(initial)}`);
    for (const progress of [.3, .75, 1, .4, 0]) {
      await page.evaluate(progress => {
        const scroll = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!;
        scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * progress;
      }, progress);
      await frames(page, 20);
      const result = await state();
      assert.ok(result.rows > 0 && result.rows <= 160 && result.visible.length > 0,
        `Scrolling must render only a bounded, complete reading band: ${JSON.stringify({ progress, result })}`);
      assert.ok(result.overhang.every(value => value <= .1));
      assert.ok(result.columns.every(columns => columns.every((width, index) => Math.abs(width - initial.columns[0]![index]!) < .1)),
        `Columns must use the complete table's preferences across all bands: ${JSON.stringify(result.columns)}`);
      if (progress === 1) assert.ok(result.visible.includes('ROW-1599') && Math.abs(result.top - result.maximum) <= 1,
        `Bottom intent must reach the final row: ${JSON.stringify(result)}`);
      if (progress === 0) assert.equal(result.top, 0);
    }
    // Native wheel routing must also drive the logical reading window.
    const box = await page.$eval('.preview-frame', element => { const r = element.getBoundingClientRect(); return { x: r.left + 180, y: r.top + 350 }; });
    await page.mouse.move(box.x, box.y); await page.mouse.wheel({ deltaY: 500 }); await frames(page, 12);
    assert.ok((await state()).top > 0);
    stage = 'Find an unmounted row';
    await page.click('[data-action="find"]');
    await page.waitForSelector('.find-panel.is-visible');
    await page.focus('.find-input'); await page.keyboard.type('ROW-1599'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const match = doc.querySelector('.meo-preview-search-match.is-active'), rect = match?.getBoundingClientRect();
      return match?.textContent === 'ROW-1599' && rect && rect.bottom > 0 && rect.top < doc.defaultView!.innerHeight;
    });
    await page.click('.find-close-button');
    await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.body.focus({ preventScroll: true }));
    await page.keyboard.down('Control'); await page.keyboard.press('Home'); await page.keyboard.up('Control'); await frames(page, 16);
    assert.ok(await page.evaluate(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const rect = doc.querySelector('h1')?.getBoundingClientRect();
      return rect && rect.top >= -1 && rect.bottom <= doc.defaultView!.innerHeight;
    }), `Ctrl+Home reveals the authored heading: ${JSON.stringify(await state())}`);
    let previousRow = -1;
    for (let index = 0; index < 6; index++) {
      await page.keyboard.press('PageDown'); await frames(page, 12);
      const pageState = await state(), first = Number(pageState.visible[0]?.match(/ROW-(\d+)/)?.[1]);
      assert.ok(pageState.rows <= 160 && Number.isFinite(first) && first > previousRow,
        `PageDown advances a complete bounded reading band: ${JSON.stringify({ index, previousRow, pageState })}`);
      previousRow = first;
    }
    await page.screenshot({ path: '.local/preview-table-bands-reading.png' });
    // Edit a distant source row while the follower owns its reading position.
    stage = 'Source split readiness';
    await page.click('[data-mode="source"]'); await page.click('.source-preview-button');
    await page.waitForFunction(() => {
      const host = document.querySelector<HTMLElement>('.preview-host');
      return host && !host.hidden && !host.inert && host.style.visibility !== 'hidden';
    });
    if (await page.$eval('.source-preview-scroll-sync-button', button => button.getAttribute('aria-pressed') === 'true')) {
      await page.click('.source-preview-scroll-sync-button');
    }
    await page.evaluate(() => {
      const view = (document.querySelector('.editor-host > .cm-editor .cm-content') as any).cmTile.root.view;
      view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('ROW-1500') }, scrollIntoView: true }); view.focus();
    });
    await frames(page, 12);
    const splitBox = await page.$eval('.preview-frame', element => { const r = element.getBoundingClientRect(); return { x: r.left + 180, y: r.top + 350 }; });
    await page.mouse.move(splitBox.x, splitBox.y); await page.mouse.wheel({ deltaY: 200 }); await frames(page, 16);
    if (linked) {
      await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowLeft');
      await page.click('.source-preview-scroll-sync-button'); await frames(page, 20);
    }
    const clip = await page.$eval('.preview-frame', element => {
      const r = element.getBoundingClientRect(); return { left: Math.ceil(r.left + 20), top: Math.ceil(r.top + 160), width: Math.floor(r.width - 40), height: 400 };
    });
    const before = await page.evaluate(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const row = [...doc.querySelectorAll<HTMLTableRowElement>('tbody tr')].find(row => row.getBoundingClientRect().top > 180)!;
      (window as any).__unchangedTableRow = row;
      return { text: row.textContent, top: row.getBoundingClientRect().top };
    });
    await assertStablePaint(page, clip, async () => {
      await page.keyboard.type('1234567890', { delay: 25 });
      await new Promise(resolve => setTimeout(resolve, 900));
    }, `giant-table-Preview-source-input-sync-${linked}`);
    stage = 'Final edited document publication';
    const after = await page.evaluate(() => {
      const row = (window as any).__unchangedTableRow as HTMLTableRowElement;
      return { connected: row.isConnected, text: row.textContent, top: row.getBoundingClientRect().top };
    });
    assert.ok(after.connected && after.text === before.text && Math.abs(after.top - before.top) <= 1,
      `Source edits retain the original unchanged reading DOM: ${JSON.stringify({ before, after })}`);
    assert.equal(host.readHost(), text.replace('ROW-1500', '1234567890ROW-1500'));
    await page.waitForFunction(id => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
      .querySelector<HTMLElement>('main')?.dataset.meoPreviewDocument === id, {}, host.readPresentation().id);
    const acceptedColumns = (await state()).columns[0]!;
    await page.evaluate(() => {
      const scroll = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!;
      scroll.scrollTop = scroll.scrollHeight * .9;
    });
    await frames(page, 20);
    assert.ok((await state()).columns.every(columns => columns.every((width, index) => Math.abs(width - acceptedColumns[index]!) < .1)),
      'Newly mounted distant bands retain accepted columns after input');
    await page.setViewport({ width: 980, height: 820, deviceScaleFactor: 1.5 }); await frames(page, 20);
    const resized = await state();
    assert.ok(resized.rows <= 160 && resized.overhang.every(value => value <= .1));
    assert.ok(resized.columns.every(columns => columns.every((width, index) => Math.abs(width - resized.columns[0]![index]!) < .1)));
    stage = 'Full DOM for screen reader';
    await page.evaluate(() => document.body.classList.add('vscode-using-screen-reader'));
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
      .querySelectorAll('tbody > tr').length === 1600);
    stage = 'Return to bounded DOM';
    await page.evaluate(() => document.body.classList.remove('vscode-using-screen-reader'));
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
      .querySelectorAll('tbody > tr').length < 160);
    assert.deepEqual(host.errors, []);
    console.log(`Production giant-table Preview (sync ${linked}): initial ${initial.rows} rows/${initial.nodes} nodes; bounded wheel/scroll, fixed columns, bottom/top and unchanged compositor frames during Source input`);
  } catch (error) {
    console.error(JSON.stringify({ stage, errors: host.errors, state: await page.evaluate(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
      return { mode: document.getElementById('app')?.dataset.mode, status: document.querySelector('.preview-status')?.textContent,
        search: document.querySelector('.find-status')?.textContent, rows: doc?.querySelectorAll('tbody tr').length,
        marks: doc?.querySelectorAll('.meo-preview-search-match').length, active: doc?.querySelector('.meo-preview-search-match.is-active')?.textContent,
        body: document.body.className };
    }) }));
    await page.screenshot({ path: '.local/preview-table-bands-failure.png' }); throw error;
  } finally { host.dispose(); await page.close(); }
} catch (error) { primary = error; throw error; }
finally { server.stop(true); if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary); }
