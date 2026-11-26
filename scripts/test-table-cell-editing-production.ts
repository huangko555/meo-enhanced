import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchTestBrowser } from './browser-test-helpers';
import { assessLargeDocument } from '../src/foundation/largeDocument';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-cell-editing-'));
const wrappedCell = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const source = `| A | B |\n| --- | --- |\n| ${wrappedCell} | two |\n| three | four |`;

async function waitForTable(page: any) {
  await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table-shell tbody textarea').length === 4);
}

async function dragTableHeightColumn(
  page: import('puppeteer-core').Page,
  delta: number,
  height: () => Promise<number>,
  settle: () => Promise<void>
): Promise<number> {
  const point = await page.$$eval('.cm-editor [data-table-resize-column="0"]', handles => {
    const viewport = document.querySelector('.cm-scroller')!.getBoundingClientRect();
    for (const handle of handles) {
      const rect = handle.getBoundingClientRect();
      const top = Math.max(rect.top, viewport.top);
      const bottom = Math.min(rect.bottom, viewport.bottom, innerHeight);
      if (bottom - top < 2) continue;
      const x = rect.left + rect.width / 2, y = (top + bottom) / 2;
      if (document.elementFromPoint(x, y) === handle) return { x, y };
    }
    return null;
  });
  assert(point, 'The column divider has a visible pointer target');
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + delta, point.y);
  await settle();
  const during = await height();
  await page.mouse.up();
  await settle();
  return during;
}

async function checkProjectedCellHeight(page: import('puppeteer-core').Page, sizing = 'native') {
  const row = 'tbody tr:first-child';
  const cell = `${row} td:first-child`;
  const height = () => page.$eval(row, element => element.getBoundingClientRect().height);
  const settle = () => page.evaluate(async () => {
    for (let frame = 0; frame < 8; frame++) await new Promise(requestAnimationFrame);
  });
  for (const large of [false, true]) {
    const label = `${large ? 'optimized' : 'ordinary'}/${sizing}`;
    const text = '| A | B |\n| --- | --- |\n| 3. Ordered text ![picture](fixture.svg) | neighbor |\n\nAfter.'
      + (large ? '\n\n' + 'padding text\n'.repeat(8100) : '');
    await page.evaluate(text => {
      const harness = (window as any).TableStabilityHarness;
      (window as any).__tableCellEditor?.destroy();
      harness.setImageSrcResolver(() => 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="240"><rect width="180" height="240" fill="teal"/></svg>'
      ));
      (window as any).__tableCellEditor = harness.createEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
    }, text);
    await page.waitForFunction(({ cell, large }) => {
      const image = document.querySelector<HTMLImageElement>(`${cell} img`);
      return image?.complete && image.naturalHeight === 240 && (window as any).TableStabilityHarness
        .usesLargeDocumentDerivedWorkBudget((window as any).__tableCellEditor.view.state) === large;
    }, {}, { cell, large });
    await settle();
    const reading = await height();
    assert(reading >= 240, `${label}/rendered image contributes its height (${reading})`);
    const click = await page.$eval(`${cell} img`, element => {
      const { left, top } = element.getBoundingClientRect();
      return { x: left + 18, y: top + 12 };
    });
    await page.mouse.click(click.x, click.y);
    await page.waitForSelector(`${cell} .meo-md-table-active-source-line`);
    await settle();
    const editing = await height();
    assert(Math.abs(editing - reading) < 2, `${label}/entering list item source preserves image row height (${reading} → ${editing})`);
    if (!large && sizing === 'native' && process.env.MEO_TEST_SCREENSHOTS) {
      fs.mkdirSync(process.env.MEO_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.MEO_TEST_SCREENSHOTS, 'table-height-list-source.png') });
    }
    const initialWidth = await page.$eval(cell, element => element.getBoundingClientRect().width);
    const narrowDelta = 135 - initialWidth;
    assert(narrowDelta < -25, `${label}/fixture leaves room to narrow the image column`);
    const narrowEditing = await dragTableHeightColumn(page, narrowDelta, height, settle);
    assert(narrowEditing < reading - 20, `${label}/list source minimum reflows with the narrower image (${reading} → ${narrowEditing})`);
    assert(await page.$eval(`${cell} textarea`, input => input === document.activeElement), `${label}/resize keeps list source focused`);
    await page.keyboard.press('Escape');
    await page.waitForSelector(`${cell} .is-editing`, { hidden: true });
    await page.waitForSelector(`${cell} .meo-md-html-table-cell-preview img`);
    await settle();
    assert(Math.abs(await height() - narrowEditing) < 2, `${label}/list source keeps the reading height at the new width`);
    await dragTableHeightColumn(page, -narrowDelta, height, settle);
    assert(Math.abs(await height() - reading) < 2, `${label}/restoring the column width restores the image row`);
    console.log(`Table projected source preserves image row height (${label})`);
  }
}

async function checkCellHeightLayoutChanges(page: import('puppeteer-core').Page, sizing: string) {
  const table = '.meo-md-html-table:not(.meo-md-html-table-sticky-table)';
  const inputAt = (row: number) => `${table} textarea[data-table-row="${row}"][data-table-col="0"]`;
  const rowHeight = (row: number) => page.$eval(inputAt(row), input => input.closest('tr')!.getBoundingClientRect().height);
  const settle = () => page.evaluate(async () => {
    for (let frame = 0; frame < 10; frame++) await new Promise(requestAnimationFrame);
  });
  const open = async (rows: string[], large: boolean, windowed: boolean, header = '| A | B |') => {
    const extraRows = windowed ? Array.from({ length: 512 - rows.length }, () => '| small | small |') : [];
    const text = [header, '| --- | --- |', ...rows, ...extraRows, '', 'After the table.',
      ...(large ? ['padding text\n'.repeat(8100)] : [])].join('\n');
    await page.evaluate(text => {
      (window as any).__tableCellEditor?.destroy();
      const harness = (window as any).TableStabilityHarness;
      const editor = (window as any).__tableCellEditor = harness.createEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
      const handle: typeof import('../webview/src/helpers/shortcuts').handleEditorShortcut = harness.handleEditorShortcut;
      editor.view.dom.addEventListener('keydown', (event: KeyboardEvent) => {
        handle(event, { editor, editableMode: 'live', editorSurfaceActive: true, platform: 'windows',
          requestSave() {}, openFindPanel() {}, requestMode() {} });
      }, { capture: true });
    }, text);
    await page.waitForSelector(inputAt(2));
    await page.waitForFunction(large => (window as any).TableStabilityHarness
      .usesLargeDocumentDerivedWorkBudget((window as any).__tableCellEditor.view.state) === large, {}, large);
    assert.equal(await page.$eval(table, element => element.hasAttribute('data-meo-table-windowed')), windowed);
    await settle();
  };
  const edit = async (row: number) => {
    const point = await page.$eval(inputAt(row), input => {
      const rect = input.parentElement!.getBoundingClientRect();
      const viewport = input.closest('.cm-scroller')!.getBoundingClientRect();
      return { x: rect.left + 12, y: Math.max(rect.top, viewport.top) + 12 };
    });
    await page.mouse.click(point.x, point.y);
    await settle();
    assert(await page.$eval(inputAt(row), input => input === document.activeElement), 'The cell owns native input before the layout change');
  };
  const resize = (row: number, delta: number) => dragTableHeightColumn(page, delta, () => rowHeight(row), settle);

  for (const [large, windowed] of [[false, false], [true, false], [true, true]] as const) {
    const label = `${windowed ? 'windowed' : large ? 'optimized' : 'ordinary'}/${sizing}`;
    if (!process.argv.includes('--move-height-only')) {
      const sentence = 'Changing the column width changes word wrapping. '.repeat(12);
      const longRow = `| ${sentence} | ${sentence} |`;
      const rows = windowed ? ['| short | short |', '| short | short |'] : [longRow, '| short | short |'];
      await open(rows, large, windowed, windowed ? longRow : undefined);
      const row = windowed ? 0 : 1;
      const initial = await rowHeight(row);
      await resize(row, -150);
      const narrow = await rowHeight(row);
      assert(narrow > initial + 20, `${label}/narrow reading row grows (${initial} → ${narrow})`);
      const widened = await resize(row, 150);
      assert(Math.abs(widened - initial) < 2,
        `${label}/reading row shrinks during drag (${narrow} → ${widened}, expected ${initial})`);

      await resize(row, -150);
      await edit(row);
      const narrowEditing = await rowHeight(row);
      for (let cycle = 0; cycle < 2; cycle++) {
        const wideEditing = await resize(row, 150);
        assert(wideEditing < narrowEditing - 20 && Math.abs(wideEditing - initial) < 2,
          `${label}/editing row shrinks during drag ${cycle + 1} (${narrowEditing} → ${wideEditing}, expected ${initial})`);
        assert(Math.abs(await rowHeight(row) - initial) < 2, `${label}/editing row stays compact after release`);
        assert(await page.$eval(inputAt(row), input => input === document.activeElement), `${label}/resize keeps the active editor`);
        assert(Math.abs(await resize(row, -150) - narrowEditing) < 2, `${label}/narrowing restores the original wrapping`);
      }
      await page.keyboard.press('Escape');
      await settle();
      assert(Math.abs(await rowHeight(row) - narrow) < 2, `${label}/leaving editing restores the narrow reading height`);
    }
    if (!process.argv.includes('--resize-height-only')) {
      const short = `| [link](https://example.test/${'a'.repeat(60)}) | short |`;
      const tall = `| Line ${Array.from({ length: 12 }, (_, index) => index + 1).join('<br>Line ')} | tall |`;
      await open([short, tall], large, windowed);
      const shortReading = await rowHeight(1), tallReading = await rowHeight(2);
      await edit(1);
      const shortEditing = await rowHeight(1);
      const shortCaret = await page.$eval(inputAt(1), input => input.selectionStart);
      assert(shortEditing > shortReading + 10 && tallReading > shortEditing + 20,
        `${label}/fixture distinguishes rendered, source and neighbor heights (${[shortReading, shortEditing, tallReading]})`);
      for (const [key, row] of [['ArrowDown', 2], ['ArrowUp', 1]] as const) {
        await page.keyboard.down('Alt');
        await page.keyboard.press(key);
        await page.keyboard.up('Alt');
        await page.waitForFunction(selector => {
          const input = document.querySelector<HTMLTextAreaElement>(selector);
          return input === document.activeElement && input?.value.startsWith('[link]');
        }, { timeout: 3000 }, inputAt(row));
        await settle();
        assert.equal(await page.$eval(inputAt(row), input => input.selectionStart), shortCaret,
          `${label}/${key} preserves the caret inside the moved fragment`);
        const moved = await rowHeight(row);
        assert(Math.abs(moved - shortEditing) < 2,
          `${label}/${key} keeps the moved row's current source height (${shortEditing} → ${moved}, neighbor ${tallReading})`);
        assert(Math.abs(await rowHeight(3 - row) - tallReading) < 2, `${label}/${key} keeps the other row's rendered height`);
      }
      await page.keyboard.press('Escape');
      await settle();
      assert(Math.abs(await rowHeight(1) - shortReading) < 2, `${label}/moved row returns to its own reading height`);
    }
    console.log(`Table row heights during layout changes passed (${label})`);
  }
}

