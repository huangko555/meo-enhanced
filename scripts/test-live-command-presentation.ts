import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { browser, server, open, frames, assertStablePaint, observedPaints } from './input-presentation-test-helpers';
import { closeTestBrowser } from './browser-test-helpers';

// Use the shipped Worker/partial-parse path; core-editor fixtures miss the bug.
const fixture = [
  '# Controls', '', '**UNRELATED ABOVE** with `code` and a [link](https://example.test).', '',
  '**Editable color** #60A5FA here.', '', '- [ ] Stable checkbox', '',
  '| A | B | C |', '| --- | --- | --- |',
  '| beta #60A5FA | 20 | B |', '| alpha | 10 | A |', '| gamma | 30 | C |', '',
  'After table.', '', '```js', 'const stable = true;', '```', '',
  '$$', 'x^2 + y^2', '$$', '', '<div>Stable HTML</div>', ''
].join('\n');
const commands = [
  'insert-row-above', 'insert-row-below', 'delete-row',
  'insert-column-left', 'insert-column-right', 'delete-column',
  'move-row-up', 'move-row-down', 'move-column-left', 'move-column-right',
  'align-left', 'align-center', 'align-right', 'sort-ascending', 'sort-descending', 'delete-table'
];
let cases = 0;

async function prepare(page: Page, large: boolean) {
  const host = await open(page, fixture + (large ? '\n\n' + 'Padding with **formatting**.\n\n'.repeat(5000) : ''), false, 'live');
  // Native caret blink is allowed; changing text presentation is not.
  await page.addStyleTag({ content: '.cm-cursor,.cm-dropCursor{visibility:hidden!important}.cm-editor *{caret-color:transparent!important}' });
  await page.evaluate(() => {
    const scope = window as any;
    const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
    scope.__commandView = view;
    view.dispatch({ selection: { anchor: view.state.doc.line(3).to } });
    view.focus();
  });
  await frames(page, 4);
  return host;
}

async function observe(page: Page) {
  return page.evaluate(() => {
    const scope = window as any, view = scope.__commandView;
    const line = Array.from(view.contentDOM.querySelectorAll('.cm-line'))
      .find((element: any) => element.textContent.includes('UNRELATED ABOVE')) as HTMLElement;
    const rect = line.getBoundingClientRect();
    scope.__presentationFrames = [];
    const sample = () => {
      const current = Array.from(view.contentDOM.querySelectorAll('.cm-line'))
        .find((element: any) => element.textContent.includes('UNRELATED ABOVE')) as HTMLElement;
      scope.__presentationFrames.push({ html: current?.innerHTML, head: view.state.selection.main.head,
        scroll: view.scrollDOM.scrollTop, sameNode: current === line,
        returnEditing: scope.__colorReturnInput?.parentElement?.classList.contains('is-editing'),
        tables: view.contentDOM.querySelectorAll('.meo-md-html-table-shell').length });
      scope.__commandFrame = requestAnimationFrame(sample);
    };
    sample();
    return { left: Math.ceil(rect.left), top: Math.ceil(rect.top), width: Math.floor(rect.width), height: Math.floor(rect.height) };
  });
}

async function finishObservation(page: Page, label: string) {
  const samples = await page.evaluate(() => {
    const scope = window as any;
    cancelAnimationFrame(scope.__commandFrame);
    return scope.__presentationFrames as Array<{ html: string; head: number; scroll: number; sameNode: boolean; tables: number; returnEditing?: boolean }>;
  });
  assert.ok(samples.length > 3, label + ': observe intermediate frames');
  assert.ok(samples.every(sample => sample.html === samples[0].html), label + ': unchanged inline presentation');
  assert.ok(samples.every(sample => sample.sameNode), label + ': retain unrelated DOM');
  assert.ok(samples.every(sample => Math.abs(sample.scroll - samples[0].scroll) <= 1), label + ': stable viewport');
  return samples;
}

