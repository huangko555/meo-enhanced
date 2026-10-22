import assert from 'node:assert/strict';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-large-table-row-window-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const richCells = new Map([
  [333, '**formatted** $x^2$ & <span>HTML</span> [^note]'],
  [777, '**formatted** ![pixel](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)'],
  [1400, '**formatted** <code>literal</code><br>second line']
]);
const text = '# Row window\n\n| Name | Value |\n| --- | --- |\n'
  + Array.from({ length: 1600 }, (_, row) => `| Row ${row} | ${richCells.get(row) ?? `**formatted** ${row % 53 === 0 ? 'wrapped content '.repeat(30) : row}`} |\n`).join('')
  + '\nAfter table.\n\n[^note]: Complete note after table.\n';
const browser = await launchTestBrowser();
let primary: unknown;
try {
  const page = await browser.newPage(); page.setDefaultTimeout(15_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(String(error)));
  await page.setViewport({ width: 820, height: 600 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app" class="editor-host"></div>');
  await page.addStyleTag({ path: path.resolve('webview/src/styles.css') });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  assert.equal(await page.evaluate(() => (window as any).windowMeasuredHeight()), 75_000,
    'A real measured long block must not be truncated before an input transaction rebuilds its height map');
  await page.evaluate(text => (window as any).createWindowEditor(text), text);
  await page.waitForSelector('.meo-md-html-table tbody tr');
  await page.evaluate(async () => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
  const first = await page.evaluate(() => ({ rows: document.querySelectorAll('.meo-md-html-table:not(.meo-md-html-table-sticky-table) tr[data-source-line-number]').length,
    inputs: document.querySelectorAll('.meo-md-html-table:not(.meo-md-html-table-sticky-table) textarea').length,
    nodes: document.querySelectorAll('.meo-md-html-table-shell *').length,
    widths: [...document.querySelectorAll('table[data-meo-table-windowed] thead th')].map(cell => cell.getBoundingClientRect().width),
    source: (window as any).windowEditor.getText() }));
  assert.equal(first.source, text);
  console.log(JSON.stringify({ ...first, source: undefined }));
  assert.ok(first.rows <= 120 && first.inputs <= 240,
    `A 1600-row table must bound mounted editors to its reading window, got ${first.rows} rows / ${first.inputs} inputs`);
  const frames = () => page.evaluate(async () => { for (let i = 0; i < 10; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
  const dragSurvivesCellBlur = await page.evaluate(() => {
    const scope = window as any, view = scope.windowEditor.view;
    const input = document.querySelector<HTMLTextAreaElement>('table[data-meo-table-windowed] textarea')!;
    input.focus({ preventScroll: true });
    view.scrollDOM.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    input.blur();
    const active = scope.windowViewport(view).isScrollbarDragging();
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
    return active;
  });
  assert.ok(dragSurvivesCellBlur, 'Blurring the previously focused cell must not end the scrollbar gesture as if the window lost focus');
  for (const { fraction: requested, release } of [
    { fraction: .75, release: 'pointerup' }, { fraction: 1, release: 'pointerup' },
    { fraction: 0, release: 'pointercancel' }, { fraction: .4, release: 'blur' }
  ]) {
    const dragFraction = await page.evaluate(requested => {
      const scope = window as any, view = scope.windowEditor.view, scroll = view.scrollDOM;
      // Exercise the production scrollbar-intent seam independently of platform
      // thumb sizes. The isolated VS Code run supplies real Win32 dragging.
      scroll.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      scroll.scrollTop = requested * (scroll.scrollHeight - scroll.clientHeight);
      const before = scroll.scrollTop / (scroll.scrollHeight - scroll.clientHeight);
      scope.windowRows(document.querySelector('table[data-meo-table-windowed] tbody')).update();
      return before;
    }, requested);
    await frames();
    const afterDragFraction = await page.evaluate(release => {
      const scroll = (window as any).windowEditor.view.scrollDOM;
      const fraction = scroll.scrollTop / (scroll.scrollHeight - scroll.clientHeight), bounds = scroll.getBoundingClientRect();
      const row = [...document.querySelectorAll<HTMLTableRowElement>('table[data-meo-table-windowed] tr[data-table-body-row]')]
        .find(row => { const rect = row.getBoundingClientRect(); return rect.bottom > bounds.top && rect.top < bounds.bottom; });
      if (release === 'blur') window.dispatchEvent(new Event('blur'));
      else document.dispatchEvent(new PointerEvent(release, { bubbles: true, button: 0 }));
      return { fraction, row: row?.dataset.tableBodyRow, top: row?.getBoundingClientRect().top };
    }, release);
    assert.ok(Math.abs(afterDragFraction.fraction - dragFraction) < .0001,
      `Row measurements must preserve a native thumb gesture's progress: ${JSON.stringify({ dragFraction, afterDragFraction })}`);
    await frames();
    const released = await page.evaluate(row => {
      const scroll = (window as any).windowEditor.view.scrollDOM;
      return { top: document.querySelector(`table[data-meo-table-windowed] tr[data-table-body-row="${row}"]`)?.getBoundingClientRect().top,
        scroll: scroll.scrollTop, maximum: scroll.scrollHeight - scroll.clientHeight };
    }, afterDragFraction.row);
    if (requested === 1) assert.ok(Math.abs(released.maximum - released.scroll) < 3, 'Thumb release retains the exact document end');
    else assert.ok(released.top !== undefined && afterDragFraction.top !== undefined && Math.abs(released.top - afterDragFraction.top) < 2,
      `Thumb release commits discovered heights without moving its reading row: ${JSON.stringify({ requested, afterDragFraction, released })}`);
    if (release === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  }
  for (const fraction of [.5, 1, .15, 0]) {
    await page.evaluate(fraction => { const view = (window as any).windowEditor.view;
      view.scrollDOM.scrollTop = fraction * (view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight);
      view.scrollDOM.dispatchEvent(new Event('scroll'));
    }, fraction);
    await frames();
    const sample = await page.evaluate(() => {
      const view = (window as any).windowEditor.view, bounds = view.scrollDOM.getBoundingClientRect();
      const rows = [...document.querySelectorAll<HTMLTableRowElement>('table[data-meo-table-windowed] tr[data-source-line-number]')];
      const labels = [...view.dom.querySelectorAll<HTMLElement>('.meo-md-html-table-line-number')];
      const gutterTop = view.dom.querySelector('.cm-lineNumbers')!.getBoundingClientRect().top;
      const visible = rows.filter(row => { const rect = row.getBoundingClientRect(); return rect.top < bounds.bottom && rect.bottom > bounds.top; });
      return { count: rows.length, last: rows.at(-1)?.textContent,
        widths: [...document.querySelectorAll('table[data-meo-table-windowed] thead th')].map(cell => cell.getBoundingClientRect().width),
        visible: visible.length, aligned: visible.every(row => labels.some(label => label.textContent === row.dataset.sourceLineNumber
          && Math.abs(Number.parseFloat(label.style.top) - (row.getBoundingClientRect().top - gutterTop)) < 1)) };
    });
    assert.ok(sample.count <= 120 && sample.visible > 0 && sample.aligned, `Reading window incomplete at ${fraction}: ${JSON.stringify(sample)}`);
    assert.ok(sample.widths.every((width, index) => Math.abs(width - first.widths[index]!) < 1),
      `Offscreen source discovery must not redefine table columns: ${JSON.stringify({ fraction, first: first.widths, actual: sample.widths })}`);
    if (fraction === 1) assert.ok(sample.last?.includes('Row 1599'));
  }
  const geometry = await page.evaluate(() => [...(window as any).windowGeometry((window as any).windowEditor.view, new Set([5, 804, 1604]))] as Array<[number, { top: number; bottom: number }]>);
  assert.deepEqual(geometry.map(([line]) => line).sort((a, b) => a - b), [5, 804, 1604]);
  assert.ok(geometry.every(([, rect]) => rect.bottom > rect.top));
  await page.evaluate(() => {
    const scope = window as any, input = scope.windowCell(scope.windowEditor.view, 3, 800, 0) as HTMLTextAreaElement;
    scope.activeWindowInput = input; input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length);
    input.closest('td')!.scrollIntoView({ block: 'center' });
  });
  await frames();
  await page.evaluate(() => {
    const scope = window as any; scope.windowFrames = [];
    const record = () => {
      const input = scope.activeWindowInput as HTMLTextAreaElement;
      scope.windowFrames.push({ connected: input.isConnected, focused: document.activeElement === input,
        top: input.closest('tr')!.getBoundingClientRect().top });
      scope.windowFrame = requestAnimationFrame(record);
    };
    scope.windowFrame = requestAnimationFrame(record);
  });
  await page.keyboard.type('1234567890'.repeat(8), { delay: 3 });
  await new Promise(resolve => setTimeout(resolve, 1000)); await frames();
  const painted = await page.evaluate(() => {
    const scope = window as any; cancelAnimationFrame(scope.windowFrame); return scope.windowFrames as Array<{connected: boolean; focused: boolean; top: number}>;
  });
  assert.ok(painted.length >= 10 && painted.every(frame => frame.connected && frame.focused), 'Every painted input frame must retain the native editor');
  assert.ok(Math.max(...painted.map(frame => frame.top)) - Math.min(...painted.map(frame => frame.top)) < 2,
    'A cell edit with unchanged wrapping must not move its visible row, including its delayed commit');
  const edited = await page.evaluate(() => {
    const scope = window as any, input = scope.activeWindowInput as HTMLTextAreaElement;
    return { connected: input.isConnected, focused: document.activeElement === input, value: input.value, source: scope.windowEditor.getText() };
  });
  assert.ok(edited.connected && edited.focused, JSON.stringify({ ...edited, source: edited.source.length }));
  assert.equal(edited.value, 'Row 799' + '1234567890'.repeat(8));
  assert.equal(edited.source, text.replace('Row 799', edited.value));
  const singleCellCopy = await page.evaluate(() => {
    const original = document.createElement, owned = Object.hasOwn(document, 'createElement'); let created = 0;
    (document as any).createElement = (tag: string, options?: ElementCreationOptions) => { created++; return original.call(document, tag, options); };
    try {
      const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
      document.dispatchEvent(event); return { created, handled: event.defaultPrevented };
    } finally { if (owned) document.createElement = original; else delete (document as any).createElement; }
  });
  assert.deepEqual(singleCellCopy, { created: 0, handled: false }, 'Native text copy must not prepare unrelated offscreen table cells');
  for (const direction of ['undo', 'redo'] as const) {
    const beforeTop = await page.evaluate(() => {
      (window as any).historyTable = document.querySelector('table[data-meo-table-windowed]');
      return (document.activeElement as HTMLElement).closest('tr')!.getBoundingClientRect().top;
    });
    await page.keyboard.down('Control'); await page.keyboard.press(direction === 'undo' ? 'z' : 'y'); await page.keyboard.up('Control');
    await frames();
    const replayed = await page.evaluate(() => ({ text: (window as any).windowEditor.getText(),
      active: (document.activeElement as HTMLTextAreaElement)?.value,
      row: (document.activeElement as HTMLElement)?.dataset.tableRow,
      top: document.activeElement?.closest('tr')?.getBoundingClientRect().top,
      sameTable: (window as any).historyTable === document.querySelector('table[data-meo-table-windowed]') }));
    assert.equal(replayed.text, direction === 'undo' ? text : edited.source);
    assert.equal(replayed.active, direction === 'undo' ? 'Row 799' : edited.value, JSON.stringify({ ...replayed, text: replayed.text.length }));
    assert.equal(replayed.row, '800');
    assert.ok(replayed.top !== undefined && Math.abs(replayed.top - beforeTop) < 2,
      `History must keep an already visible edited row stable: ${JSON.stringify({ direction, beforeTop, afterTop: replayed.top, sameTable: replayed.sameTable })}`);
  }
  for (const mode of ['source', 'live']) {
    await page.evaluate(mode => { const editor = (window as any).windowEditor;
      editor.setMode(mode, editor.captureModeTransitionAnchorToken('editor')); }, mode);
    await frames();
  }
  const roundTrip = await page.evaluate(() => ({ text: (window as any).windowEditor.getText(),
    value: (document.activeElement as HTMLTextAreaElement)?.value,
    row: (document.activeElement as HTMLElement)?.dataset.tableRow }));
  assert.equal(roundTrip.text, edited.source);
  assert.equal(roundTrip.value, edited.value, 'Live/Source round trip must restore the logical cell outside the initial row window');
  assert.equal(roundTrip.row, '800');
  await page.evaluate(() => { (window as any).activeWindowInput = document.activeElement; });
  await page.mouse.move(600, 300); await page.mouse.wheel({ deltaY: -100_000 }); await frames();
  assert.ok(await page.evaluate(() => (window as any).activeWindowInput.isConnected), 'Scrolling must retain the focused native editor');
  const header = await page.$eval('table[data-meo-table-windowed] thead th', element => { const rect = element.getBoundingClientRect(); return { x: rect.left + 8, y: rect.top + 8 }; });
  await page.mouse.move(header.x, header.y); await page.mouse.down();
  await page.mouse.wheel({ deltaY: 100_000 }); await frames();
  const tail = await page.$eval('table[data-meo-table-windowed] td[data-table-row="1600"][data-table-col="1"]', element => { const rect = element.getBoundingClientRect(); return { x: rect.left + 8, y: rect.top + 8 }; });
  await page.mouse.move(tail.x, tail.y, { steps: 5 }); await page.mouse.up();
  const copied = await page.evaluate(() => {
    const scope = window as any, clipboard = new DataTransfer();
    document.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: clipboard }));
    return { plain: clipboard.getData('text/plain'), html: clipboard.getData('text/html'), markdown: scope.windowCopy(scope.windowEditor.view, 'markdown') };
  });
  assert.ok(copied.plain.includes('Row 0') && copied.plain.includes('Row 799') && copied.plain.includes('Row 1599'), 'Rich clipboard must cover screen-excluded rows');
  assert.ok(copied.html.includes('<strong>formatted</strong>'));
  assert.ok(copied.html.includes('HTML') && copied.html.includes('second line'),
    'Offscreen inline HTML and explicit-break text must survive rich copy');
  assert.ok([...richCells.values()].every(value => copied.markdown?.includes(value)), 'Offscreen formula, image and footnote Markdown stays exact');
  assert.ok(copied.markdown?.includes('Row 1599') && copied.markdown.includes('**formatted**'));
  await page.mouse.move(600, 300); await page.mouse.wheel({ deltaY: -100_000 }); await frames();
  const handle = 'table[data-meo-table-windowed] thead th:first-child [data-table-resize-column]';
  const resizePoint = await page.$eval(handle, element => { const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; });
  const initialWidth = await page.$eval('table[data-meo-table-windowed] thead th', element => element.getBoundingClientRect().width);
  await page.mouse.move(resizePoint.x, resizePoint.y); await page.mouse.down();
  await page.mouse.move(resizePoint.x + 65, resizePoint.y, { steps: 10 }); await page.mouse.up(); await frames();
  assert.ok(await page.$eval('table[data-meo-table-windowed] thead th', (element, before) => element.getBoundingClientRect().width > before + 20, initialWidth),
    'A windowed table must retain native column resizing');
  for (const width of [610, 960]) {
    await page.setViewport({ width, height: 600, deviceScaleFactor: 1.25 }); await frames();
    await page.evaluate(() => { const editor = (window as any).windowEditor;
      editor.preserveViewport(() => document.documentElement.style.setProperty('--meo-user-editor-font-size', '16.25px'), true); });
    await frames();
    const layout = await page.evaluate(() => {
      const table = document.querySelector<HTMLTableElement>('table[data-meo-table-windowed]')!;
      const header = [...table.tHead!.rows[0]!.cells].map(cell => cell.getBoundingClientRect().width);
      const visible = [...table.tBodies[0]!.querySelectorAll<HTMLTableRowElement>('tr[data-source-line-number]')];
      return { rows: visible.length, aligned: visible.every(row => [...row.cells].every((cell, col) => Math.abs(cell.getBoundingClientRect().width - header[col]!) < 1)),
        headerUnclipped: [...table.tHead!.querySelectorAll('textarea')].every(input => input.scrollHeight <= input.clientHeight + 1),
        source: (window as any).windowEditor.getText() };
    });
    assert.ok(layout.rows < 120 && layout.aligned && layout.headerUnclipped, `Column/font layout incomplete: ${JSON.stringify({ ...layout, source: undefined, width })}`);
    assert.equal(layout.source, edited.source);
  }
  const columnWidths = () => page.$$eval('table[data-meo-table-windowed] thead th', cells => cells.map(cell => cell.getBoundingClientRect().width));
  const resizedWidths = await columnWidths();
  for (const mode of ['source', 'live']) {
    await page.evaluate(mode => { const editor = (window as any).windowEditor;
      editor.setMode(mode, editor.captureModeTransitionAnchorToken('editor')); }, mode); await frames();
  }
  const returnedWidths = await columnWidths();
  assert.ok(returnedWidths.every((width, index) => Math.abs(width - resizedWidths[index]!) < 1),
    `Mode round trip must retain resized giant-table columns: ${JSON.stringify({ resizedWidths, returnedWidths })}`);
  await page.mouse.move(600, 300); await page.mouse.wheel({ deltaY: 5000 }); await frames();
  const sticky = await page.evaluate(() => ({
    visible: document.querySelector('.meo-md-html-table-sticky-chrome')?.classList.contains('is-visible'),
    widths: [...document.querySelectorAll('table.meo-md-html-table-sticky-table th')].map(cell => cell.getBoundingClientRect().width),
    original: [...document.querySelectorAll('table[data-meo-table-windowed] thead th')].map(cell => cell.getBoundingClientRect().width)
  }));
  assert.ok(sticky.visible && sticky.widths.every((width, index) => Math.abs(width - sticky.original[index]!) < 1),
    `Floating table header must keep the primary column projection: ${JSON.stringify(sticky)}`);
  await page.mouse.wheel({ deltaY: -100_000 }); await frames();
  await page.screenshot({ path: path.resolve('.local/table-row-window-layout.png') });
  await page.evaluate(() => { const view = (window as any).windowEditor.view;
    view.dispatch({ changes: { from: 0, insert: 'Prefix\n' } }); });
  await frames();
  const shifted = await page.evaluate(() => {
    const scope = window as any, input = scope.windowCell(scope.windowEditor.view, 4, 1300, 0) as HTMLTextAreaElement;
    input.focus({ preventScroll: true });
    return { value: input?.value, line: input?.closest('tr')?.dataset.sourceLineNumber,
      markdown: scope.windowCopy(scope.windowEditor.view, 'markdown'),
      editedValue: scope.windowCell(scope.windowEditor.view, 4, 800, 0)?.value, source: scope.windowEditor.getText() };
  });
  assert.equal(shifted.value, 'Row 1299');
  assert.equal(shifted.line, '1305');
  assert.ok(shifted.markdown?.includes('Row 1299'), 'Selected-cell copy follows the shifted source row');
  assert.equal(shifted.editedValue, edited.value, 'Evicted edited rows read the current accepted source after a prefix edit');
  assert.equal(shifted.source, 'Prefix\n' + edited.source);
  await page.evaluate(() => document.body.classList.add('vscode-using-screen-reader')); await frames();
  assert.equal(await page.$$eval('table[data-meo-table-windowed] tbody tr[data-table-body-row]', rows => rows.length), 1600,
    'Enabling a screen reader in an already open document must expose every source row');
  await page.evaluate(() => document.body.classList.remove('vscode-using-screen-reader')); await frames();
  assert.ok(await page.$$eval('table[data-meo-table-windowed] tbody tr[data-table-body-row]', rows => rows.length < 120));
  assert.deepEqual(errors, []);
  await page.evaluate(() => (window as any).windowEditor.destroy());
  for (const { rows, columns, windowed } of [{ rows: 200, columns: 2, windowed: false },
    { rows: 256, columns: 4, windowed: false }, { rows: 512, columns: 2, windowed: true }]) {
    const table = '| ' + Array(columns).fill('Header').join(' | ') + ' |\n| ' + Array(columns).fill('---').join(' | ') + ' |\n'
      + Array.from({ length: rows }, (_, row) => '| ' + Array.from({ length: columns }, (_, col) =>
        windowed && row === rows - 1 && col === 0 ? 'Offscreen_long_identifier_'.repeat(12) : `Row ${row}`).join(' | ') + ' |\n').join('');
    await page.evaluate(text => (window as any).createWindowEditor(text), table); await frames();
    assert.equal(await page.$('table[data-meo-table-windowed]') !== null, windowed, `Automatic table policy at ${rows}x${columns}`);
    if (windowed) assert.ok(await page.$eval('table[data-meo-table-windowed] thead th', cell => cell.getBoundingClientRect().width > 200),
      'Automatic widths must account for long cells that have never entered the row window');
    assert.equal(await page.evaluate(() => (window as any).windowEditor.getText()), table);
    await page.evaluate(() => (window as any).windowEditor.destroy());
  }
  console.log('Table row window: bounded DOM, variable heights, geometry/navigation, stable input/history/modes, complete rich clipboard, columns, fonts and source mapping passed');
} catch (error) { primary = error; throw error; }
finally { if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary); }