async function checkCellHeightTransitions(page: import('puppeteer-core').Page, sizing = 'native') {
  const inputAt = (row: number, col: number) => `tbody tr:nth-child(${row}) td:nth-child(${col}) textarea`;
  const rowHeight = (row: number) => page.$eval(`tbody tr:nth-child(${row})`, element => element.getBoundingClientRect().height);
  const settle = () => page.evaluate(() => new Promise<void>(resolve => {
    let frames = 8;
    const next = () => --frames ? requestAnimationFrame(next) : resolve();
    requestAnimationFrame(next);
  }));
  const clickCell = async (row: number, col: number) => {
    const pointAt = () => page.$eval(inputAt(row, col), input => {
      const rect = input.parentElement!.getBoundingClientRect();
      const viewport = input.closest('.cm-scroller')!.getBoundingClientRect();
      return { x: rect.left + 12, y: Math.max(rect.top, viewport.top) + 12 };
    });
    let point = await pointAt(), stable = false;
    // Native hit testing can clamp a short document after source shrinkage.
    // Hover before accepting the final point, without repeating any press.
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.mouse.move(point.x, point.y);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const next = await pointAt();
      if (Math.abs(point.x - next.x) < .5 && Math.abs(point.y - next.y) < .5) { stable = true; break; }
      point = next;
    }
    assert(stable, 'the independent click target must settle before pressing');
    await page.mouse.down(); await page.mouse.up();
    await settle();
    const state = await page.$eval(inputAt(row, col), input => ({
      active: input === document.activeElement,
      top: input.getBoundingClientRect().top,
      viewport: input.closest('.cm-scroller')?.getBoundingClientRect().toJSON(),
      owner: document.activeElement?.outerHTML.slice(0, 250)
    }));
    assert(state.active, `clicked cell ${row}/${col} owns native input: ${JSON.stringify(state)}`);
  };
  for (const large of [false, true]) {
    const label = `${large ? 'optimized' : 'ordinary'}-${sizing}`;
    const text = 'before\n\n| A | B | C |\n| --- | --- | --- |\n'
      + `| [a](https://example.test/${'a'.repeat(180)}) | [b](https://example.test/${'b'.repeat(300)}) | plain |\n`
      + '| ![picture](fixture.svg) | image neighbor | end |\n\nafter'
      + (large ? '\n\n' + 'padding text\n'.repeat(8100) : '');
    assert.equal(assessLargeDocument(text).boundedEditorWork, large, `${label}/size policy`);
    await page.evaluate((text: string) => {
      const harness = (window as any).TableStabilityHarness;
      (window as any).__tableCellEditor?.destroy();
      harness.setImageSrcResolver(() => 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="160"><rect width="100" height="160" fill="teal"/></svg>'
      ));
      (window as any).__tableCellEditor = harness.createEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
    }, text);
    await page.waitForFunction((large: boolean) => (window as any).TableStabilityHarness
      .usesLargeDocumentDerivedWorkBudget((window as any).__tableCellEditor.view.state) === large, {}, large);
    await page.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>('tbody img');
      return image?.complete && image.naturalHeight === 160;
    });
    await settle();
    const reading = await rowHeight(1), imageReading = await rowHeight(2);
    assert(reading < 55, `${label}/hidden link URLs leave no blank height: ${reading}`);
    assert(imageReading >= 160, `${label}/real image sizes the reading row: ${imageReading}`);
    if (process.env.MEO_TEST_SCREENSHOTS) {
      fs.mkdirSync(process.env.MEO_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.MEO_TEST_SCREENSHOTS, `table-height-reading-${label}.png`) });
    }

    // Observe held and released frames: switching cells must not paint a short
    // intermediate row before the next source editor has entered.
    await page.evaluate(() => {
      const samples: number[] = [];
      (window as any).__cellHeightSamples = samples;
      const sample = () => {
        if ((window as any).__cellHeightSamples !== samples) return;
        samples.push(document.querySelector('tbody tr')!.getBoundingClientRect().height);
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await clickCell(1, 1);
    const firstEditing = await rowHeight(1);
    assert(firstEditing > reading + 40, `${label}/active source can grow`);
    await page.evaluate(() => { (window as any).__cellHeightSamples.length = 0; });
    const target = await page.$eval(inputAt(1, 2), input => {
      const rect = input.parentElement!.getBoundingClientRect();
      return { x: rect.left + 12, y: rect.top + 12 };
    });
    await page.mouse.move(target.x, target.y); await page.mouse.down(); await settle();
    assert(Math.abs(await rowHeight(1) - firstEditing) < 2, `${label}/held pointer retains previous row height`);
    await page.mouse.up(); await settle();
    const secondEditing = await rowHeight(1);
    assert(secondEditing > firstEditing + 30, `${label}/same-row handoff accepts the taller new source`);
    const samples = await page.evaluate(() => (window as any).__cellHeightSamples as number[]);
    assert(samples.length >= 8 && samples.every(height => height >= firstEditing - 2 && height <= secondEditing + 2),
      `${label}/same-row handoff has no intermediate collapse: ${JSON.stringify(samples)}`);
    await clickCell(1, 1);
    assert(Math.abs(await rowHeight(1) - firstEditing) < 2, `${label}/shorter source does not inherit the old source height`);
    await clickCell(1, 3);
    assert(Math.abs(await rowHeight(1) - reading) < 2, `${label}/plain neighbor does not inherit previous source height`);
    await clickCell(1, 1);
    await page.keyboard.press('Tab'); await settle();
    assert(await page.$eval(inputAt(1, 2), input => input === document.activeElement && input.selectionStart === 0),
      `${label}/Tab lands at the new fragment boundary`);
    assert(Math.abs(await rowHeight(1) - secondEditing) < 2, `${label}/Tab uses the height of the newly revealed source`);
    await page.keyboard.press('ArrowRight'); await settle();
    assert(Math.abs(await rowHeight(1) - secondEditing) < 2, `${label}/entering the link uses the new source height`);
    await page.keyboard.press('Escape'); await settle();
    assert(Math.abs(await rowHeight(1) - reading) < 2, `${label}/editing exit restores rendered height`);

    await page.mouse.move(450, 250); await page.mouse.wheel({ deltaY: -2000 });
    await page.waitForFunction(() => (window as any).__tableCellEditor.view.scrollDOM.scrollTop < 1);
    await settle();
    await clickCell(1, 1);
    const dragPoints = await page.evaluate(() => {
      const at = (selector: string) => {
        const rect = document.querySelector(selector)!.getBoundingClientRect();
        return { x: rect.left + 12, y: rect.top + 12 };
      };
      return { start: at('tbody tr:first-child td:nth-child(3)'), end: at('tbody tr:nth-child(2) td:nth-child(2)') };
    });
    await page.mouse.move(dragPoints.start.x, dragPoints.start.y); await page.mouse.down();
    await page.mouse.move(dragPoints.end.x, dragPoints.end.y, { steps: 4 }); await settle();
    assert(Math.abs(await rowHeight(1) - firstEditing) < 2, `${label}/cross-cell drag keeps the old editing geometry while held`);
    await page.mouse.up(); await settle();
    assert(Math.abs(await rowHeight(1) - reading) < 2, `${label}/released cell range retires the source height`);
    await page.keyboard.press('Escape'); await settle();

    // Start the independent image case at a visible row, after a real reading
    // gesture retires the source caret's earlier navigation intent.
    await page.mouse.move(450, 250); await page.mouse.wheel({ deltaY: -2000 });
    await page.waitForFunction(() => (window as any).__tableCellEditor.view.scrollDOM.scrollTop < 1);
    await settle();
    await clickCell(2, 1);
    assert(Math.abs(await rowHeight(2) - imageReading) < 2, `${label}/image row does not shrink on entry`);
    await page.keyboard.press('Escape'); await settle();
    const imageOwners = await page.evaluate(() => ({
      inTable: document.querySelectorAll('.cm-content table .meo-md-image').length,
      outsideTable: [...document.querySelectorAll('.cm-content .meo-md-image')]
        .filter(image => !image.closest('table')).length
    }));
    assert.deepEqual(imageOwners, { inTable: 1, outsideTable: 0 },
      `${label}/leaving the image cell keeps its preview inside the table`);
    await clickCell(2, 1);
    await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
    await page.keyboard.type('long '.repeat(110)); await settle();
    const grown = await rowHeight(2);
    assert(grown > imageReading + 30, `${label}/source can grow beyond the image baseline`);
    await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
    await page.keyboard.type('small'); await settle();
    assert(Math.abs(await rowHeight(2) - imageReading) < 2, `${label}/deletion returns to entry baseline, not historical maximum`);
    if (process.env.MEO_TEST_SCREENSHOTS) {
      await page.screenshot({ path: path.join(process.env.MEO_TEST_SCREENSHOTS, `table-height-editing-${label}.png`) });
    }
    await clickCell(2, 2);
    assert(await rowHeight(2) < 55, `${label}/same-row handoff uses the latest preview after image deletion`);
    await page.keyboard.press('Escape'); await settle();
    assert(await rowHeight(2) < 55, `${label}/editing exit releases the baseline`);
    await page.evaluate(() => { (window as any).__cellHeightSamples = null; });
    if (process.env.MEO_TEST_SCREENSHOTS) {
      fs.mkdirSync(process.env.MEO_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.MEO_TEST_SCREENSHOTS, `table-height-${label}.png`) });
    }
    console.log(`Table rendered/source height transitions passed (${label}, actual derived-work budget)`);
  }
}

async function checkCellHeightFallback(page: import('puppeteer-core').Page) {
  await page.evaluate(() => {
    const removed: Array<{ sheet: CSSStyleSheet; index: number; text: string }> = [];
    for (const sheet of document.styleSheets) {
      for (let index = sheet.cssRules.length - 1; index >= 0; index--) {
        const rule = sheet.cssRules[index]!;
        if (rule instanceof CSSSupportsRule && rule.conditionText.includes('field-sizing')) {
          removed.push({ sheet, index, text: rule.cssText });
          sheet.deleteRule(index);
        }
      }
    }
    const supports = CSS.supports as (...args: string[]) => boolean;
    CSS.supports = (...args: string[]) => args[0] === 'field-sizing' ? false : supports.apply(CSS, args);
    (window as any).__restoreCellSizing = () => {
      CSS.supports = supports;
      for (const { sheet, index, text } of removed.reverse()) sheet.insertRule(text, index);
    };
  });
  try {
    await checkProjectedCellHeight(page, 'fallback');
    await checkCellHeightTransitions(page, 'fallback');
    await checkCellHeightLayoutChanges(page, 'fallback');
  } finally {
    await page.evaluate(() => { (window as any).__restoreCellSizing(); delete (window as any).__restoreCellSizing; });
  }
}

async function checkCellEntryRegressions(page: any) {
  const first = 'tbody td:first-child textarea';
  const preview = 'tbody td:nth-child(2) .meo-md-html-table-cell-preview';
  for (const large of [false, true]) {
    const text = 'outside before\n\n| A | B |\n| --- | --- |\n| seed | abcdefghijklmnopqrstuvwxyz |\n\noutside after'
      + (large ? '\n\n' + 'padding text\n'.repeat(8100) : '');
    const label = large ? 'optimized' : 'ordinary';
    assert.equal(assessLargeDocument(text).boundedEditorWork, large, `${label}/policy`);
    const reset = async () => {
      await page.evaluate((text: string) => {
        (window as any).__tableCellEditor?.destroy();
        (window as any).__tableCellEditor = (window as any).TableStabilityHarness.createEditor({
          parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
        });
      }, text);
      await page.waitForSelector(first);
      await page.waitForFunction((large: boolean) => (window as any).TableStabilityHarness
        .usesLargeDocumentDerivedWorkBudget((window as any).__tableCellEditor.view.state) === large, {}, large);
    };
    if (!process.argv.includes('--entry-drag-only')) {
      for (const delay of [0, 75, 150]) {
        await reset();
        await page.click('tbody td:first-child .meo-md-html-table-cell-preview');
        await page.keyboard.press('End');
        await page.$eval(first, (input: HTMLTextAreaElement) => { (window as any).__entryInput = input; });
        await page.keyboard.type('x ', { delay });
        // Let the normal auto-commit and derived presentation both complete.
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 220)));
        const state = await page.$eval(first, (input: HTMLTextAreaElement) => ({ value: input.value,
          start: input.selectionStart, end: input.selectionEnd, active: document.activeElement === input,
          retained: input === (window as any).__entryInput }));
        assert.deepEqual(state, { value: 'seedx ', start: 6, end: 6, active: true, retained: true }, `${label}/${delay}ms trailing space`);
        // A presentation-only refresh must also retain whitespace in the native session.
        await page.evaluate(() => {
          const editor = (window as any).__tableCellEditor;
          editor.commitTransientEdits();
          const from = editor.view.state.doc.toString().indexOf('seedx');
          editor.setDiagnostics([{ from, to: from + 1, severity: 1, message: 'Cell presentation refresh' }]);
        });
        await page.keyboard.type('y');
        await page.keyboard.press('Escape');
        const edited = await page.evaluate(() => (window as any).__tableCellEditor.getText());
        assert.equal(edited, text.replace('seed', 'seedx y'), `${label}/committed separator`);
        await page.evaluate(async () => {
          const editor = (window as any).__tableCellEditor, depth = editor.getHistoryDepth().undo;
          for (let i = 0; i < depth; i++) await editor.undo();
        });
        assert.equal(await page.evaluate(() => (window as any).__tableCellEditor.getText()), text, `${label}/undo`);
        await page.evaluate(async () => {
          const editor = (window as any).__tableCellEditor, depth = editor.getHistoryDepth().redo;
          for (let i = 0; i < depth; i++) await editor.redo();
        });
        assert.equal(await page.evaluate(() => (window as any).__tableCellEditor.getText()), edited, `${label}/redo`);
      }
    }
    if (!process.argv.includes('--rapid-input-only')) {
      for (const origin of ['body', 'cell'] as const) {
        await reset();
        if (origin === 'cell') await page.click('tbody td:first-child .meo-md-html-table-cell-preview');
        else await page.click('.cm-line');
        const points = await page.$eval(preview, (element: HTMLElement) => {
          const node = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
          const at = (offset: number) => {
            const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
            const box = range.getBoundingClientRect();
            return { x: Math.ceil(box.left + 2), y: Math.round(box.top + box.height / 2) };
          };
          (window as any).__entryPreview = element;
          return { start: at(0), middle: at(5), end: at(11) };
        });
        await page.mouse.move(points.start.x, points.start.y);
        await page.mouse.down();
        let selectedLength = 0;
        for (const point of [points.middle, points.end]) {
          await page.mouse.move(point.x, point.y, { steps: 3 });
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const held = await page.$eval(preview, (element: HTMLElement) => ({ selected: window.getSelection()?.toString(),
            retained: element === (window as any).__entryPreview, tableFocused: document.activeElement === element.closest('table') }));
          assert(held.selected && 'abcdefghijklmnopqrstuvwxyz'.startsWith(held.selected), `${label}/${origin}/held text: ${JSON.stringify(held)}`);
          assert(held.selected.length > selectedLength, `${label}/${origin}/held range grows with the pointer`);
          selectedLength = held.selected.length;
          assert(held.retained && held.tableFocused, `${label}/${origin}/held owner`);
        }
        const selected = await page.evaluate(() => window.getSelection()?.toString());
        if (process.env.MEO_TEST_SCREENSHOTS) {
          fs.mkdirSync(process.env.MEO_TEST_SCREENSHOTS, { recursive: true });
          await page.screenshot({ path: path.join(process.env.MEO_TEST_SCREENSHOTS, `table-held-${label}-${origin}.png`) });
        }
        await page.mouse.up();
        const released = await page.$eval('tbody td:nth-child(2) textarea', (input: HTMLTextAreaElement) => ({
          selected: input.value.slice(input.selectionStart, input.selectionEnd), active: document.activeElement === input
        }));
        assert.deepEqual(released, { selected, active: true }, `${label}/${origin}/released range`);
        assert.equal(await page.evaluate(() => (window as any).__tableCellEditor.getText()), text, `${label}/${origin}/unchanged text`);
      }
    }
    console.log(`Table rapid input and held entry selection passed (${label}, actual derived-work budget)`);
  }
}