async function colorCase(large: boolean, inTable: boolean, apply: boolean, fromCell = false) {
  const page = await browser.newPage(), host = await prepare(page, large);
  const label = `color ${inTable ? 'table' : 'prose'} ${apply ? 'apply' : 'cancel'} large ${large} from cell ${fromCell}`;
  try {
    if (fromCell) {
      await page.click('tbody tr:nth-child(2) td:nth-child(2) .meo-md-html-table-cell-preview');
      await page.keyboard.press('End');
      await page.keyboard.type('777'); // Leave an uncommitted native-cell edit while the popup borrows focus.
      await page.evaluate(() => {
        const input = document.activeElement as HTMLTextAreaElement;
        input.setSelectionRange(0, 2, 'backward');
        (window as any).__colorReturnInput = input;
      });
      await frames(page, 5);
    }
    const clip = await observe(page);
    await assertStablePaint(page, clip, async () => {
      const selector = inTable ? '.meo-md-html-table .meo-md-color-swatch-interactive' : '.cm-line .meo-md-color-swatch-interactive';
      await page.hover(selector);
      await page.mouse.down();
      await frames(page, 6); // Holding a button must not retire the source line.
      await page.mouse.up();
      await frames(page, 4);
      await page.click('.meo-hex-color-adjustment-hue');
      await page.keyboard.press('ArrowRight');
      if (apply) await page.click('.meo-hex-color-adjustment-apply');
      else await page.keyboard.press('Escape');
    }, label);
    const samples = await finishObservation(page, label);
    if (fromCell) {
      assert.ok(samples.every(sample => sample.returnEditing), label + ': keep the borrowed cell in editing presentation');
      assert.deepEqual(await page.evaluate(() => {
        const input = (window as any).__colorReturnInput as HTMLTextAreaElement;
        return { focused: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection };
      }), { focused: true, start: 0, end: 2, direction: 'backward' }, label + ': restore native cell selection');
    }
    // A pending native edit can commit its added source characters while the
    // popup is open. Its outer head legitimately maps; the native range above
    // remains the authoritative caret/selection for that cell.
    if (!fromCell) assert.ok(samples.every(sample => sample.head === samples[0].head), label + ': preserve document selection');
    assert.equal(await page.$('.meo-hex-color-adjustment'), null, label + ': popup closed');
    if (fromCell) {
      assert.equal(await page.evaluate(() => ((window as any).__colorReturnInput as HTMLTextAreaElement).value), '10777', label + ': retain pending cell text');
      await page.click('.editor-host .cm-line');
      await frames(page, 8);
      assert.ok((await host.readHost()).includes('10777'), label + ': pending text still commits after focus return');
    }
    assert.deepEqual(host.errors, [], label + ': no runtime errors');
    cases++;
  } finally { host.dispose(); await page.close(); }
}

async function tableCase(large: boolean, command: string) {
  const page = await browser.newPage(), host = await prepare(page, large);
  const label = `table ${command} large ${large}`;
  try {
    await page.click('tbody tr:nth-child(2) td:nth-child(2) .meo-md-html-table-cell-preview');
    await page.keyboard.press('End');
    await page.keyboard.type('777'); // Commands must also retire an existing native-input viewport owner.
    await frames(page, 5);
    const before = await page.evaluate(() => (window as any).__commandView.state.doc.toString());
    const clip = await observe(page);
    await assertStablePaint(page, clip, async () => {
      await page.click('.meo-md-html-table-context-trigger');
      if (/^(move|align|sort)-/.test(command)) await page.click('[data-page-action="next"]');
      const selector = `[data-command="${command}"]`;
      assert.equal(await page.$eval(selector, element => (element as HTMLButtonElement).disabled), false, label + ': enabled command');
      await page.click(selector);
      if (command === 'delete-table') await page.click(selector); // Two-click confirmation.
    }, label);
    const samples = await finishObservation(page, label);
    const after = await page.evaluate(() => (window as any).__commandView.state.doc.toString());
    assert.notEqual(after, before, label + ': command updates document');
    if (command !== 'delete-table') {
      assert.ok(samples.every(sample => sample.tables === 1), label + ': table never falls back to source');
      assert.ok(await page.evaluate(() => {
        const input = document.activeElement;
        if (!(input instanceof HTMLTextAreaElement)) return false;
        const view = (window as any).__commandView;
        const rect = input.getBoundingClientRect(), bounds = view.scrollDOM.getBoundingClientRect();
        const start = Number(input.closest<HTMLElement>('.meo-md-html-table-shell')?.dataset.meoRenderedBlockStartLine);
        const row = Number(input.dataset.tableRow), sourceLine = start + (row > 0 ? row + 1 : 0);
        return rect.height > 0 && rect.top >= bounds.top && rect.bottom <= bounds.bottom
          && view.state.doc.lineAt(view.state.selection.main.head).number === sourceLine;
      }), label + ': focus returns to a visible cell');
    } else assert.equal(await page.$('.meo-md-html-table-shell'), null, label + ': table removed');
    assert.deepEqual(host.errors, [], label + ': no runtime errors');
    cases++;
  } finally { host.dispose(); await page.close(); }
}