async function checkCellEditingKeys(page: import('puppeteer-core').Page, cases: 'break-deletion' | 'structure') {
  const cell = 'tbody td:first-child textarea';
  const preview = 'tbody td:first-child .meo-md-html-table-cell-preview';
  const table = (value: string) => `| Header |\n| --- |\n| ${value} |`;
  const checkEdit = async (
    before: string,
    selection: [number, number],
    key: 'Backspace' | 'Delete' | 'Shift+Enter' | 'cellBreak',
    expected: { value: string; caret: number; source: string },
    { large = false, wholeCell = false, checkHistory = cases === 'structure' } = {}
  ) => {
    const suffix = large ? '\n\n' + 'padding text\n'.repeat(8100) : '';
    const original = table(before.replaceAll('\n', '')) + suffix;
    await page.evaluate(text => {
      (window as any).__tableCellEditor?.destroy();
      (window as any).__tableCellEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
    }, original);
    await page.waitForFunction(expected => {
      const app = window as any;
      return app.TableStabilityHarness.usesLargeDocumentDerivedWorkBudget(app.__tableCellEditor.view.state) === expected;
    }, {}, large);
    await page.waitForSelector(preview, { visible: true });
    await page.click(preview);
    if (wholeCell) {
      await page.keyboard.down('Shift');
      await page.keyboard.press('F10');
      await page.keyboard.up('Shift');
      await page.click('.meo-md-html-table-context-next');
      await page.click('button[aria-label="Edit entire cell"]');
      assert.equal(await page.$(`${preview} .meo-md-table-active-source-line`), null);
    }
    const initial = await page.$eval(cell, (input, [from, to]) => {
      if (input !== document.activeElement) throw new Error('clicked cell must own native input');
      input.setSelectionRange(from, to);
      return input.value;
    }, selection);
    assert.equal(initial, before);
    if (key === 'cellBreak') {
      assert.equal(await page.evaluate(() => (window as any).__tableCellEditor.executeCommand('cellBreak')), true);
    } else if (key === 'Shift+Enter') {
      await page.keyboard.down('Shift');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Shift');
    } else {
      await page.keyboard.press(key);
    }
    const edited = await page.$eval(cell, input => ({
      value: input.value, start: input.selectionStart, end: input.selectionEnd
    }));
    const label = `${key} at ${selection} in ${JSON.stringify(before)}`;
    assert.deepEqual(edited, { value: expected.value, start: expected.caret, end: expected.caret }, label);
    await page.keyboard.press('Escape');
    const source = await page.evaluate(() => (window as any).__tableCellEditor.getText());
    assert.equal(source, table(expected.source) + suffix, `${label} commits the edited cell`);
    if (checkHistory) {
      const history = await page.evaluate(async () => {
        const editor = (window as any).__tableCellEditor;
        const depth = editor.getHistoryDepth();
        const undone = await editor.undo();
        const afterUndo = editor.getText();
        const redone = await editor.redo();
        return { undoDepth: depth.undo, undone, afterUndo, redone, afterRedo: editor.getText() };
      });
      assert.deepEqual(history, { undoDepth: 1, undone: true, afterUndo: original, redone: true, afterRedo: source }, label);
    }
  };

  if (cases === 'structure') {
    const withCaret = (marked: string) => ({ value: marked.replace('|', ''), caret: marked.indexOf('|') });
    for (const large of [false, true]) for (const [before, key, after] of [
      ['1. First<BR />\n2. |Second<br/>\n3. Third', 'Backspace', '1. First<BR />\n|Second<br/>\n3. Third'],
      ['1. First<BR />\n2. |<br/>\n3. Third', 'Backspace', '1. First<BR />\n2. |Third'],
      ['1. First<br>\n2. |Second<br>\n    - Child', 'Backspace', '1. First<br>\n|Second<br>\n- Child'],
      ['8. First<BR />\n9. |Second<br/>\n10. Third', 'Shift+Enter', '8. First<BR />\n9. |<br>\n10. Second<br/>\n11. Third'],
      ['- Top<br/>\n  - [x] |Nested<br>\n- Last', 'Shift+Enter', '- Top<br/>\n  - [ ] |<br>\n  - [x] Nested<br>\n- Last'],
      ['> Start<br>\n> > Nested|<BR />\n> End', 'Shift+Enter', '> Start<br>\n> > Nested<br>\n> > |<BR />\n> End'],
      ['One<br>\n> Quote|', 'cellBreak', 'One<br>\n> Quote<br>\n> |'],
      ['1. First<br/>\n2. Second|<br>\n3. Third', 'Shift+Enter', '1. First<br/>\n2. Second<br>\n3. |<br>\n4. Third'],
      ['- Al|pha', 'Shift+Enter', '- Al<br>\n- |pha'],
      ['- [ ] Earlier<br>\n<br>\n- [ ] Al|pha', 'Shift+Enter', '- [ ] Earlier<br>\n<br>\n- [ ] Al<br>\n- [ ] |pha'],
      ['- 1. [x] |Alpha', 'Shift+Enter', '- 1. [ ] |<br>\n  2. [x] Alpha'],
      ['- 1. [x] Al|pha', 'Shift+Enter', '- 1. [x] Al<br>\n  2. [ ] |pha'],
      ['- 1. [x] Alpha|', 'Shift+Enter', '- 1. [x] Alpha<br>\n  2. [ ] |'],
      ['- [ ]|', 'Shift+Enter', '|'],
      ['> Al|pha', 'Shift+Enter', '> Al<br>\n> |pha'],
      ['1. > - [x] Alpha| Beta', 'Shift+Enter', '1. > - [x] Alpha<br>\n   > - [ ] |Beta'],
      ['100. > - [x] First<br>\n     > - [ ] Al|pha', 'Shift+Enter', '100. > - [x] First<br>\n     > - [ ] Al<br>\n     > - [ ] |pha'],
      ['> 7. A|lpha<br>\n> 8. Beta', 'Shift+Enter', '> 7. A<br>\n> 8. |lpha<br>\n> 9. Beta'],
      ['9. Al|pha<BR />\n10. Beta', 'Shift+Enter', '9. Al<br>\n10. |pha<BR />\n11. Beta'],
      ['> - [x] Al|pha<BR />\n> - Beta', 'Shift+Enter', '> - [x] Al<br>\n> - [ ] |pha<BR />\n> - Beta'],
      ['3) [x] Al|pha<BR />\n4) Beta', 'cellBreak', '3) [x] Al<br>\n4) [ ] |pha<BR />\n5) Beta']
    ] as const) {
      const initial = withCaret(before);
      const expected = withCaret(after);
      await checkEdit(initial.value, [initial.caret, initial.caret], key,
        { ...expected, source: expected.value.replaceAll('\n', '').trim() }, { large });
    }
    await page.evaluate(() => (window as any).__tableCellEditor.destroy());
    console.log('table list and quote editing passed');
    return;
  }

  const joined = { value: 'AB', caret: 1, source: 'AB' };
  for (const large of [false, true]) for (const tag of ['<br>', '<br/>', '<BR />']) {
    const before = `A${tag}\nB`;
    const lineEnd = 1 + tag.length;
    const withoutClosing = `A${tag.slice(0, -1)}B`;
    await checkEdit(before, [lineEnd, lineEnd], 'Backspace',
      { value: withoutClosing, caret: lineEnd - 1, source: withoutClosing }, { large });
    await checkEdit(before, [lineEnd + 1, lineEnd + 1], 'Backspace', joined, { large, checkHistory: tag === '<br>' });
    await checkEdit(before, [lineEnd, lineEnd], 'Delete', { value: `A${tag}\n`, caret: lineEnd, source: `A${tag}` }, { large });
    await checkEdit(before, [1, 1], 'Delete', joined, { large });
    await checkEdit(before, [1, lineEnd], 'Backspace', joined, { large });
  }
  for (const large of [false, true]) {
    const wholeCell = { large, wholeCell: true };
    for (const offset of [5, 6]) {
      await checkEdit('A<br>\nB', [offset, offset], 'Backspace', { value: 'A<brB', caret: 4, source: 'A<brB' },
        { ...wholeCell, checkHistory: offset === 5 });
    }
    await checkEdit('A<br>\nB', [1, 1], 'Delete', { value: 'Abr>B', caret: 1, source: 'Abr>B' }, wholeCell);
    await checkEdit('A<br>\n👩‍💻B', [5, 5], 'Delete', { value: 'A<br>\nB', caret: 5, source: 'A<br>B' }, wholeCell);
    await checkEdit('A<br>\nB', [1, 5], 'Delete', joined, wholeCell);
    await checkEdit('A<br>\n<br>\nB', [5, 5], 'Delete', { value: 'A<br>\nbr>B', caret: 5, source: 'A<br>br>B' }, { large });
  }
  await checkEdit('A<br/>\nB', [5, 5], 'Backspace', { value: 'A<br>\nB', caret: 4, source: 'A<br>B' });
  await checkEdit('A<br>\nB', [3, 3], 'Backspace', { value: 'A<r>B', caret: 2, source: 'A<r>B' });
  await checkEdit('A<br>\nB<br>\nC', [4, 5], 'Delete', {
    value: 'A<brB<br>\nC', caret: 4, source: 'A<brB<br>C'
  });
  await checkEdit('A<br>\nB<br>\nC<br>\nD', [6, 11], 'Delete', {
    value: 'A<br>\nC<br>\nD', caret: 6, source: 'A<br>C<br>D'
  });
  const emptyItem = '1. First<br>\n2. <br/>\nThird';
  const tagEnd = emptyItem.indexOf('<br/>') + '<br/>'.length;
  await checkEdit(emptyItem, [tagEnd + 1, tagEnd + 1], 'Backspace', {
    value: '1. First<br>\n2. Third', caret: emptyItem.indexOf('<br/>'), source: '1. First<br>2. Third'
  });
  await page.evaluate(() => (window as any).__tableCellEditor.destroy());
  console.log('table cell break deletion passed');
}

async function checkCellLinePresentation(page: import('puppeteer-core').Page) {
  const inputSelector = 'tbody td:first-child textarea';
  const previewSelector = 'tbody td:first-child .meo-md-html-table-cell-preview';
  const sourceSelector = `${previewSelector} .meo-md-table-active-source-line`;
  const open = async (cell: string) => {
    const markdown = `| Header |\n| --- |\n| ${cell} |`;
    await page.evaluate(text => {
      (window as any).__tableCellEditor?.destroy();
      (window as any).__tableCellEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
    }, markdown);
    await page.waitForSelector(previewSelector, { visible: true });
    return markdown;
  };
  const point = (selector: string, offset = 0) => page.$eval(`${previewSelector} ${selector}`, (element, offset) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode()!;
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width / 5, y: (rect.top + rect.bottom) / 2 };
  }, offset);
  const activeLine = () => page.$eval(sourceSelector, element => element.textContent);
  const activeInput = () => page.$eval(inputSelector, input => ({
    active: document.activeElement === input, value: input.value,
    start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection
  }));

  const cell = '**Alpha**<br>[Middle](https://example.test/a-long-link)<br>**Omega**';
  const source = await open(cell);
  const first = await point('.meo-md-html-table-cell-line:first-child strong', 1);
  const middle = await point('.meo-md-html-table-cell-line:nth-child(2) .meo-md-link', 1);
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.down();
  assert.equal(await page.$(sourceSelector), null, 'the pressed cell retains its reading layout');
  await page.mouse.up();
  assert.equal(await activeLine(), '[Middle](https://example.test/a-long-link)<br>');
  assert(await page.$eval(`${sourceSelector} .meo-md-table-source-break`, element => element.getBoundingClientRect().width > 0),
    'the terminating break is visible while editing other text on its logical line');
  assert.deepEqual(await page.$$eval(`${previewSelector} strong`, elements => elements.map(element => element.textContent)),
    ['Alpha', 'Omega'], 'other lines keep their inline rendering');

  await page.keyboard.press('ArrowUp');
  assert.equal(await activeLine(), '**Alpha**<br>', 'moving up activates the previous logical line');
  await page.keyboard.press('ArrowDown');
  assert.equal(await activeLine(), '[Middle](https://example.test/a-long-link)<br>');
  const middleCaret = (await activeInput()).start;
  const omega = await point('.meo-md-html-table-cell-line:last-child strong', 3);
  await page.keyboard.down('Shift');
  await page.mouse.click(omega.x, omega.y);
  await page.keyboard.up('Shift');
  const extended = await activeInput();
  assert.equal(extended.start, middleCaret, 'Shift-click keeps the existing anchor');
  assert.equal(extended.end, extended.value.indexOf('Omega') + 3);
  assert.equal(await activeLine(), 'Omega', 'a selection crossing fragments keeps their formatting');
  const omegaWord = await point('.meo-md-table-active-source-line strong', 2);
  await page.mouse.click(omegaWord.x, omegaWord.y, { count: 2 });
  const word = await activeInput();
  assert.equal(word.value.slice(word.start, word.end), 'Omega', 'double-click selects a word inside the active line');
  const renderedFirst = await point('.meo-md-html-table-cell-line:first-child strong', 1);
  await page.mouse.move(renderedFirst.x, renderedFirst.y);
  await page.mouse.down();
  assert.equal(await activeLine(), '**Omega**', 'a new press preserves the previously active source line');
  await page.mouse.up();
  assert.equal(await activeLine(), '**Alpha**<br>');
  await page.keyboard.press('Escape');
  assert.equal(await page.$(sourceSelector), null, 'leaving the cell restores its reading layout');

  const last = await point('.meo-md-html-table-cell-line:last-child strong', 3);
  const value = cell.replaceAll('<br>', '<br>\n');
  for (const backwards of [false, true]) {
    const [start, end] = backwards ? [last, first] : [first, last];
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 8 });
    assert.equal(await page.$(sourceSelector), null, 'dragging keeps the reading layout until release');
    const held = await page.evaluate(() => document.getSelection()?.toString());
    assert.ok(held?.includes('Middle'), `native drag selection spans the rendered lines: ${held}`);
    await page.mouse.up();
    const selection = await activeInput();
    assert.deepEqual(selection, {
      active: true, value, start: 3, end: value.indexOf('Omega') + 3, direction: backwards ? 'backward' : 'forward'
    });
    assert.equal(await activeLine(), backwards ? 'Alpha<br>' : 'Omega', 'a drag selection keeps each fragment rendered');
    const copied = await page.$eval(inputSelector, input => {
      const clipboard = new DataTransfer();
      input.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: clipboard }));
      return clipboard.getData('text/plain');
    });
    assert.equal(copied, cell.slice(3, cell.indexOf('Omega') + 3), 'copy uses Markdown with its original break tags');
    await page.keyboard.press('Escape');
  }

  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  await page.mouse.move(last.x, last.y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.type('x');
  assert.equal((await activeInput()).value, '**Axga**');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => (window as any).__tableCellEditor.undo()), true);
  assert.equal(await page.evaluate(() => (window as any).__tableCellEditor.getText()), source, 'one undo restores the range and break tags');

  await open('1. **First**<br>2. **Second**<br>> **Quote one**<br>> **Quote two**');
  const list = await point('ol li:nth-child(2) strong', 2);
  await page.mouse.click(list.x, list.y);
  assert.equal(await activeLine(), '2. **Second**<br>');
  assert.equal(await page.$$eval(`${previewSelector} ol li`, items => items.length), 2, 'both items stay in the same list');
  assert.ok(await page.$(`${sourceSelector}:not(.is-prefix-source) .meo-md-table-source-prefix`),
    'list marker remains rendered while editing its text');
  await page.keyboard.press('Home');
  const home = await activeInput();
  const markerStart = home.value.indexOf('2. ');
  for (let offset = home.start; offset > markerStart + 1; offset--) await page.keyboard.press('ArrowLeft');
  assert.ok(await page.$(`${sourceSelector}.is-prefix-source .meo-md-table-source-prefix`),
    'entering the marker reveals its source');
  const quote = await point('blockquote .meo-md-html-table-cell-line:last-child strong', 1);
  await page.mouse.move(quote.x, quote.y);
  await page.mouse.down();
  assert.ok(await page.$(`${sourceSelector}.is-prefix-source`), 'a held press preserves the previous source prefix');
  await page.mouse.up();
  assert.equal(await activeLine(), '> **Quote two**');
  assert.equal(await page.$eval(sourceSelector, element => element.closest('blockquote')?.textContent),
    'Quote one> **Quote two**', 'both lines retain the same quote container');

  if (process.env.MEO_TEST_SCREENSHOTS) {
    fs.mkdirSync(process.env.MEO_TEST_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.MEO_TEST_SCREENSHOTS, 'table-active-source-line.png') });
  }
  await page.keyboard.down('Shift');
  await page.keyboard.press('F10');
  await page.keyboard.up('Shift');
  await page.click('.meo-md-html-table-context-next');
  await page.click('button[aria-label="Edit entire cell"]');
  assert.equal(await page.$(sourceSelector), null, 'the full-cell edit action removes the row projection');
  assert.equal((await activeInput()).active, true);

  await page.evaluate(() => {
    (window as any).TableStabilityHarness.setImageSrcResolver(() =>
      'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"/>'));
  });
  await open('![Context](fixture.svg)<br>**Edit this line**');
  const originalImage = await page.waitForSelector(`${previewSelector} .meo-md-image`);
  await page.waitForFunction(selector => {
    const image = document.querySelector<HTMLImageElement>(`${selector} img`);
    return image?.complete && image.naturalWidth > 0;
  }, {}, previewSelector);
  const edit = await point('.meo-md-html-table-cell-line:last-child strong', 4);
  await page.mouse.click(edit.x, edit.y);
  await page.keyboard.type('x');
  assert.equal(await page.$eval(`${previewSelector} .meo-md-image`, (image, before) => image === before, originalImage), true,
    'editing a line retains the image DOM on a neighboring rendered line');
  await originalImage?.dispose();

  await open('First<br>Second<br>Third');
  const second = await point('.meo-md-html-table-cell-line:nth-child(2)', 3);
  await page.mouse.click(second.x, second.y);
  const session = await page.createCDPSession();
  try {
    await session.send('Input.imeSetComposition', { text: 'pinyin', selectionStart: 6, selectionEnd: 6 });
    assert.match((await activeInput()).value, /Secpinyinond/);
    assert.notEqual(await page.$eval(inputSelector, input => getComputedStyle(input).color), 'rgba(0, 0, 0, 0)',
      'the active native input paints IME preedit');
    assert.ok(!(await page.evaluate(() => (window as any).__tableCellEditor.getText())).includes('pinyin'));
    await session.send('Input.insertText', { text: '字' });
    assert.equal(await activeLine(), 'Sec字ond<br>', 'the source line paints the confirmed composition');
    assert.equal(await page.$eval(inputSelector, input => getComputedStyle(input).color), 'rgba(0, 0, 0, 0)');
  } finally {
    await session.detach();
  }
  await page.evaluate(() => (window as any).__tableCellEditor.destroy());
  console.log('table active source line checks passed');
}

async function checkSingleLineCellPresentation(page: import('puppeteer-core').Page) {
  const preview = 'td .meo-md-html-table-cell-preview';
  const active = '.meo-md-table-active-source-line';
  const layout = await page.addStyleTag({ content: `
    .cm-editor .meo-md-html-table { width: 190px !important; table-layout: fixed !important; }
    .cm-editor .meo-md-html-table :is(th, td) { width: 190px !important; max-width: 190px !important; }
  ` });
  const examples = [
    { prefix: '42. ', body: 'Ordered body across several visual lines in a narrow column', marker: 'ol[start="42"] > li' },
    { prefix: '- ', body: 'Bullet', marker: 'ul > li' },
    { prefix: '- [X] ', body: 'Task', marker: 'input[type="checkbox"]:checked' },
    { prefix: '> ', body: 'Quote', marker: 'blockquote' },
    { prefix: '', body: 'Plain', marker: '' }
  ];
  try {
    for (const large of [false, true]) {
      const label = large ? 'optimized' : 'ordinary';
      const table = '| Item |\n| --- |\n' + examples.map(({ prefix, body }) => `| ${prefix}**${body}** |`).join('\n');
      const markdown = table + (large ? '\n\n' + 'padding text\n'.repeat(8100) : '');
      assert.equal(assessLargeDocument(markdown).boundedEditorWork, large, `${label}/policy`);
      await page.evaluate(text => {
        (window as any).__tableCellEditor?.destroy();
        (window as any).__tableCellEditor = (window as any).TableStabilityHarness.createEditor({
          parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
        });
      }, markdown);
      await page.waitForSelector(`tbody ${preview} strong`, { visible: true });
      await page.waitForFunction(large => (window as any).TableStabilityHarness
        .usesLargeDocumentDerivedWorkBudget((window as any).__tableCellEditor.view.state) === large, {}, large);
      for (const [index, { prefix, body, marker }] of examples.entries()) {
        const row = `tbody tr:nth-child(${index + 1})`;
        const state = `${row} ${preview}`;
        const editor = `${row} td textarea`;
        const glyphAt = (offset: number) => page.$eval(`${state} strong`, (element, offset) => {
          const node = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
          const range = document.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset + 1);
          const rect = range.getBoundingClientRect();
          return { x: rect.left + rect.width / 5, y: (rect.top + rect.bottom) / 2 };
        }, offset);
        const point = await glyphAt(1);
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        assert.equal(await page.$(`${state} ${active}`), null, `${label}/${body}: holding the pointer retains the preview`);
        await page.mouse.up();
        const value = prefix + `**${body}**`;
        assert.deepEqual(await page.$eval(editor, input => ({ value: input.value, active: input === document.activeElement,
          start: input.selectionStart, end: input.selectionEnd })), {
          value, active: true, start: prefix.length + 3, end: prefix.length + 3
        }, `${label}/${body}: the visible click lands on the corresponding source character`);
        if (marker) {
          const markerState = () => page.$eval(`${state} ${active}`, (element, selector) => {
            const prefix = element.querySelector('.meo-md-table-source-prefix')!;
            const marker = element.closest('.meo-md-html-table-cell-preview')!.querySelector(selector)!;
            return {
              prefix: getComputedStyle(prefix).visibility,
              marker: getComputedStyle(marker, marker instanceof HTMLLIElement ? '::marker' : null).visibility,
              markerColor: getComputedStyle(marker, '::marker').color,
              wrapped: element.getBoundingClientRect().height > parseFloat(getComputedStyle(element).lineHeight) * 1.5
            };
          }, marker);
          assert.ok(await page.$(`${state} ${active}`), `${label}/${body}: the single logical line uses the source presentation`);
          assert.equal(await page.$eval(`${state} ${active}`, element => element.textContent), value);
          const readingMarker = await markerState();
          assert.equal(readingMarker.prefix, 'hidden');
          assert.equal(readingMarker.marker, 'visible');
          if (index === 0) assert.ok(readingMarker.wrapped, `${label}: the ordered item spans multiple visual lines`);
          await page.keyboard.down('Shift');
          await page.keyboard.press('ArrowRight');
          await page.keyboard.up('Shift');
          assert.equal(await page.$eval(editor, input => input.value.slice(input.selectionStart, input.selectionEnd)), body[1]);
          assert.equal((await markerState()).prefix, 'hidden', `${label}/${body}: selecting body text keeps the marker rendered`);
          if (!large && index === 2 && process.env.MEO_TEST_SCREENSHOTS) {
            fs.mkdirSync(process.env.MEO_TEST_SCREENSHOTS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.MEO_TEST_SCREENSHOTS, 'table-single-line-task.png') });
          }
          await page.$eval(editor, (input, offset) => input.setSelectionRange(offset, offset), prefix.length);
          await page.keyboard.press('ArrowLeft');
          const editingMarker = await markerState();
          assert.equal(editingMarker.prefix, 'visible', `${label}/${body}: moving into the marker reveals its source`);
          if (index < 2) assert.equal(editingMarker.markerColor, 'rgba(0, 0, 0, 0)', 'the rendered list marker is hidden');
          if (index === 2) assert.equal(editingMarker.marker, 'hidden', 'the checkbox is hidden while editing its source');
          await page.keyboard.press('ArrowRight');
          assert.equal((await markerState()).prefix, 'hidden', `${label}/${body}: leaving the marker restores its rendering`);
          if (index === 0) {
            await page.keyboard.down('Shift');
            await page.keyboard.press('F10');
            await page.keyboard.up('Shift');
            await page.click('.meo-md-html-table-context-next');
            await page.click('button[aria-label="Edit entire cell"]');
            assert.equal(await page.$(`${state} ${active}`), null, 'the whole-cell action allows raw editing');
            assert.equal(await page.$eval(editor, input => input === document.activeElement && input.selectionStart), prefix.length);
          }
          if (index === 1) {
            await page.keyboard.type('x');
            assert.equal(await page.$eval(`${state} ${active}`, element => element.textContent), `${prefix}x**${body}**`,
              'the caret stays adjacent to the revealed fragment after typing');
            assert.equal(await page.$eval(editor, input => input.value), `${prefix}x**${body}**`, 'adjacent typing stays outside the format');
            assert.equal((await markerState()).prefix, 'hidden', 'typing in the body keeps the rendered marker');
            await page.keyboard.press('Escape');
            assert.equal(await page.evaluate(() => (window as any).__tableCellEditor.undo()), true);
          }
          if (index === 2) {
            await page.keyboard.press('Escape');
            const start = await glyphAt(1), end = await glyphAt(3);
            await page.mouse.move(start.x, start.y);
            await page.mouse.down();
            await page.mouse.move(end.x, end.y, { steps: 5 });
            assert.equal(await page.evaluate(() => document.getSelection()?.toString()), body.slice(1, 3));
            assert.equal(await page.$(`${state} ${active}`), null, 'dragging retains the reading presentation');
            await page.mouse.up();
            assert.equal(await page.$eval(editor, input => input.value.slice(input.selectionStart, input.selectionEnd)), body.slice(1, 3));
            assert.equal((await markerState()).marker, 'visible', 'releasing the text drag keeps the checkbox visible');
          }
        } else {
          assert.equal(await page.$eval(`${state} .meo-md-table-inline-source`, element => element.textContent),
            value, `${label}: an unprefixed formatted cell reveals the clicked fragment`);
        }
        await page.keyboard.press('Escape');
      }
      assert.equal(await page.evaluate(() => (window as any).__tableCellEditor.getText()), markdown,
        `${label}: marker presentation and selection do not edit the document`);
      console.log(`Single-line table cell markers passed (${label}, actual derived-work budget)`);
    }
  } finally {
    await page.evaluate(() => (window as any).__tableCellEditor?.destroy());
    await layout.evaluate(element => element.remove());
    await layout.dispose();
  }
}

async function checkCellTypography(page: import('puppeteer-core').Page) {
  const task = 'tbody tr:first-child .meo-md-table-task-content';
  const smallTask = 'tbody tr:nth-child(2) .meo-md-table-task-content';
  const preview = 'tbody tr:nth-child(3) .meo-md-html-table-cell-preview';
  const rootTask = 'tbody tr:nth-child(4) .meo-md-table-task-content';
  const mixedList = 'tbody tr:nth-child(5) .meo-md-html-table-cell-list';
  const layout = await page.addStyleTag({ content: `
    .cm-editor .meo-md-html-table { width: 185px !important; table-layout: fixed !important; }
    .cm-editor .meo-md-html-table :is(th, td) { width: 185px !important; max-width: 185px !important; }
  ` });
  const originalAppearance = await page.evaluate(() =>
    ['style', 'data-editor-appearance', 'data-meo-ui-contrast', 'data-meo-ui-color-source']
      .map(name => [name, document.documentElement.getAttribute(name)] as const));
  const table = '正文行距\n正文第二行\n\n| 标记 |\n| --- |\n'
    + '| - 1. - [X] 多种标记与折行。Task text wraps across several visual lines. |\n'
    + '| > 7. - [ ] 引用任务 |\n| 第一行<br>第二行 |\n| - [ ] 单独任务 |\n| - 普通条目<br>- [x] 混合任务 |';
  const read = (selector: string) => page.$eval(selector, row => {
    const checkbox = row.querySelector('input')!;
    const body = row.lastElementChild!;
    const range = document.createRange();
    const text = document.createTreeWalker(body.querySelector('.meo-md-table-source-body') ?? body, NodeFilter.SHOW_TEXT).nextNode()!;
    range.selectNodeContents(text);
    const box = checkbox.getBoundingClientRect();
    const cell = row.closest('td')!.getBoundingClientRect();
    const preview = row.closest('.meo-md-html-table-cell-preview')!;
    const contentLeft = preview.getBoundingClientRect().left + parseFloat(getComputedStyle(preview).paddingLeft);
    const lineHeight = parseFloat(getComputedStyle(body).lineHeight);
    const center = body.getBoundingClientRect().top + lineHeight / 2;
    const listMarkers = [];
    for (let item = row.closest('li'); item; item = item.parentElement?.closest('li') ?? null) {
      listMarkers.push(getComputedStyle(item).listStyleType);
    }
    return { centerDelta: (box.top + box.bottom) / 2 - center, top: box.top, lineHeight,
      insideCell: box.top >= cell.top && box.bottom <= cell.bottom,
      rows: range.getClientRects().length, listMarkers, checkboxInset: box.left - contentLeft };
  });
  try {
    for (const large of [false, true]) {
      const label = large ? 'optimized' : 'ordinary';
      const markdown = table + (large ? '\n\n' + 'padding text\n'.repeat(8100) : '');
      assert.equal(assessLargeDocument(markdown).boundedEditorWork, large, `${label}/policy`);
      await page.evaluate(({ text, appearance }) => {
        (window as any).__tableCellEditor?.destroy();
        const harness = (window as any).TableStabilityHarness;
        harness.applyBuiltInVisualBaseline(appearance);
        (window as any).__tableCellEditor = harness.createEditor({
          parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
        });
      }, { text: markdown, appearance: large ? 'light' : 'dark' });
      await page.waitForSelector(`${task} input`, { visible: true });
      await page.waitForFunction(large => (window as any).TableStabilityHarness
        .usesLargeDocumentDerivedWorkBudget((window as any).__tableCellEditor.view.state) === large, {}, large);
      for (const [font, spacing] of [[16, 1.5], [10, 1], [20, 1.8]] as const) {
        await page.evaluate(([font, spacing]) => {
          (window as any).__tableCellEditor.preserveViewport(() => {
            const style = document.documentElement.style;
            style.setProperty('--meo-user-editor-font-size', `${font}px`);
            style.setProperty('--meo-user-editor-line-height', String(spacing));
          }, true, { resizeTableRows: true });
        }, [font, spacing]);
        await page.evaluate(async () => {
          for (let frame = 0; frame < 8; frame++) await new Promise(requestAnimationFrame);
        });
        const expected = font * spacing;
        const context = `${label}/${font}/${spacing}`;
        assert.equal(await page.$eval('.cm-line', line => parseFloat(getComputedStyle(line).lineHeight)), expected);
        assert.equal(await page.$eval('thead th textarea', input => parseFloat(getComputedStyle(input).lineHeight)), expected);
        const lineStep = await page.$$eval(`${preview} .meo-md-html-table-cell-line`, lines =>
          lines[1]!.getBoundingClientRect().top - lines[0]!.getBoundingClientRect().top);
        assert.ok(Math.abs(lineStep - expected) < .5, `${context}: explicit line breaks follow body line spacing`);
        const unusedHeight = await page.$eval(preview, element => {
          const cellBottom = element.closest('td')!.getBoundingClientRect().bottom;
          const textBottom = element.lastElementChild!.getBoundingClientRect().bottom;
          return cellBottom - textBottom - parseFloat(getComputedStyle(element).paddingBottom);
        });
        assert.ok(unusedHeight <= 1.5, `${context}: the reading row tracks its text height, extra height: ${unusedHeight}`);
        const wrapped = await read(task);
        assert.ok(wrapped.rows > 1, `${context}: the nested task wraps in the cell`);
        assert.deepEqual(wrapped.listMarkers, ['none', 'decimal', 'disc']);
        assert.deepEqual((await read(smallTask)).listMarkers, ['none', 'decimal']);
        const standalone = await read(rootTask);
        assert.ok(Math.abs(standalone.checkboxInset) < .5, `${context}: a standalone task starts at the cell content edge`);
        const mixed = await page.$eval(mixedList, list => ({
          gutter: parseFloat(getComputedStyle(list).paddingInlineStart),
          markers: [...list.children].map(item => getComputedStyle(item).listStyleType)
        }));
        assert.ok(mixed.gutter > 0, `${context}: a mixed list keeps room for ordinary markers`);
        assert.deepEqual(mixed.markers, ['disc', 'none']);
        for (const marker of [wrapped, await read(smallTask), standalone]) {
          assert.equal(marker.lineHeight, expected);
          assert.ok(marker.insideCell && Math.abs(marker.centerDelta) < .5, `${context}: checkbox centers on the first line`);
        }
        const first = await page.$eval(`${task} > div`, element => {
          const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
          const range = document.createRange();
          range.setStart(text, 0); range.setEnd(text, 1);
          const rect = range.getBoundingClientRect();
          return { x: rect.left + rect.width / 4, y: rect.top + rect.height / 2 };
        });
        await page.mouse.click(first.x, first.y);
        await page.waitForSelector(`${task} .meo-md-table-source-body`, { visible: true });
        const editing = await read(task);
        assert.deepEqual(editing.listMarkers, wrapped.listMarkers);
        assert.equal(editing.lineHeight, expected);
        assert.ok(Math.abs(editing.centerDelta) < .5 && Math.abs(editing.top - wrapped.top) < .5,
          `${context}: the checkbox retains its first-line position while editing`);
        if (font === 16 && process.env.MEO_TEST_SCREENSHOTS) {
          fs.mkdirSync(process.env.MEO_TEST_SCREENSHOTS, { recursive: true });
          await page.screenshot({ path: path.join(process.env.MEO_TEST_SCREENSHOTS, `table-typography-${label}.png`) });
        }
        await page.keyboard.press('Escape');
      }
      console.log(`Table marker alignment and line spacing passed (${label}, actual derived-work budget)`);
    }
  } finally {
    await page.evaluate(attributes => {
      (window as any).__tableCellEditor?.destroy();
      for (const [name, value] of attributes) {
        if (value === null) document.documentElement.removeAttribute(name);
        else document.documentElement.setAttribute(name, value);
      }
    }, originalAppearance);
    await layout.evaluate(element => element.remove());
    await layout.dispose();
  }
}