async function longTableCase(command: string) {
  const row = command === 'sort-descending' ? 10 : 40;
  const page = await browser.newPage();
  const prefix = Array.from({ length: 80 }, (_, index) => `Before paragraph ${index} with **format**.`).join('\n\n');
  const table = ['| A | B |', '| --- | --- |',
    ...Array.from({ length: 80 }, (_, index) => `| row-${index} | ${index} |`)].join('\n');
  const host = await open(page, prefix + '\n\n' + table + '\n\nAfter table deletion.\n\n'
    + 'Remaining **content**.\n\n'.repeat(5000), false, 'live');
  try {
    await page.evaluate(row => {
      const scope = window as any;
      const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
      scope.__commandView = view;
      const position = view.state.doc.toString().indexOf(`| row-${row} `);
      view.dispatch({ selection: { anchor: position } });
      view.scrollDOM.scrollTop = view.lineBlockAt(position).top - 200;
    }, row);
    await frames(page, 20);
    await page.click(`tbody tr:nth-child(${row + 1}) td:nth-child(2) .meo-md-html-table-cell-preview`);
    await frames(page, 8);
    await page.click('.meo-md-html-table-context-trigger');
    if (command === 'align-center' || command === 'sort-descending') await page.click('[data-page-action="next"]');
    await page.evaluate(() => {
      const scope = window as any;
      scope.__presentationFrames = [];
      const sample = () => {
        const active = document.activeElement;
        scope.__presentationFrames.push({ scroll: scope.__commandView.scrollDOM.scrollTop,
          row: active instanceof HTMLTextAreaElement ? active.dataset.tableRow : null });
        scope.__commandFrame = requestAnimationFrame(sample);
      };
      sample();
    });
    await page.click(`[data-command="${command}"]`);
    if (command === 'delete-table') await page.click('[data-command="delete-table"]');
    await frames(page, 80); // Include delayed geometry/focus settlement, not just dispatch.
    const result = await page.evaluate(() => {
      const scope = window as any, view = scope.__commandView;
      cancelAnimationFrame(scope.__commandFrame);
      const coords = view.coordsAtPos(view.state.selection.main.head), bounds = view.scrollDOM.getBoundingClientRect();
      const active = document.activeElement, inputRect = active instanceof HTMLTextAreaElement ? active.getBoundingClientRect() : null;
      const sourceLine = active instanceof HTMLTextAreaElement
        ? Number(active.closest<HTMLElement>('.meo-md-html-table-shell')?.dataset.meoRenderedBlockStartLine)
          + Number(active.dataset.tableRow) + 1 : null;
      return { samples: scope.__presentationFrames as Array<{ scroll: number; row: string | null }>,
        caretVisible: Boolean(coords && coords.top >= bounds.top && coords.bottom <= bounds.bottom),
        inputVisible: Boolean(inputRect && inputRect.top >= bounds.top && inputRect.bottom <= bounds.bottom),
        sourceAligned: sourceLine === view.state.doc.lineAt(view.state.selection.main.head).number,
        focused: view.hasFocus, line: view.state.doc.lineAt(view.state.selection.main.head).text };
    });
    const settled = result.samples.slice(-30);
    assert.ok(settled.every(sample => Math.abs(sample.scroll - settled[0].scroll) <= 1), command + ': no delayed viewport chase');
    if (command === 'delete-table') {
      assert.ok(result.focused && result.caretVisible, 'Deleted table must hand off to a visible document caret');
      assert.equal(result.line, '', 'Caret remains at the deletion point');
    } else if (command === 'sort-descending') {
      assert.ok(result.sourceAligned, 'Sorting aligns the outer source position with the moved cell');
      assert.ok(result.inputVisible, 'Sorting must keep the moved cell caret visible');
      assert.ok(settled.every(sample => sample.row === '70'), 'Sorting follows the edited row');
      assert.ok(result.samples.every((sample, index) => index === 0 || sample.scroll >= result.samples[index - 1].scroll - 1), 'Sorting reveals once without pulling back');
    } else {
      assert.ok(result.samples.every(sample => Math.abs(sample.scroll - result.samples[0].scroll) <= 1), command + ': retain long-table viewport');
      assert.ok(settled.every(sample => sample.row === '41'), command + ': retain the active body row');
    }
    assert.deepEqual(host.errors, []);
    cases++;
  } finally { host.dispose(); await page.close(); }
}

let failure: unknown;
try {
  for (const large of [false, true]) {
    for (const inTable of [false, true]) for (const apply of [false, true]) await colorCase(large, inTable, apply);
    for (const apply of [false, true]) await colorCase(large, true, apply, true);
    for (const command of commands) await tableCase(large, command);
  }
  for (const command of ['insert-row-below', 'align-center', 'sort-descending', 'delete-table']) await longTableCase(command);
  console.log(`Live command presentation passed: ${cases} table/color cases, ${observedPaints} compositor frames`);
} catch (error) { failure = error; throw error; }
finally {
  server.stop(true);
  if (failure === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, failure);
}