async function checkCellLineGeometry(page: import('puppeteer-core').Page) {
  const layout = await page.addStyleTag({ content: `
    #app { height: 400px; }
    #app .cm-editor { height: 100%; }
    .cm-editor .meo-md-html-table { width: 420px !important; table-layout: fixed !important; }
    .cm-editor .meo-md-html-table :is(th, td) { width: 210px !important; max-width: 210px !important; }
  ` });
  const markdown = 'before table\n'.repeat(30) + '\n| Test | Content |\n| --- | --- |\n'
    + `| First | **One**<br>[Two](https://example.test/${'long-path/'.repeat(13)})<br>**Three** |\n`
    + '| List | 1. **Prepare**<br>2. Review<br>   - **Nested**<br>3. Finish |\n'
    + '| Quote | > **Intro**<br>> > **Nested quote**<br>> Finish |\n\n'
    + 'after table\n'.repeat(20);
  const preview = (row: number) => `tbody tr:nth-child(${row}) td:nth-child(2) .meo-md-html-table-cell-preview`;
  const active = '.meo-md-table-active-source-line';
  const firstLine = `${preview(1)} .meo-md-html-table-cell-line:first-child strong`;
  const coords = (selector: string) => page.$eval(selector, element => {
    const node = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 1);
    const rect = range.getBoundingClientRect();
    return { left: rect.left, top: rect.top, x: Math.ceil(rect.left + 0.5), y: Math.round(rect.top + rect.height / 2) };
  });
  const settle = () => page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const click = async (selector: string) => {
    const { x, y } = await coords(selector);
    const hit = await page.$eval(selector, (element, point) => {
      const target = document.elementFromPoint(point.x, point.y);
      return { matches: element.contains(target), target: target?.className, point };
    }, { x, y });
    assert.ok(hit.matches, `click must hit the rendered ${selector}: ${JSON.stringify(hit)}`);
    await page.mouse.click(x, y);
    await settle();
  };
  try {
    await page.evaluate(text => {
      (window as any).__tableCellEditor?.destroy();
      (window as any).__tableCellEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
    }, markdown);
    await page.waitForSelector(`${preview(3)} blockquote`);
    const headingLine = markdown.split('\n').findIndex(line => line.startsWith('| Test |')) + 1;
    // Use the normal navigation owner so late editor measurement cannot
    // invalidate a scroll offset taken from the initial table DOM.
    await page.evaluate(line => (window as any).__tableCellEditor.scrollToLine(line, 'top'), headingLine - 3);
    await page.waitForFunction(selector => {
      const element = document.querySelector(selector);
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && element.contains(document.elementFromPoint(rect.left + 1, (rect.top + rect.bottom) / 2));
    }, {}, firstLine);
    await settle();
    const prior = await coords(firstLine);
    const middle = `${preview(1)} .meo-md-html-table-cell-line:nth-child(2) .meo-md-link`;
    await click(middle);
    assert.ok(await page.$(`${preview(1)} ${active}`));
    assert.ok(Math.abs((await coords(firstLine)).top - prior.top) < 1, 'expanding a wrapped source keeps the preceding line still');
    await click(`${preview(1)} .meo-md-html-table-cell-line:last-child strong`);
    assert.equal(await page.$eval(`${preview(1)} ${active}`, el => el.textContent), '**Three**');
    assert.ok(Math.abs((await coords(firstLine)).top - prior.top) < 1, 'same-cell handoff only reflows the changed source row');
    await click(middle);
    await click(`${preview(2)} ol > li:first-child strong`);
    assert.equal(await page.$eval(`${preview(2)} ${active}`, el => el.textContent), '1. **Prepare**<br>');
    assert.ok(Math.abs((await coords(firstLine)).top - prior.top) < 1, 'cross-cell handoff keeps the former cell at its viewport position');

    for (const [row, rendered] of [
      [2, 'ol > li:nth-child(2)'],
      [2, 'ul > li:first-child strong'],
      [3, 'blockquote blockquote strong']
    ] as const) {
      const reading = await coords(`${preview(row)} ${rendered}`);
      await click(`${preview(row)} ${rendered}`);
      const src = `${preview(row)} ${active}`;
      const editing = await coords(`${src} .meo-md-table-source-body`);
      assert.ok(Math.abs(editing.left - reading.left) < 1,
        `reading and source share the same body start for ${rendered}: ${reading.left} -> ${editing.left}`);
      const paint = await page.$eval(src, element => ({
        prefix: getComputedStyle(element.querySelector('.meo-md-table-source-prefix')!).visibility,
        input: getComputedStyle(element.closest('td')!.querySelector('textarea')!).color,
        raw: getComputedStyle(element.querySelector('.meo-md-table-source-body')!).color
      }));
      assert.equal(paint.prefix, 'hidden', 'the structural prefix is already painted by the rendered container');
      assert.equal(paint.input, 'rgba(0, 0, 0, 0)', 'the native selection owner does not paint a second copy');
      assert.notEqual(paint.raw, 'rgba(0, 0, 0, 0)', 'editable body text is visible');
      if (process.env.MEO_TEST_SCREENSHOTS) {
        const name = row === 3 ? 'table-quote-source-alignment.png' : 'table-list-source-alignment.png';
        await page.screenshot({ path: path.join(process.env.MEO_TEST_SCREENSHOTS, name) });
      }
    }
    console.log('table source line alignment and viewport handoff checks passed');
  } finally {
    await page.evaluate(() => (window as any).__tableCellEditor.destroy());
    await layout.evaluate(style => style.remove());
    await layout.dispose();
  }
}

async function checkCellSourcePointerGeometry(page: import('puppeteer-core').Page, large = false) {
  const cell = 'tbody tr:first-child td:nth-child(2)';
  const preview = `${cell} .meo-md-html-table-cell-preview`;
  const sourceLine = `${preview} .meo-md-table-active-source-line`;
  const caretSelector = `${sourceLine} .meo-md-table-source-caret`;
  const input = `${cell} textarea`;
  const source = '| Step | Content |\n| --- | --- |\n'
    + '| List | 1. First<BR />2. Second<br/>3. Third |\n'
    + '| Ordered | 8. First<BR />9. 第二项<br/>10. Third |\n'
    + '| Link | First<br>[Example](https://example.test/very/long/path/for/wrapping)<br>Last |'
    + (large ? '\n\n' + 'padding text\n'.repeat(8100) : '');
  assert.equal(assessLargeDocument(source).boundedEditorWork, large);
  await page.evaluate(text => {
    (window as any).__tableCellEditor?.destroy();
    const openedLinks: string[] = (window as any).__cellPointerLinks = [];
    (window as any).__tableCellEditor = (window as any).TableStabilityHarness.createEditor({
      parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {},
      onOpenLink(href: string) { openedLinks.push(href); }
    });
  }, source);
  await page.waitForFunction(large => {
    const app = window as any;
    return app.TableStabilityHarness.usesLargeDocumentDerivedWorkBudget(app.__tableCellEditor.view.state) === large;
  }, {}, large);
  const first = `${preview} li:first-child`;
  await page.waitForSelector(first, { visible: true });
  await page.click(first);
  assert(await page.$eval(`${sourceLine} .meo-md-table-source-break`, element => element.getBoundingClientRect().width > 0),
    'entering the logical line shows its break before the caret reaches the tag');
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowRight');
  const marker = await page.$eval(sourceLine, el => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent!.indexOf('<BR />');
      if (index < 0) continue;
      const range = document.createRange();
      const point = (offset: number) => {
        range.setStart(node, index + offset);
        range.setEnd(node, index + offset + 1);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + rect.width * 0.75, y: rect.top + rect.height / 2, right: rect.right };
      };
      const closing = point(5);
      const cellRight = el.closest('td')!.getBoundingClientRect().right;
      const blank = { x: Math.floor((closing.right + cellRight - 14) / 2), y: closing.y };
      const target = document.elementFromPoint(blank.x, blank.y);
      if (blank.x <= closing.right || target?.closest('td') !== el.closest('td')
          || target?.closest('.meo-md-html-table-column-resize-handle')) throw new Error('The blank click must hit the cell past the tag glyph');
      return { ...point(2), closing, blank };
    }
    throw new Error('the source row must display its original break tag');
  });
  await page.mouse.click(marker.x, marker.y);
  const caret = '1. First'.length;
  assert.equal(await page.$eval(input, textarea => textarea.selectionStart), caret + 3,
    'a click inside the displayed break tag places the caret inside the source');
  await page.mouse.click(marker.closing.x, marker.closing.y);
  assert.equal(await page.$eval(input, textarea => textarea.selectionStart), caret + '<BR />'.length,
    'the right side of the closing glyph still places the caret on the tag line');
  await page.mouse.click(marker.blank.x, marker.blank.y);
  assert.equal(await page.$eval(input, textarea => textarea.selectionStart), caret,
    'blank space after the displayed break has the same line-end caret');
  const assertCaretAtBodyEnd = async () => {
    const position = await page.$eval(sourceLine, el => {
      const body = el.querySelector('.meo-md-table-source-body')!;
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      const text = walker.nextNode()!;
      const range = document.createRange();
      range.setStart(text, text.textContent!.length);
      range.collapse(true);
      const textCaret = range.getBoundingClientRect();
      const caret = el.querySelector('.meo-md-table-source-caret')!;
      const overlay = caret.getBoundingClientRect();
      return {
        native: getComputedStyle(el.closest('td')!.querySelector('textarea')!).caretColor,
        x: overlay.left, y: overlay.top, width: overlay.width,
        textX: textCaret.left, textY: textCaret.top, shown: getComputedStyle(caret).display !== 'none'
      };
    });
    assert.equal(position.native, 'rgba(0, 0, 0, 0)');
    assert.equal(position.width, 1, 'the projected cell caret is one CSS pixel wide');
    assert.ok(position.shown && Math.abs(position.x - position.textX) < 1 && Math.abs(position.y - position.textY) < 1,
      `the visible caret uses the same line as the displayed text: ${JSON.stringify(position)}`);
  };
  await assertCaretAtBodyEnd();
  const sampleBlink = (phase: number) => page.$eval(caretSelector, (element, phase) => {
    const style = getComputedStyle(element);
    const blink = element.getAnimations().find(animation =>
      animation instanceof CSSAnimation && animation.animationName === style.animationName
    );
    if (blink?.effect) {
      blink.currentTime = Number(blink.effect.getTiming().duration) * phase;
    }
    return { opacity: style.opacity, running: blink?.playState === 'running' };
  }, phase);
  assert.equal((await sampleBlink(0.25)).opacity, '1', 'the focused caret is visible during the first half of its blink');
  assert.deepEqual(await sampleBlink(0.75), { opacity: '0', running: true }, 'the focused caret blinks off while idle');
  await page.$eval(input, element => element.dispatchEvent(new Event('selectionchange')));
  assert.equal(await page.$eval(caretSelector, element => getComputedStyle(element).opacity), '0',
    'an unchanged native selection does not restart the blink');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.$eval(caretSelector, element => getComputedStyle(element).opacity), '1',
    'moving the caret on the same line makes it visible again');
  await page.keyboard.press('ArrowRight');
  await assertCaretAtBodyEnd();

  for (const value of ['reduce', 'no-preference']) {
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value }]);
    assert.deepEqual(await sampleBlink(0.25), { opacity: '1', running: true },
      `the caret has a visible blink phase with motion preference ${value}`);
    assert.deepEqual(await sampleBlink(0.75), { opacity: '0', running: true },
      `the caret has a hidden blink phase with motion preference ${value}`);
  }
  await page.emulateMediaFeatures([]);
  await page.keyboard.down('Shift');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift');
  assert.equal(await page.$(caretSelector), null,
    'a text selection does not paint a blinking insertion caret');
  await page.keyboard.press('ArrowRight');
  await assertCaretAtBodyEnd();

  await page.keyboard.type('55');
  assert.equal(await page.$eval(input, textarea => textarea.value), '1. First55<BR />\n2. Second<br/>\n3. Third');
  await assertCaretAtBodyEnd();

  await page.keyboard.down('Control');
  await page.keyboard.press('Home');
  await page.keyboard.up('Control');
  await page.keyboard.press('ArrowRight');
  await page.waitForSelector(`${sourceLine}.is-prefix-source`);
  const prefixStart = await page.$eval(`${sourceLine} .meo-md-table-source-prefix`, prefix => prefix.getBoundingClientRect().left);
  await page.keyboard.type('55555');
  const bounds = await page.$eval(sourceLine, el => {
    const prefix = el.querySelector('.meo-md-table-source-prefix')!;
    const cell = el.closest('td')!.getBoundingClientRect();
    const marker = prefix.getBoundingClientRect();
    return { prefixLeft: marker.left, prefixRight: marker.right, cellLeft: cell.left, cellRight: cell.right };
  });
  assert.ok(bounds.prefixLeft >= bounds.cellLeft && bounds.prefixRight <= bounds.cellRight,
    `typing in a raw list marker must stay inside the cell: ${JSON.stringify(bounds)}`);
  assert.ok(Math.abs(bounds.prefixLeft - prefixStart) < 1, 'a growing list marker extends to the right from a stable start');
  if (process.env.MEO_TEST_SCREENSHOTS) {
    fs.mkdirSync(process.env.MEO_TEST_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.MEO_TEST_SCREENSHOTS, 'table-editing-numbered-prefix.png') });
  }

  const orderedCell = 'tbody tr:nth-child(2) td:nth-child(2)';
  const targetItem = await page.$eval(`${orderedCell} ol li:nth-child(2)`, element => {
    const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 1);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width / 8, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(targetItem.x, targetItem.y);
  assert.equal(await page.$eval(`${orderedCell} textarea`, textarea => textarea.selectionStart),
    '8. First<BR />\n9. '.length, 'clicking the first character lands after the hidden marker');
  await page.keyboard.down('Shift');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Shift');
  assert.equal(await page.$eval(`${orderedCell} textarea`, textarea => textarea.value),
    '8. First<BR />\n9. <br>\n10. 第二项<br/>\n11. Third');
  const session = await page.createCDPSession();
  try {
    await session.send('Input.imeSetComposition', { text: 'xin', selectionStart: 3, selectionEnd: 3 });
    const preedit = await page.$eval(`${orderedCell} textarea`, textarea => {
      const input = textarea.getBoundingClientRect();
      const cell = textarea.closest('td')!.getBoundingClientRect();
      const caret = textarea.parentElement!.querySelector('.meo-md-table-source-caret');
      return {
        value: textarea.value,
        withinCell: input.left >= cell.left && input.right <= cell.right + 0.5,
        projectedCaret: !!caret && getComputedStyle(caret).display !== 'none',
        nativeCaret: getComputedStyle(textarea).caretColor
      };
    });
    assert.match(preedit.value, /\n9\. xin<br>/, 'IME composes before the row break');
    assert.equal(preedit.withinCell, true, 'the native IME surface also stays within the numbered cell');
    assert.equal(preedit.projectedCaret, false, 'composition leaves caret painting to the native input');
    assert.notEqual(preedit.nativeCaret, 'rgba(0, 0, 0, 0)');
    await session.send('Input.insertText', { text: '新' });
    assert.equal(await page.$eval(`${orderedCell} textarea`, textarea => textarea.value),
      '8. First<BR />\n9. 新<br>\n10. 第二项<br/>\n11. Third');
  } finally {
    await session.detach();
  }

  const linkedCell = 'tbody tr:nth-child(3) td:nth-child(2)';
  await page.click(`${linkedCell} .meo-md-link`);
  const link = await page.$eval(`${linkedCell} .meo-md-table-inline-source`, el => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text && !text.textContent?.includes('Example')) text = walker.nextNode();
    if (!text) throw new Error('Missing revealed link label');
    const range = document.createRange();
    range.setStart(text, 2);
    range.setEnd(text, 3);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.keyboard.down('Control');
  await page.mouse.click(link.x, link.y);
  await page.keyboard.up('Control');
  assert.deepEqual(await page.evaluate(() => (window as any).__cellPointerLinks),
    ['https://example.test/very/long/path/for/wrapping'], 'modifier clicks use the characters actually shown');
  await page.evaluate(() => (window as any).__tableCellEditor.destroy());
  console.log('table line-end pointer and source bounds checks passed');
}

async function checkCellEditingAudit(page: import('puppeteer-core').Page) {
  const cell = 'tbody tr:first-child td';
  const input = `${cell} textarea`;
  const activeLine = `${cell} .meo-md-table-active-source-line`;
  const fixedWidth = await page.addStyleTag({ content: `
    .cm-editor .meo-md-html-table { width: 118px !important; table-layout: fixed !important; }
    .cm-editor .meo-md-html-table :is(th, td) { width: 118px !important; }
  ` });
  const open = async (content: string, alignment = '---', large = false) => {
    const text = `before\n\n| A |\n| ${alignment} |\n| ${content} |\n| next |\n\nafter`
      + (large ? '\n\npadding\n'.repeat(8100) : '');
    await page.evaluate(text => {
      const app = window as any;
      app.__tableCellEditor?.destroy();
      app.__tableCellEditor = app.TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
    }, text);
    await page.waitForSelector(input);
    return text;
  };
  const select = (from: number, to = from, direction: 'none' | 'backward' = 'none') => page.$eval(input, (textarea, from, to, direction) => {
    textarea.focus();
    textarea.setSelectionRange(from, to, direction);
    return new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, from, to, direction);
  const press = async (key: import('puppeteer-core').KeyInput, modifier?: 'Control' | 'Shift') => {
    if (modifier) await page.keyboard.down(modifier);
    await page.keyboard.press(key);
    if (modifier) await page.keyboard.up(modifier);
  };
  const caret = () => page.$eval(input, textarea => ({
    from: textarea.selectionStart, to: textarea.selectionEnd, value: textarea.value
  }));
  const selection = async () => {
    const { from, to } = await caret();
    return { from, to };
  };
  const lineText = () => page.$eval(activeLine, element => element.textContent);
  const caretTop = () => page.$eval(`${activeLine} .meo-md-table-source-caret`, element => parseFloat(getComputedStyle(element).top));
  try {
    const marked = '1. First<br>133333333. Second item has quite long text<br>3. Third';
    const orderedSource = await open(marked);
    const initial = marked.indexOf('Second') + 5;
    await select(initial);
    await press('ArrowUp');
    assert.equal(await lineText(), '1. First<br>', 'Up from the first painted row crosses a hidden, wider list marker');
    await press('ArrowDown');
    const firstPaintedRow = await caretTop();
    await press('ArrowDown');
    assert.equal(await lineText(), '133333333. Second item has quite long text<br>');
    assert.ok(await caretTop() > firstPaintedRow + 10, 'Down advances one painted row within the wrapped item');
    await press('ArrowUp');
    assert.ok(Math.abs(await caretTop() - firstPaintedRow) < 1, 'Up returns to the first painted row');

    const markerColor = (item: number) => page.$eval(`${cell} ol li:nth-child(${item})`,
      element => getComputedStyle(element, '::marker').color);
    const readingMarker = await markerColor(1);
    assert.notEqual(readingMarker, 'rgba(0, 0, 0, 0)');
    const markerStart = marked.indexOf('133333333') + 1;
    await select(markerStart);
    assert.equal(await markerColor(2), readingMarker, 'the caret immediately before a list marker keeps it rendered');
    const edge = await page.$eval(activeLine, element => ({
      caret: element.querySelector('.meo-md-table-source-caret')!.getBoundingClientRect().left,
      body: element.querySelector('.meo-md-table-source-body')!.getBoundingClientRect().left,
      cell: element.closest('td')!.getBoundingClientRect().left
    }));
    assert.ok(edge.caret >= edge.cell && edge.caret < edge.body, 'the caret before the marker appears in its gutter');
    await press('ArrowRight');
    assert.equal(await markerColor(2), 'rgba(0, 0, 0, 0)', 'editing raw list syntax hides the generated marker');
    assert.equal((await caret()).from, markerStart + 1);
    await press('ArrowLeft');
    assert.equal(await markerColor(2), readingMarker, 'moving back to the boundary restores the rendered marker');
    await select(markerStart, markerStart + '133333333.'.length);
    assert.equal(await markerColor(2), 'rgba(0, 0, 0, 0)', 'selecting just the marker reveals its source');
    await select(markerStart, initial);
    assert.equal(await markerColor(2), readingMarker, 'a selection into the item text keeps the rendered marker');
    await press('Escape');
    const label = await page.$eval(`${cell} ol li:nth-child(2)`, element => {
      const firstText = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
      const range = document.createRange();
      range.setStart(firstText, 2);
      range.setEnd(firstText, 3);
      const glyph = range.getBoundingClientRect();
      return { x: glyph.left + glyph.width / 4, y: glyph.top + glyph.height / 2 };
    });
    await page.mouse.click(label.x, label.y);
    assert.equal(await markerColor(2), readingMarker, 'clicking item text keeps the rendered marker');
    assert.ok((await caret()).from > markerStart + '133333333.'.length);
    assert.equal(await page.evaluate(() => (window as any).__tableCellEditor.getText()), orderedSource);

    await select(initial);
    const composition = await page.createCDPSession();
    try {
      const preedit = 'zhongwenchangshuruzhongwen';
      await composition.send('Input.imeSetComposition', { text: preedit, selectionStart: preedit.length, selectionEnd: preedit.length });
      assert.ok((await caret()).value.includes(preedit));
      assert.equal(await markerColor(2), 'rgba(0, 0, 0, 0)', 'native preedit does not paint a second list marker');
      assert.equal(await markerColor(1), readingMarker, 'preedit preserves the neighboring rendered marker');
      await composition.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
      assert.ok(!(await caret()).value.includes(preedit), 'cancelled preedit leaves no text');
      assert.equal(await page.evaluate(() => (window as any).__tableCellEditor.getText()), orderedSource);
      assert.equal(await markerColor(2), readingMarker, 'cancelling preedit restores the rendered marker');
    } finally {
      await composition.detach();
    }

    const nested = '1. Parent<br>   8. First nested<br>   133333333. Second nested<br>2. Next';
    const nestedSource = await open(nested);
    const nestedMarkerStart = nested.indexOf('133333333') + 2;
    await select(nestedMarkerStart - 1);
    assert.equal(await page.$(`${activeLine}.is-prefix-source`), null, 'list indentation keeps the rendered marker');
    await press('ArrowRight');
    assert.equal(await page.$(`${activeLine}.is-prefix-source`), null, 'the nested marker still renders at its leading edge');
    await press('ArrowRight');
    assert.ok(await page.$(`${activeLine}.is-prefix-source`), 'moving into the nested marker reveals its source');
    assert.equal(await page.evaluate(() => (window as any).__tableCellEditor.getText()), nestedSource);

    const quoted = '> 1. First quote<br>> 133333333. Second quote<br>> 3. Third quote';
    await open(quoted);
    const quotedMarkerStart = quoted.indexOf('133333333') + 1;
    await select(quotedMarkerStart);
    assert.equal(await page.$(`${activeLine}.is-prefix-source`), null, 'a quote prefix does not expand the list marker at its edge');
    await press('ArrowRight');
    assert.ok(await page.$(`${activeLine}.is-prefix-source`), 'the marker in a quote opens when the caret enters its digits');

    await open('First<BR />Second<br/>Third', '---:');
    await select(2);
    await press('End');
    assert.equal((await caret()).from, 5, 'End stops at the visible body before a break');
    await press('ArrowDown', 'Shift');
    assert.equal((await caret()).from, 5, 'Shift+Down keeps the anchor in the previous line');
    assert.equal(await lineText(), 'Second<br/>');
    assert.ok((await caret()).to <= 'First<BR />\nSecond'.length, 'the selection head never lands in the break tag');
    await press('ArrowUp', 'Shift');
    assert.deepEqual(await selection(), { from: 5, to: 5 });

    await open('First<br>aaaaaaa bbbbbbb ccccccc ddddddd<br>Last');
    await select(22);
    const wrappedTop = await caretTop();
    await press('Home');
    assert.deepEqual(await selection(), { from: 18, to: 18 }, 'Home stops before the first glyph of a soft wrap');
    assert.ok(Math.abs(await caretTop() - wrappedTop) < 1, 'the caret stays on the wrapped row at its first glyph');
    const firstWrappedGlyph = await page.$eval(`${activeLine} .meo-md-table-source-body`, element => {
      const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
      const range = document.createRange();
      range.setStart(text, 8);
      range.setEnd(text, 9);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + 1, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(firstWrappedGlyph.x, firstWrappedGlyph.y);
    assert.deepEqual(await selection(), { from: 18, to: 18 });
    assert.ok(Math.abs(await caretTop() - wrappedTop) < 1, 'a click before the first glyph of a wrap uses its painted row');
    await press('End');
    assert.equal((await caret()).from, 26, 'End uses the same insertion boundary at the end of the wrapped row');
    assert.ok(Math.abs(await caretTop() - wrappedTop) < 1);

    const cutSource = await open('First<BR />Second<br />Third');
    await select(2, 17);
    await press('x', 'Control');
    assert.equal((await caret()).value, 'Fid<br />\nThird', 'cut removes the cross-line range exactly once');
    await page.evaluate(() => {
      const target = document.createElement('textarea');
      target.id = 'table-cell-clipboard-audit';
      document.body.appendChild(target);
      target.focus();
    });
    try {
      await press('v', 'Control');
      assert.equal(await page.$eval('#table-cell-clipboard-audit', target => (target as HTMLTextAreaElement).value),
        'rst<BR />Secon', 'the native clipboard carries the same Markdown for Cut and Copy');
      await page.waitForFunction(() => (window as any).__tableCellEditor.getText().includes('Fid<br />Third'));
      assert.equal(await page.evaluate(() => (window as any).__tableCellEditor.undo()), true);
      assert.equal(await page.evaluate(() => (window as any).__tableCellEditor.getText()), cutSource);

      const pasteSource = await open('Top<BR />Bottom');
      await page.$eval('#table-cell-clipboard-audit', (target: HTMLTextAreaElement) => {
        target.value = '中😀\nnext';
        target.focus();
        target.select();
      });
      await press('c', 'Control');
      await select(3);
      await press('v', 'Control');
      assert.equal((await caret()).value, 'Top中😀<br>\nnext<BR />\nBottom');
      assert.equal((await caret()).from, 'Top中😀<br>\nnext'.length);
      assert.equal(await lineText(), 'next<BR />', 'pasting multiple lines lands at the end of the inserted content');
      await press('Escape');
      await page.waitForFunction(text => (window as any).__tableCellEditor.getText() === text, {},
        pasteSource.replace('Top<BR />', 'Top中😀<br>next<BR />'));
      assert.equal(await page.evaluate(() => (window as any).__tableCellEditor.undo()), true);
      assert.equal(await page.evaluate(() => (window as any).__tableCellEditor.getText()), pasteSource);
    } finally {
      await page.$eval('#table-cell-clipboard-audit', target => target.remove());
    }

    const blank = 'Top<BR /><br/>Bottom<br>';
    await open(blank, ':---:');
    for (const [row, offset, text] of [[2, 10, '<br/>'], [4, 27, '']] as const) {
      const selector = `${cell} .meo-md-html-table-cell-line:nth-child(${row})`;
      const point = await page.$eval(selector, element => {
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      await page.mouse.click(point.x, point.y);
      assert.equal(await lineText(), text, 'empty rendered rows remain editable targets');
      assert.equal((await caret()).from, offset, 'the empty line click maps to its source boundary');
      await press('Escape');
    }

    const styled = '**Bold** and *italic*<br>`<br>` and ~~gone~~<BR />'
      + '8. Ordered<br>   - [x] Nested<br>> Quote<br>> > **Deep**<br>[Link](https://example.test/)';
    await open(styled);
    const preview = `${cell} .meo-md-html-table-cell-preview`;
    const snapshot = () => page.$eval(preview, element => ({
      strong: [...element.querySelectorAll('strong')].map(node => node.textContent),
      italic: element.querySelector('em')?.textContent,
      code: element.querySelector('code')?.textContent,
      orderedStart: element.querySelector('ol')?.start,
      nestedTask: element.querySelector<HTMLInputElement>('ol li ul li input[type=checkbox]')?.checked,
      nestedQuote: element.querySelector('blockquote blockquote strong')?.textContent,
      links: element.querySelectorAll('.meo-md-link').length
    }));
    assert.deepEqual(await snapshot(), {
      strong: ['Bold', 'Deep'], italic: 'italic', code: '<br>', orderedStart: 8,
      nestedTask: true, nestedQuote: 'Deep', links: 1
    }, 'rendered inline styles, literal break in code, and nested blocks share a cell');
    const taskOffset = await page.$eval(preview, element => {
      const checkbox = element.querySelector('ol li ul li input[type=checkbox]')!;
      const text = document.createTreeWalker(checkbox.closest('li')!, NodeFilter.SHOW_TEXT).nextNode()!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 1);
      const label = range.getBoundingClientRect();
      const marker = checkbox.getBoundingClientRect();
      return Math.abs((label.top + label.bottom - marker.top - marker.bottom) / 2);
    });
    assert.ok(taskOffset < 8, `the checkbox stays on the first painted line of a narrow task: ${taskOffset}px`);
    await select(styled.indexOf('Ordered') + 2 + 2);
    assert.equal(await lineText(), '8. Ordered<br>');
    assert.deepEqual(await snapshot(), {
      strong: ['Bold', 'Deep'], italic: 'italic', code: '<br>', orderedStart: 8,
      nestedTask: true, nestedQuote: 'Deep', links: 1
    }, 'only the selected logical row switches to source');
    await press('ArrowDown');
    assert.equal(await lineText(), '   - [x] Nested<br>');
    for (let step = 0; step < 3; step++) {
      const previousTop = await caretTop();
      await press('ArrowDown');
      if (await lineText() !== '   - [x] Nested<br>') break;
      assert.ok(await caretTop() > previousTop + 10, 'Down advances inside the wrapped nested task');
    }
    assert.equal(await lineText(), '> Quote<br>', 'leaving the task enters the quote');
    await press('ArrowDown');
    assert.equal(await lineText(), '> > **Deep**<br>');
    const trailingSpace = await page.$eval(preview, element => {
      const link = element.querySelector('.meo-md-link')!;
      return element.closest('td')!.getBoundingClientRect().bottom - link.getBoundingClientRect().bottom;
    });
    assert.ok(trailingSpace < 18, `only the rendered rows and the active source size the cell: ${trailingSpace}px trailing space`);

    await select(styled.indexOf('> > **Deep**') + 6);
    assert.ok(await page.$(`${activeLine}.is-prefix-source`));
    const quoteBackground = await page.$eval(`${activeLine} .meo-md-table-source-text`, element => ({
      line: getComputedStyle(element).backgroundColor,
      editor: getComputedStyle(element.closest('.cm-editor')!).backgroundColor
    }));
    assert.equal(quoteBackground.line, quoteBackground.editor, 'raw quote markers cover the bars only on the active line');

    if (process.env.MEO_TEST_SCREENSHOTS) {
      fs.mkdirSync(process.env.MEO_TEST_SCREENSHOTS, { recursive: true });
      const table = (await page.$('.meo-md-html-table:not(.meo-md-html-table-sticky-table)'))!;
      await table.screenshot({ path: path.join(process.env.MEO_TEST_SCREENSHOTS, 'table-mixed-styles-quote-prefix.png') });
      await select(styled.indexOf('Deep') + 7);
      await table.screenshot({ path: path.join(process.env.MEO_TEST_SCREENSHOTS, 'table-mixed-styles-active.png') });
      await press('Escape');
      await table.screenshot({ path: path.join(process.env.MEO_TEST_SCREENSHOTS, 'table-mixed-styles-reading.png') });
    }

    for (const large of [false, true]) {
      const content = 'Top<br>`a<br>XY`<BR />Bottom';
      const source = await open(content, '---', large);
      await page.waitForFunction(expected => {
        const app = window as any;
        return app.TableStabilityHarness.usesLargeDocumentDerivedWorkBudget(app.__tableCellEditor.view.state) === expected;
      }, {}, large);
      const glyph = await page.$eval(`${preview} code`, element => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let text = walker.nextNode();
        while (text && !text.textContent?.includes('X')) text = walker.nextNode();
        if (!text) throw new Error('The rendered code must contain the target glyph');
        const index = text.textContent!.indexOf('X');
        const range = document.createRange();
        range.setStart(text, index);
        range.setEnd(text, index + 1);
        const rect = range.getBoundingClientRect();
        return { x: Math.ceil(rect.left + rect.width / 5), y: Math.floor(rect.top + rect.height / 2) };
      });
      await page.mouse.click(glyph.x, glyph.y);
      const expected = content.indexOf('X') + 1; // Only the first real break adds a display newline.
      assert.deepEqual(await selection(), { from: expected, to: expected }, `optimized=${large}: a literal <br> inside code adds no caret offset`);
      await page.keyboard.type('Z');
      await press('Escape');
      assert.equal(await page.evaluate(() => (window as any).__tableCellEditor.getText()), source.replace('XY', 'ZXY'));

      await open('Lead<br>$a+b+c+d$', '---', large);
      await select(1, 'Lead<br>\n$a'.length, 'backward');
      assert.equal(await lineText(), 'Lead<br>');
      const coveredMath = await page.$eval(`${preview} .katex-html`, math => {
        const documentRange = document.createRange();
        documentRange.selectNodeContents(math);
        return [...CSS.highlights.get('meo-table-cell-selection') ?? []]
          .filter((range): range is Range => range instanceof Range && range.intersectsNode(math))
          .map(range => range.compareBoundaryPoints(Range.START_TO_START, documentRange) <= 0
            && range.compareBoundaryPoints(Range.END_TO_END, documentRange) >= 0);
      });
      assert.deepEqual(coveredMath, [true], `optimized=${large}: a selection overlapping rendered math highlights the whole formula exactly once`);
    }
  } finally {
    await fixedWidth.evaluate(style => style.remove());
  }
}

async function checkCellKeyboardViewport(page: import('puppeteer-core').Page) {
  const layout = await page.addStyleTag({ content: `
    #app { height: 330px; }
    #app .cm-editor { height: 100%; }
    .cm-editor .meo-md-html-table { width: calc(2 * var(--test-cell-width, 195px)) !important; table-layout: fixed !important; }
    .cm-editor .meo-md-html-table :is(th, td) {
      width: var(--test-cell-width, 195px) !important; max-width: var(--test-cell-width, 195px) !important;
    }
  ` });
  const cell = (row: number) => `tbody tr:nth-child(${row}) td:last-child`;
  const settle = () => page.evaluate(() => new Promise<void>(resolve => {
    let frames = 8;
    const next = () => --frames ? requestAnimationFrame(next) : resolve();
    requestAnimationFrame(next);
  }));
  const open = async (rows: string[]) => {
    const text = 'Before\n'.repeat(18) + '\n| Header | Target |\n| --- | --- |\n'
      + rows.join('\n') + '\n\n' + 'After\n'.repeat(28);
    await page.evaluate(text => {
      const app = window as any;
      app.__tableCellEditor?.destroy();
      app.__tableCellEditor = app.TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
      const { view } = app.__tableCellEditor;
      view.dispatch({ effects: view.constructor.scrollIntoView(view.state.doc.line(20).from, { y: 'center' }) });
    }, text);
    await page.waitForSelector(`${cell(1)} textarea`);
    return text;
  };
  const focus = (row: number, index: number) => page.$eval(`${cell(row)} textarea`, (input, index) => {
    input.focus({ preventScroll: true });
    input.setSelectionRange(index, index);
  }, index);
  const position = async (row: number, y: number, edge: 'top' | 'bottom' = 'top') => {
    await settle();
    const point = await page.$eval(cell(row), (element, y, edge) => {
      const scroller = element.closest<HTMLElement>('.cm-scroller')!;
      const viewport = scroller.getBoundingClientRect();
      return { x: viewport.right - 35, y: viewport.top + viewport.height / 2,
        delta: Math.round(element.getBoundingClientRect()[edge] - viewport.top - y) };
    }, y, edge);
    // A wheel carries new reading intent and supersedes the previous fixture reveal.
    if (point.delta) {
      await page.mouse.move(point.x, point.y);
      await page.mouse.wheel({ deltaY: point.delta });
    }
    await settle();
    const actual = await page.$eval(cell(row), (element, edge) => element.getBoundingClientRect()[edge]
      - element.closest('.cm-scroller')!.getBoundingClientRect().top, edge);
    assert.ok(Math.abs(actual - y) < 1, `Row ${row} ${edge} must start at ${y}px, got ${actual}px`);
  };
  const state = () => page.evaluate(() => {
    const view = (window as any).__tableCellEditor.view;
    const scroller = view.scrollDOM as HTMLElement;
    const input = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null;
    const cell = input?.closest('td, th');
    const caret = cell?.querySelector('.meo-md-table-source-caret')?.getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    return {
      scroll: scroller.scrollTop, tableTop: scroller.querySelector('table')!.getBoundingClientRect().top,
      row: input?.dataset.tableRow, offset: input?.selectionStart, line: view.state.doc.lineAt(view.state.selection.main.head).number,
      caret: caret ? { top: caret.top, bottom: caret.bottom } : null,
      viewport: { top: viewport.top, bottom: viewport.bottom },
      cellBottom: cell?.getBoundingClientRect().bottom ?? 0
    };
  });
  const press = async (key: import('puppeteer-core').KeyInput) => {
    await page.evaluate(() => {
      const app = window as any;
      const scroller = app.__tableCellEditor.view.scrollDOM as HTMLElement;
      const frames: number[] = app.__tableKeyboardFrames = [];
      const sample = () => {
        if (app.__tableKeyboardFrames !== frames) return;
        frames.push(scroller.scrollTop);
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.keyboard.press(key);
    await settle();
    const after = await state();
    const frames = await page.evaluate(() => {
      const app = window as any;
      const frames = app.__tableKeyboardFrames as number[];
      delete app.__tableKeyboardFrames;
      return frames;
    });
    return { ...after, frames };
  };
  const stays = (before: { scroll: number; tableTop: number }, after: Awaited<ReturnType<typeof press>>, label: string) => {
    assert.ok(after.frames.length >= 8 && after.frames.every(scroll => Math.abs(scroll - before.scroll) < 1)
      && Math.abs(after.scroll - before.scroll) < 1 && Math.abs(after.tableTop - before.tableTop) < 1,
      `${label}: ${JSON.stringify({ before, after })}`);
  };
  try {
    const linked = `**First**<br>[Second](https://example.test/${'abcdefghijk/'.repeat(10)})<br>**Third**`;
    await open([`| Link | ${linked} |`, '| Below | More |']);
    await focus(1, 3);
    await position(1, 95);
    const onFirst = await state();
    const onLink = await press('ArrowDown');
    assert.ok(onLink.caret && onFirst.caret && onLink.cellBottom < onLink.viewport.bottom
      && onLink.caret.top > onLink.viewport.top && onLink.caret.bottom < onLink.viewport.bottom);
    stays(onFirst, onLink, 'switching to a wrapped source with the whole cell visible');
    assert.ok(onLink.caret.top > onFirst.caret.top + 10, 'Down moves the painted caret within the fixed viewport');
    stays(onLink, await press('ArrowUp'), 'collapsing the wrapped source on the way back');

    const wrapped = '第一段<br>aaaaaaa bbbbbbb ccccccc ddddddd eeeeeee fffffff<br>第三段';
    for (const width of [195, 131]) {
      await page.$eval('#app', (element, width) => element.style.setProperty('--test-cell-width', `${width}px`), width);
      const exactSource = await open([`| 自动折行 | ${wrapped} |`, '| Next | Done |']);
      await focus(1, 1);
      await position(1, 115);
      const origin = await state();
      const wrapFirst = await press('ArrowDown');
      const wrapSecond = await press('ArrowDown');
      assert.ok(wrapFirst.caret && wrapSecond.caret && wrapSecond.caret.top > wrapFirst.caret.top + 10,
        `the original example visits consecutive painted rows at width ${width}`);
      stays(origin, wrapFirst, 'entering the wrapped row');
      stays(origin, wrapSecond, 'moving within the wrapped row');
      for (const key of ['Home', 'End', 'ArrowRight', 'ArrowLeft', 'ArrowUp'] as const) {
        stays(origin, await press(key), `${key} in the original wrapped text at width ${width}`);
      }
      assert.equal(await page.evaluate(() => (window as any).__tableCellEditor.getText()), exactSource);
    }
    await page.$eval('#app', element => element.style.removeProperty('--test-cell-width'));

    const tall = `Start<br>${'line<br>'.repeat(19)}Last`;
    await open(['| First | Before |', `| ${tall} | ${tall} |`]);
    await focus(1, 2);
    await position(2, 130);
    const beforeEntry = await state();
    assert.equal(beforeEntry.row, '1');
    assert.ok(beforeEntry.cellBottom > beforeEntry.viewport.top && beforeEntry.cellBottom < beforeEntry.viewport.bottom);
    const entry = await press('ArrowDown');
    assert.equal(entry.row, '2');
    assert.ok(entry.caret && entry.caret.bottom < entry.viewport.bottom && entry.cellBottom > entry.viewport.bottom);
    stays(beforeEntry, entry, 'the caret is visible even though the target cell extends below the viewport');
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    await settle();
    const atEnd = await state();
    assert.ok(atEnd.caret && atEnd.caret.bottom <= atEnd.viewport.bottom + 1 && atEnd.scroll > entry.scroll,
      'moving to the hidden end of a cell reveals the actual caret');

    await position(2, 230, 'bottom');
    const beforeExit = await state();
    const body = await press('ArrowDown');
    assert.equal(body.row, undefined, 'Down hands off to the body after the table');
    stays(beforeExit, body, 'leaving a visible caret for visible prose');
    const reentry = await press('ArrowUp');
    assert.equal(reentry.row, '2', 'Up returns from prose to the last table cell');
    assert.ok(reentry.caret && reentry.caret.top > reentry.viewport.top && reentry.caret.bottom < reentry.viewport.bottom);
    stays(body, reentry, 'returning from prose to a visible caret in a tall cell');

    const nativeWrap = 'abcdefghijk '.repeat(90) + 'Tail';
    await open(['| First | Before |', `| Native wrap | ${nativeWrap} |`]);
    await focus(2, 2);
    // Set the starting viewport after the focused row's layout has settled.
    await settle();
    await position(2, 125);
    const beforeSelection = await state();
    assert.ok(beforeSelection.cellBottom > beforeSelection.viewport.bottom + 1,
      'the native selection fixture starts with the end of the wrapped cell out of view');
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('End');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await settle();
    const selected = await state();
    const range = await page.$eval(`${cell(2)} textarea`, input => [input.selectionStart, input.selectionEnd, input.selectionDirection]);
    assert.deepEqual(range, [2, nativeWrap.length, 'forward']);
    assert.ok(selected.scroll > beforeSelection.scroll && selected.cellBottom <= selected.viewport.bottom + 1,
      'extending a wrapped native selection reveals its moving end');
    console.log('table keyboard caret and viewport checks passed');
  } finally {
    await page.$eval('#app', element => element.style.removeProperty('--test-cell-width'));
    await layout.evaluate(element => element.remove());
    await layout.dispose();
  }
}

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-table-stability-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 500 });
    await page.setContent('<!doctype html><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({ content: `
      :root {
        --meo-background: #24292e;
        --meo-foreground: #e6edf3;
        --meo-caret: #e6edf3;
        --meo-semantic-tableBorder: #474b50;
        --meo-semantic-tableSelectionBorder: #79b8ff;
        --meo-semantic-blockquoteForeground: #b1bac4;
        --meo-semantic-taskCheckboxDoneBackground: #57606a;
        --meo-semantic-taskCheckboxDoneBorder: #57606a;
        --meo-semantic-taskCheckboxDoneCheck: #e6edf3;
        --meo-ui-text-emphasis-content: #79b8ff;
      }
    ` });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    if (process.argv.includes('--typography-only')) {
      await checkCellTypography(page);
      return;
    }
    if (process.argv.includes('--keyboard-viewport-only')) {
      await checkCellKeyboardViewport(page);
      return;
    }
    if (process.argv.includes('--editing-audit-only')) {
      await checkCellEditingAudit(page);
      return;
    }
    if (process.argv.includes('--source-pointer-geometry-only')) {
      await checkCellSourcePointerGeometry(page);
      await checkCellSourcePointerGeometry(page, true);
      return;
    }
    if (process.argv.includes('--line-geometry-only')) {
      await checkCellLineGeometry(page);
      return;
    }
    if (process.argv.includes('--height-only')) {
      await checkProjectedCellHeight(page);
      await checkCellHeightTransitions(page);
      await checkCellHeightLayoutChanges(page, 'native');
      await checkCellHeightFallback(page);
      return;
    }
    if (process.argv.includes('--projected-height-only')) {
      await checkProjectedCellHeight(page);
      return;
    }
    if (process.argv.some(arg => ['--resize-height-only', '--move-height-only'].includes(arg))) {
      await checkCellHeightLayoutChanges(page, 'native');
      return;
    }
    if (process.argv.includes('--line-presentation-only')) {
      await checkCellLinePresentation(page);
      await checkSingleLineCellPresentation(page);
      return;
    }
    if (process.argv.includes('--structure-editing-only')) {
      await checkCellEditingKeys(page, 'structure');
      return;
    }
    await checkCellEditingKeys(page, 'break-deletion');
    if (process.argv.includes('--break-deletion-only')) return;
    await checkCellEditingKeys(page, 'structure');
    await checkCellLinePresentation(page);
    await checkSingleLineCellPresentation(page);
    await checkCellLineGeometry(page);
    await checkCellSourcePointerGeometry(page);
    await checkCellEditingAudit(page);
    await checkCellKeyboardViewport(page);
    await checkCellEntryRegressions(page);
    if (process.argv.includes('--entry-regressions-only') || process.argv.includes('--rapid-input-only') || process.argv.includes('--entry-drag-only')) return;
    await checkCellTypography(page);
    await checkProjectedCellHeight(page);
    await checkCellHeightTransitions(page);
    await checkCellHeightLayoutChanges(page, 'native');
    await checkCellHeightFallback(page);
    await page.addStyleTag({ content: '.cm-editor .meo-md-html-table { width: 240px !important; table-layout: fixed !important; } .cm-editor .meo-md-html-table :is(th, td) { width: 120px !important; max-width: 120px !important; }' });
    await page.evaluate((text) => {
      (window as any).__tableCellEditor?.destroy();
      (window as any).__tableCellEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
    }, source);
    await waitForTable(page);

    const first = 'tbody tr:first-child td:first-child textarea';
    const second = 'tbody tr:first-child td:nth-child(2) textarea';
    const last = 'tbody tr:nth-child(2) td:nth-child(2) textarea';
    const firstPreview = 'tbody tr:first-child td:first-child .meo-md-html-table-cell-preview';
    const secondPreview = 'tbody tr:first-child td:nth-child(2) .meo-md-html-table-cell-preview';

    await page.evaluate((selector) => {
      const preview = document.querySelector<HTMLElement>(selector)!;
      const rect = preview.getBoundingClientRect();
      preview.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 1,
        clientX: rect.left + 8,
        clientY: rect.top + 8
      }));
      window.dispatchEvent(new Event('blur'));
    }, firstPreview);
    await page.click(secondPreview);
    const recoveredEntry = await page.evaluate(() => {
      const active = document.activeElement as HTMLTextAreaElement | null;
      return {
        tag: active?.tagName ?? '',
        row: active?.dataset.tableRow,
        col: active?.dataset.tableCol,
        editing: active?.parentElement?.classList.contains('is-editing') ?? false
      };
    });
    if (
      recoveredEntry.tag !== 'TEXTAREA' ||
      recoveredEntry.row !== '1' ||
      recoveredEntry.col !== '1' ||
      !recoveredEntry.editing
    ) {
      throw new Error(`Interrupted pointer blocked later table entry: ${JSON.stringify(recoveredEntry)}`);
    }
    await page.keyboard.press('Escape');

    const wrappedMetrics = await page.evaluate((selector) => {
      const input = document.querySelector<HTMLTextAreaElement>(selector)!;
      const rect = input.getBoundingClientRect();
      return { height: rect.height, lineHeight: Number.parseFloat(getComputedStyle(input).lineHeight) };
    }, first);
    if (wrappedMetrics.height < wrappedMetrics.lineHeight * 2.5) {
      throw new Error(`Narrow production cell did not wrap onto visual lines: ${JSON.stringify(wrappedMetrics)}`);
    }
    await page.click(first);
    const nativePoint = await page.$eval(first, input => {
      const rect = input.getBoundingClientRect();
      return { x: rect.left + 16, y: rect.top + 10 };
    });
    await page.mouse.move(nativePoint.x, nativePoint.y);
    await page.mouse.down();
    const nativeCaret = await page.$eval(first, input => (input as HTMLTextAreaElement).selectionStart);
    await page.evaluate(() => (window as any).__tableCellEditor.view.contentDOM.focus({ preventScroll: true }));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.mouse.up();
    const nativeReturn = await page.$eval(first, input => ({ focused: document.activeElement === input,
      caret: (input as HTMLTextAreaElement).selectionStart }));
    if (!nativeReturn.focused || nativeReturn.caret !== nativeCaret) {
      throw new Error(`Late document focus stole the current cell's native click: ${JSON.stringify({ nativeCaret, ...nativeReturn })}`);
    }
    await page.click(first, { offset: { x: 18, y: wrappedMetrics.lineHeight * 1.5 } });
    await page.keyboard.press('ArrowUp');
    const wrappedArrowUp = await page.evaluate(() => {
      const active = document.activeElement as HTMLTextAreaElement | null;
      return { row: active?.dataset.tableRow, col: active?.dataset.tableCol };
    });
    if (wrappedArrowUp.row !== '1' || wrappedArrowUp.col !== '0') {
      throw new Error(`ArrowUp escaped from the second visual line: ${JSON.stringify(wrappedArrowUp)}`);
    }
    await page.click(first, { offset: { x: 18, y: wrappedMetrics.lineHeight * 0.5 } });
    await page.keyboard.press('ArrowUp');
    const firstVisualLineTarget = await page.evaluate(() => {
      const active = document.activeElement as HTMLTextAreaElement | null;
      return { row: active?.dataset.tableRow, col: active?.dataset.tableCol };
    });
    if (firstVisualLineTarget.row !== '0' || firstVisualLineTarget.col !== '0') {
      throw new Error(`ArrowUp did not cross from the first visual line: ${JSON.stringify(firstVisualLineTarget)}`);
    }
    await page.click(first, { offset: { x: 18, y: wrappedMetrics.height - wrappedMetrics.lineHeight * 0.5 } });
    await page.keyboard.press('ArrowDown');
    const lastVisualLineTarget = await page.evaluate(() => {
      const active = document.activeElement as HTMLTextAreaElement | null;
      return { row: active?.dataset.tableRow, col: active?.dataset.tableCol };
    });
    if (lastVisualLineTarget.row !== '2' || lastVisualLineTarget.col !== '0') {
      throw new Error(`ArrowDown did not cross from the last visual line: ${JSON.stringify(lastVisualLineTarget)}`);
    }

    await page.click(first);
    await page.keyboard.press('Tab');
    const tabTarget = await page.evaluate(() => {
      const active = document.activeElement as HTMLTextAreaElement | null;
      return active ? { row: active.dataset.tableRow, col: active.dataset.tableCol } : null;
    });
    if (tabTarget?.row !== '1' || tabTarget.col !== '1') throw new Error(`Tab did not select adjacent cell: ${JSON.stringify(tabTarget)}`);
    await page.keyboard.down('Shift');
    await page.keyboard.press('Tab');
    await page.keyboard.up('Shift');
    const shiftTabTarget = await page.evaluate(() => {
      const active = document.activeElement as HTMLTextAreaElement | null;
      return active ? { row: active.dataset.tableRow, col: active.dataset.tableCol } : null;
    });
    if (shiftTabTarget?.row !== '1' || shiftTabTarget.col !== '0') throw new Error(`Shift+Tab did not select preceding cell: ${JSON.stringify(shiftTabTarget)}`);
    const editingCells = await page.$$eval('.meo-md-html-table:not(.meo-md-html-table-sticky-table) .is-editing', cells => cells.length);
    if (editingCells !== 1) throw new Error(`Cell navigation retained ${editingCells} editing presentations`);

    const menuSession = await page.evaluate((selector) => {
      const input = document.querySelector<HTMLTextAreaElement>(selector)!;
      input.setSelectionRange(3, 7, 'backward');
      const shell = input.closest('.meo-md-html-table-shell')!;
      shell.querySelector<HTMLButtonElement>('.meo-md-html-table-context-trigger')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      shell.querySelector<HTMLButtonElement>('[data-command="insert-row-below"]')!.focus();
      return { active: document.activeElement?.tagName, editing: input.parentElement!.classList.contains('is-editing') };
    }, first);
    if (menuSession.active !== 'BUTTON' || !menuSession.editing) throw new Error(`Table menu ended the cell session: ${JSON.stringify(menuSession)}`);
    const menuReturn = await page.evaluate((selector) => {
      (window as any).__tableCellEditor.focus();
      const input = document.querySelector<HTMLTextAreaElement>(selector)!;
      return { focused: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection };
    }, first);
    if (!menuReturn.focused || menuReturn.start !== 3 || menuReturn.end !== 7 || menuReturn.direction !== 'backward') {
      throw new Error(`Table menu lost the native cell return point: ${JSON.stringify(menuReturn)}`);
    }
    await page.keyboard.press('Escape');
    const stillEditing = await page.$eval(first, input => input.parentElement!.classList.contains('is-editing'));
    if (!stillEditing) throw new Error('Closing the table menu ended the cell editing session');

    await page.evaluate(() => {
      (window as any).__cellPresentationFrames = [];
      (window as any).__recordCellPresentation = true;
      const sample = () => {
        (window as any).__cellPresentationFrames.push({
          editing: document.querySelectorAll('.meo-md-html-table:not(.meo-md-html-table-sticky-table) .is-editing').length,
          active: document.activeElement?.tagName,
          columns: document.querySelectorAll('.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead textarea').length
        });
        if ((window as any).__recordCellPresentation) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      (window as any).__tableCellEditor.executeCommand('columnAfter');
    });
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead textarea').length === 3
      && document.activeElement instanceof HTMLTextAreaElement);
    await page.evaluate(() => (window as any).__tableCellEditor.undo());
    await page.evaluate(() => (window as any).__tableCellEditor.redo());
    await page.evaluate(() => (window as any).__tableCellEditor.undo());
    const structuralFrames = await page.evaluate(() => {
      (window as any).__recordCellPresentation = false;
      return (window as any).__cellPresentationFrames as Array<{ editing: number; active: string; columns: number }>;
    });
    if (structuralFrames.length === 0 || structuralFrames.some(frame => frame.editing !== 1)) {
      throw new Error(`Structural command/Undo/Redo flashed the cell presentation: ${JSON.stringify(structuralFrames)}`);
    }
    await waitForTable(page);

    const appendOnLastTab = await page.evaluate(() => /^win/i.test(navigator.platform));
    await page.click(last);
    await page.keyboard.press('Tab');
    if (appendOnLastTab) await page.waitForFunction(() => {
      const active = document.activeElement as HTMLElement | null;
      return active?.dataset.tableRow === '3' && active.dataset.tableCol === '0';
    });
    const lastTabState = await page.evaluate(() => ({
      rows: document.querySelectorAll('.meo-md-html-table-shell tbody tr').length,
      text: (window as any).__tableCellEditor.getText()
    }));
    if (lastTabState.rows !== (appendOnLastTab ? 3 : 2)
      || lastTabState.text !== (appendOnLastTab ? source + '\n|  |  |' : source)) {
      throw new Error(`Last-cell Tab produced unexpected Markdown: ${JSON.stringify(lastTabState)}`);
    }
    if (appendOnLastTab) {
      await page.evaluate(() => (window as any).__tableCellEditor.undo());
      assert.equal(await page.evaluate(() => (window as any).__tableCellEditor.getText()), source);
      await waitForTable(page);
    }

    await page.click(last);
    await page.keyboard.press('Enter');
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    const finalEnterState = await page.evaluate(() => {
      const editor = (window as any).__tableCellEditor;
      const head = editor.view.state.selection.main.head;
      return {
        active: document.activeElement?.tagName ?? '',
        focused: editor.hasFocus(),
        head,
        line: editor.view.state.doc.lineAt(head).number,
        rows: document.querySelectorAll('.meo-md-html-table-shell tbody tr').length,
        text: editor.getText()
      };
    });
    if (
      finalEnterState.active === 'TEXTAREA' ||
      !finalEnterState.focused ||
      finalEnterState.head !== source.length + 1 ||
      finalEnterState.line !== 5 ||
      finalEnterState.rows !== 2 ||
      finalEnterState.text !== `${source}\n`
    ) {
      throw new Error(`Last-cell Enter did not create and enter the line after the table: ${JSON.stringify(finalEnterState)}`);
    }

    await page.click(second);
    await page.keyboard.press('End');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    await page.keyboard.type('continued');
    await page.waitForFunction(() => {
      const active = document.activeElement as HTMLTextAreaElement | null;
      return active?.value.includes('<br>\ncontinued') ?? false;
    });
    await page.keyboard.press('ArrowLeft');
    const arrowState = await page.evaluate(() => {
      const active = document.activeElement as HTMLTextAreaElement | null;
      return { sameCell: active?.dataset.tableRow === '1' && active.dataset.tableCol === '1', caret: active?.selectionStart };
    });
    if (!arrowState.sameCell || arrowState.caret === null) throw new Error(`Ordinary ArrowLeft was stolen: ${JSON.stringify(arrowState)}`);

    const beforeEscapeDepth = await page.evaluate(() => (window as any).__tableCellEditor.getHistoryDepth());
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (window as any).__tableCellEditor.getText().includes('continued'));
    const escaped = await page.evaluate(() => ({
      text: (window as any).__tableCellEditor.getText(),
      active: document.activeElement?.tagName ?? '',
      depth: (window as any).__tableCellEditor.getHistoryDepth()
    }));
    if (escaped.active === 'TEXTAREA' || escaped.depth.undo !== beforeEscapeDepth.undo + 1) {
      throw new Error(`Escape did not commit exactly once and exit: ${JSON.stringify({ beforeEscapeDepth, escaped })}`);
    }
    if (await page.$('.meo-md-html-table:not(.meo-md-html-table-sticky-table) .is-editing')) {
      throw new Error('Escape retained the cell editing presentation');
    }
    const undo = await page.evaluate(() => (window as any).__tableCellEditor.undo());
    await page.waitForFunction(() => !(window as any).__tableCellEditor.getText().includes('continued'));
    const redo = await page.evaluate(() => (window as any).__tableCellEditor.redo());
    await page.waitForFunction(() => (window as any).__tableCellEditor.getText().includes('continued'));
    if (!undo || !redo) throw new Error('Escape commit did not use the shared editor history');

    await page.click(first);
    await page.keyboard.press('End');
    await page.keyboard.type(' pending');
    await page.evaluate(() => (window as any).__tableCellEditor.setText('| A | B |\n| --- | --- |\n| external | kept |'));
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('tbody textarea')?.value === 'external');
    const external = await page.evaluate(() => (window as any).__tableCellEditor.getText());
    if (external !== '| A | B |\n| --- | --- |\n| external | kept |') throw new Error(`Late cell timer overwrote external text: ${external}`);

    await page.click('tbody tr:first-child td:first-child textarea');
    await page.keyboard.press('End');
    await page.keyboard.type(' mode');
    await page.evaluate(() => (window as any).__tableCellEditor.setMode('source'));
    await page.waitForFunction(() => !document.querySelector('.meo-md-html-table-shell'));
    const sourceModeText = await page.evaluate(() => (window as any).__tableCellEditor.getText());
    if (!sourceModeText.includes('external mode')) throw new Error(`Mode transition lost pending cell intent: ${sourceModeText}`);

    await page.evaluate((text) => {
      (window as any).__tableCellEditor.destroy();
      (window as any).__tableCellEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
    }, source);
    await waitForTable(page);
    await page.click(last);
    await page.keyboard.press('End');
    await page.keyboard.type(' changed');
    await page.keyboard.press('Enter');
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    const pendingFinalEnterState = await page.evaluate(() => {
      const editor = (window as any).__tableCellEditor;
      const head = editor.view.state.selection.main.head;
      return {
        active: document.activeElement?.tagName ?? '',
        focused: editor.hasFocus(),
        head,
        line: editor.view.state.doc.lineAt(head).number,
        rows: document.querySelectorAll('.meo-md-html-table-shell tbody tr').length,
        text: editor.getText()
      };
    });
    const pendingFinalEnterSource = `${source.replace('four', 'four changed')}\n`;
    if (
      pendingFinalEnterState.active === 'TEXTAREA' ||
      !pendingFinalEnterState.focused ||
      pendingFinalEnterState.head !== pendingFinalEnterSource.length ||
      pendingFinalEnterState.line !== 5 ||
      pendingFinalEnterState.rows !== 2 ||
      pendingFinalEnterState.text !== pendingFinalEnterSource
    ) {
      throw new Error(`Last-cell Enter lost a pending edit while leaving the table: ${JSON.stringify(pendingFinalEnterState)}`);
    }

    await page.evaluate(() => (window as any).__tableCellEditor.destroy());
    console.log('table cell editing production checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
