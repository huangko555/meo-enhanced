import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { browser, server, open, frames, assertStablePaint, assertStableHistoryPaint, observedPaints } from './input-presentation-test-helpers';
import { closeTestBrowser } from './browser-test-helpers';
import { assessLargeDocument } from '../src/foundation/largeDocument';
import { tableCommands } from '../webview/src/application/tableCommand';
import { captureHistoryInteraction, captureHistoryAction, assertHistoryRoundTrip, assertHistoryCoverage, type HistoryInteractionState } from './history-interaction-contract';

// Use the shipped Worker/partial-parse path; core-editor fixtures miss the bug.
const fixture = [
  '# Controls', '', '**UNRELATED ABOVE** with `code` and a [link](https://example.test).', '',
  '**Editable color** #60A5FA here.', '', '- [ ] Stable checkbox', '',
  '| A | B | C |', '| --- | --- | --- |',
  '| beta #60A5FA | 20 | B |', '| alpha | 10 | A |', '| gamma | 30 | C |', '',
  'After table.', '', '```js', 'const stable = true;', '```', '',
  '$$', 'x^2 + y^2', '$$', '', '<div>Stable HTML</div>', ''
].join('\n');
const selectedCommand = process.argv.find(arg => arg.startsWith('--command='))?.slice(10);
assert.ok(!selectedCommand || tableCommands.includes(selectedCommand as typeof tableCommands[number]), 'Unknown table command filter');
const commands = tableCommands.filter(command => !selectedCommand || command === selectedCommand);
const historyReceipts: string[] = [];
let cases = 0;

// Exercise the shipped editor/Worker with a reading viewport independent of
// its old selection. Final source alone cannot detect a one-frame scroll chase.
async function taskInteractionCase(large: boolean, nested: boolean) {
  const page = await browser.newPage();
  const prefix = '# Task interaction\n\n' + Array.from({ length: 85 }, (_, i) => `Before ${i}.\n\n`).join('');
  const children = nested ? Array.from({ length: 180 }, (_, i) => `  - [ ] Child ${i}.\n`).join('') : '';
  const text = prefix + '- [ ]  Task **body** with `code`.\n' + children
    + '\n## Unchanged heading\n\nA footnote[^task].\n\n[^task]: Unchanged definition.\n\n'
    + (large ? 'Padding.\n'.repeat(8100) : 'After.\n\n'.repeat(45));
  assert.equal(assessLargeDocument(text).boundedEditorWork, large, 'task fixture must select the production work budget');
  const host = await open(page, text, false, 'live');
  const label = `task interaction large ${large} nested ${nested}`;
  try {
    await page.evaluate(() => {
      const scope = window as any;
      scope.__taskView = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
      scope.__taskView.dispatch({ selection: { anchor: 0 } });
      scope.__taskView.focus();
    });
    const area = await page.$eval('.editor-host .cm-scroller', element => {
      const rect = element.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    await page.mouse.move(area.x, area.y);
    let point: { x: number; y: number } | null = null;
    for (let step = 0; step < 14 && !point; step++) {
      point = await page.evaluate(() => {
        const box = document.querySelector('.editor-host .meo-task-checkbox');
        if (!box) return null;
        const rect = box.getBoundingClientRect(), bounds = document.querySelector('.editor-host .cm-scroller')!.getBoundingClientRect();
        return rect.top > bounds.top + 50 && rect.bottom < bounds.bottom - 50
          ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
      });
      if (!point) { await page.mouse.wheel({ deltaY: 500 }); await frames(page, 5); }
    }
    assert.ok(point, label + ': reach the task with trusted wheel input');
    const body = text.indexOf('Task **body**');
    const observe = async (action: () => Promise<void>, expectedHead: number, expectedText: string, checkbox: boolean) => {
      await page.evaluate(() => {
        const scope = window as any, view = scope.__taskView;
        scope.__taskFrames = [];
        const sample = () => {
          const line = [...view.contentDOM.querySelectorAll('.cm-line')].find((line: any) => line.textContent.includes('Task **body**'));
          scope.__taskFrames.push({ scroll: view.scrollDOM.scrollTop, box: !!line?.querySelector('.meo-task-checkbox'),
            childBox: [...view.contentDOM.querySelectorAll('.cm-line')].some((line: any) => line.textContent.includes('Child 0.') && line.querySelectorAll('.meo-task-checkbox').length === 1) });
          scope.__taskFrame = requestAnimationFrame(sample);
        };
        sample();
      });
      await action(); await frames(page, 45);
      const result = await page.evaluate(() => {
        const scope = window as any, view = scope.__taskView;
        cancelAnimationFrame(scope.__taskFrame);
        return { frames: scope.__taskFrames as Array<{ scroll: number; box: boolean; childBox: boolean }>,
          head: view.state.selection.main.head, text: view.state.doc.toString() };
      });
      assert.equal(result.text, expectedText, label + ': exact source');
      assert.equal(result.head, expectedHead, label + ': semantic caret');
      assert.ok(result.frames.every(frame => Math.abs(frame.scroll - result.frames[0].scroll) <= 1), label + ': retain viewport in every frame');
      if (checkbox) assert.ok(result.frames.every(frame => frame.box), label + ': retain checkbox through deferred history presentation');
      if (nested) assert.ok(result.frames.every(frame => frame.childBox), label + ': retain child task presentation through hoisting and history');
    };
    const key = async (key: string) => {
      if (key.startsWith('Control+')) {
        await page.keyboard.down('Control'); await page.keyboard.press(key.slice(8)); await page.keyboard.up('Control');
      } else await page.keyboard.press(key);
    };
    const checked = text.replace('- [ ]  Task', '- [x]  Task');
    if (!nested) {
      await observe(() => page.mouse.click(point!.x, point!.y), body, checked, true);
      await observe(() => key('Control+z'), body, text, true);
      await observe(() => key('Control+y'), body, checked, true);
      // Toggling from the same task body preserves the user's editing offset.
      await page.evaluate(body => (window as any).__taskView.dispatch({ selection: { anchor: body + 2 } }), body);
      await frames(page, 4);
      await observe(() => page.mouse.click(point!.x, point!.y), body + 2, text, true);
      // The keyboard checkbox remains the focused control; Space must not
      // navigate to an unrelated text selection or change its editing offset.
      await page.evaluate(() => {
        const view = (window as any).__taskView;
        view.dispatch({ selection: { anchor: 0 } });
        view.contentDOM.querySelector('.meo-task-checkbox').focus({ preventScroll: true });
      });
      await observe(() => key('Space'), 0, checked, true);
      assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('meo-task-checkbox')), label + ': retain keyboard checkbox focus');
      // Native Edit-menu/touch history enters through beforeinput rather than
      // the keyboard shortcut and must use the same semantic replay owner.
      await observe(async () => {
        await page.evaluate(() => (window as any).__taskView.contentDOM.dispatchEvent(new InputEvent('beforeinput', {
          inputType: 'historyUndo', bubbles: true, cancelable: true
        })));
      }, body, text, true);
      await page.evaluate(() => {
        const view = (window as any).__taskView; view.dispatch({ selection: { anchor: 0 } });
        view.contentDOM.querySelector('.meo-task-checkbox').focus({ preventScroll: true });
      });
      await observe(() => page.mouse.click(point!.x, point!.y), body, checked, true);
      assert.ok(await page.evaluate(() => (window as any).__taskView.hasFocus), label + ': pointer activation returns typing to the task body');
      const padded = checked.slice(0, body) + '  ' + checked.slice(body);
      await observe(async () => {
        await page.evaluate(body => {
          const view = (window as any).__taskView;
          // One event turn pins a real pending-presentation race: a separator
          // edit followed by control activation before the Worker can publish.
          view.dispatch({ changes: { from: body, insert: '  ' }, selection: { anchor: body + 2 }, userEvent: 'input.type' });
          view.dispatch({ selection: { anchor: 0 } });
          view.contentDOM.querySelector('.meo-task-checkbox').click();
        }, body);
      }, body + 2, padded.replace('- [x]', '- [ ]'), true);
      const surface = { witness: 'Before 84.' };
      await page.evaluate(body => { const view = (window as any).__taskView; view.focus(); view.dispatch({ selection: { anchor: body + 2, head: body + 6 } }); }, body);
      const before = await captureHistoryInteraction(page, surface);
      await page.mouse.click(point!.x, point!.y); await frames(page, 8);
      const after = await captureHistoryInteraction(page, surface);
      assert.deepEqual(after.ranges, before.ranges, label + ': retain a body text selection when toggling');
      const historyLabel = label + '/body-selection';
      await assertHistoryRoundTrip(page, { ...surface, label: historyLabel, before, after }); historyReceipts.push(historyLabel);
    } else {
      await page.evaluate(body => (window as any).__taskView.dispatch({ selection: { anchor: body } }), body);
      await frames(page, 4);
      const deleted = text.slice(0, prefix.length) + text.slice(body).replace(/^  - /gm, '- ');
      await observe(() => key('Backspace'), prefix.length, deleted, false);
      await observe(() => key('Control+z'), body, text, false);
      await observe(() => key('Control+y'), prefix.length, deleted, false);
    }
    assert.deepEqual(host.errors, [], label + ': no runtime errors');
    cases++;
  } finally { host.dispose(); await page.close(); }
}

async function richTaskBackspaceCase(large: boolean, action: 'Backspace' | 'Enter' | 'StartEnter' | 'Tab' | 'Outdent' = 'Backspace') {
  const enter = action === 'Enter' || action === 'StartEnter';
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  const prefix = '# Rich task deletion\n\n' + Array.from({ length: large ? 4100 : 25 }, (_, i) =>
    `Paragraph ${i} with **emphasis** and \`code\`.\n\n`).join('');
  const text = prefix + (action === 'Outdent' ? '  ' : '') + '- [ ]  Task **body** with `code`.\n- [x] Next task.\n\n'
    + 'Footnote[^task].\n\n[^task]: Definition.\n\n> ```js\n> const stable = true;\n> ```\n\n'
    + '## Unchanged heading\n\n' + 'After.\n\n'.repeat(60);
  assert.equal(assessLargeDocument(text).boundedEditorWork, large, 'rich task fixture must select the production work budget');
  const body = text.indexOf('Task **body**'), host = await open(page, text, false, 'live');
  const label = `rich task ${action} large ${large}`;
  try {
    await page.evaluate(body => {
      const scope = window as any;
      scope.__taskView = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
      scope.__taskView.dispatch({ selection: { anchor: body }, scrollIntoView: true }); scope.__taskView.focus();
    }, body);
    await frames(page, 12);
    await page.waitForFunction(() => [...document.querySelectorAll('.editor-host .cm-line')].some(line =>
      line.textContent?.includes('Task **body**') && line.querySelector('.meo-md-strong')));
    const area = await page.$eval('.editor-host .cm-scroller', element => {
      const rect = element.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    await page.mouse.move(area.x, area.y); await page.mouse.wheel({ deltaY: 300 }); await frames(page, 6);
    const point = await page.evaluate(body => {
      const rect = (window as any).__taskView.coordsAtPos(body, 1); return { x: rect.left + 0.2, y: (rect.top + rect.bottom) / 2 };
    }, body);
    await page.mouse.click(point.x, point.y);
    const head = await page.evaluate(() => (window as any).__taskView.state.selection.main.head);
    if (head === body + 1) await page.keyboard.press('ArrowLeft');
    else assert.equal(head, body, label + ': actual body-start hit');
    if (action === 'Enter') await page.keyboard.press('End');
    await frames(page, 4);
    const clip = await page.evaluate(() => {
      const scope = window as any, view = scope.__taskView;
      const heading = [...view.contentDOM.querySelectorAll('.cm-line')].find((line: any) => line.textContent.includes('Unchanged heading'));
      if (!heading?.classList.contains('meo-md-h2')) throw new Error('Missing rich heading witness');
      // Keep the pixel witness on one compositing layer. Editing can switch
      // LCD/grayscale glyph rasterization despite identical geometry and color.
      // Identity/classes/geometry below still detect a replaced or raw heading.
      heading.style.willChange = 'transform';
      const rect = heading.getBoundingClientRect(), bounds = view.scrollDOM.getBoundingClientRect();
      if (rect.top < bounds.top || rect.bottom > bounds.bottom) throw new Error('Rich heading witness must be visible');
      scope.__taskFrames = [];
      scope.__richPresentationFrames = scope.__taskFrames;
      const sample = () => {
        const rect = heading.getBoundingClientRect(), style = getComputedStyle(heading);
        scope.__taskFrames.push({ scroll: view.scrollDOM.scrollTop, sameHeading: heading.isConnected && heading.classList.contains('meo-md-h2'),
          top: rect.top, left: rect.left, color: style.color, font: style.font, transform: style.transform });
        scope.__taskFrame = requestAnimationFrame(sample);
      }; sample();
      return { left: Math.ceil(rect.left), top: Math.ceil(rect.top), width: Math.floor(rect.width), height: Math.floor(rect.height) };
    });
    const act = async () => {
      if (action === 'Outdent') {
        await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
      } else await page.keyboard.press(enter ? 'Enter' : action);
      await frames(page, 65);
      await page.evaluate(() => { const witness = document.getElementById('presentation-paint-witness'); if (witness) witness.style.background = 'rgb(19,211,41)'; });
      await frames(page, 2);
    };
    if (enter) await act(); // A new task row intentionally moves the heading.
    else await assertStablePaint(page, clip, act, label);
    const result = await page.evaluate(() => {
      const scope = window as any, view = scope.__taskView; cancelAnimationFrame(scope.__taskFrame);
      return { frames: scope.__taskFrames as Array<{ scroll: number; sameHeading: boolean; top: number; left: number; color: string; font: string }>,
        head: view.state.selection.main.head, text: view.state.doc.toString() };
    });
    const end = text.indexOf('\n', body);
    const expected = action === 'Enter' ? text.slice(0, end) + '\n- [ ] ' + text.slice(end)
      : action === 'StartEnter' ? prefix + '- [ ] \n' + text.slice(prefix.length)
      : action === 'Tab' ? prefix + '  ' + text.slice(prefix.length)
      : action === 'Outdent' ? prefix + text.slice(prefix.length + 2)
      : text.slice(0, prefix.length) + text.slice(body);
    const expectedHead = action === 'Enter' ? end + 7 : action === 'StartEnter' ? prefix.length + 6
      : action === 'Tab' ? body + 2 : action === 'Outdent' ? body - 2 : prefix.length;
    assert.equal(result.text, expected, label + ': exact task edit');
    assert.equal(result.head, expectedHead, label + ': retain edit point');
    assert.ok(result.frames.every(frame => frame.sameHeading), label + ': retain accepted rich presentation');
    assert.ok(result.frames.every(frame => frame.color === result.frames[0].color && frame.font === result.frames[0].font), label + ': retain heading typography');
    if (!enter) assert.ok(result.frames.every(frame => Math.abs(frame.top - result.frames[0].top) <= 1 && Math.abs(frame.left - result.frames[0].left) <= 1), label + ': retain heading geometry');
    assert.ok(result.frames.every(frame => Math.abs(frame.scroll - result.frames[0].scroll) <= 1), label + ': no transient or delayed scroll');
    for (const key of ['z', 'y']) {
      await page.keyboard.down('Control'); await page.keyboard.press(key); await page.keyboard.up('Control'); await frames(page, 35);
      const replay = await page.evaluate(() => { const view = (window as any).__taskView; return { text: view.state.doc.toString(), head: view.state.selection.main.head }; });
      assert.equal(replay.text, key === 'z' ? text : expected, label + ': history exact source');
      assert.equal(replay.head, key === 'z' ? action === 'Enter' ? end : body : expectedHead, label + ': history semantic caret');
    }
    if (action === 'StartEnter') {
      await page.keyboard.press('Enter'); await frames(page, 35);
      const exited = prefix + '\n' + text.slice(prefix.length);
      for (const key of [null, 'z', 'y']) {
        if (key) { await page.keyboard.down('Control'); await page.keyboard.press(key); await page.keyboard.up('Control'); await frames(page, 35); }
        const replay = await page.evaluate(() => { const view = (window as any).__taskView; return { text: view.state.doc.toString(), head: view.state.selection.main.head }; });
        assert.equal(replay.text, key === 'z' ? expected : exited, label + ': empty-task exit/history source');
        assert.equal(replay.head, key === 'z' ? expectedHead : prefix.length, label + ': empty-task exit/history caret');
      }
    }
    assert.deepEqual(host.errors, []); cases++;
  } finally { host.dispose(); await page.close(); }
}

async function localUnitCase(large: boolean, action: string, rich = false) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    const observer = new MutationObserver(() => {
      if (!document.documentElement) return;
      document.documentElement.style.setProperty('--vscode-editor-font-size', '26px');
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  const task = action === 'checkbox', body = (task ? '- [ ] Editable body' : 'Editable body') + (rich ? ' with `inline code`.' : '');
  const prefix = rich ? '| A | B |\n| --- | --- |\n' + '| Stable | Earlier table |\n'.repeat(24) + '\n' : '';
  const text = prefix + `### Unchanged heading\n\n${body}\n\n` + (large ? '\n'.repeat(8000) : 'After.');
  const host = await open(page, text, false, 'live');
  const label = `local unit ${action} large ${large} rich ${rich}`;
  try {
    await page.addStyleTag({ content: '.cm-cursor{visibility:hidden!important}' });
    await page.evaluate(({ task, rich }) => {
      const scope = window as any;
      const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
      scope.__commandView = view;
      const from = view.state.doc.toString().indexOf('Editable body');
      view.dispatch({ selection: { anchor: task ? from - 6 : from, head: task ? from - 6 : from + 13 } });
      if (rich) view.scrollDOM.scrollTop = Math.max(0, view.lineBlockAt(from).top - 200);
      view.focus();
    }, { task, rich });
    if (rich) await new Promise(resolve => setTimeout(resolve, 700));
    await frames(page, 6);
    const clip = await page.evaluate(() => {
      const scope = window as any, view = scope.__commandView;
      const heading = view.contentDOM.querySelector('.meo-md-h3') as HTMLElement;
      if (!heading) throw new Error('Missing initial heading');
      const rect = heading.getBoundingClientRect();
      const checkbox = view.contentDOM.querySelector('.meo-task-checkbox');
      scope.__unitFrames = [];
      const sample = () => {
        const current = [...view.contentDOM.querySelectorAll('.cm-line')].find((line: any) => line.textContent.includes('Unchanged heading')) as HTMLElement;
        const body = [...view.contentDOM.querySelectorAll('.cm-line')].find((line: any) => line.textContent.includes('Editable body')) as HTMLElement;
        scope.__unitFrames.push({ same: current === heading, classes: current?.className,
          height: current?.getBoundingClientRect().height, top: body?.getBoundingClientRect().top, scroll: view.scrollDOM.scrollTop,
          sameCheckbox: view.contentDOM.querySelector('.meo-task-checkbox') === checkbox,
          history: scope.__unitHistory === true });
        scope.__unitFrame = requestAnimationFrame(sample);
      };
      sample();
      return { left: Math.ceil(rect.left), top: Math.ceil(rect.top), width: Math.floor(rect.width), height: Math.floor(rect.height) };
    });
    const act = async () => {
      if (task) {
        for (let index = 0; index < 3; index++) { await page.click('.meo-task-checkbox'); await frames(page, 2); }
        await page.evaluate(() => { (window as any).__unitHistory = true; });
        await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
        await frames(page, 3);
        await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control');
      }
      else if (action === 'heading') {
        await page.hover('[data-action="heading"]');
        await page.click('.heading-dropdown-option[data-level="1"]');
        await page.mouse.move(2, 2);
      } else await page.click(`[data-action="${action}"]`);
      await frames(page, 30);
      await page.evaluate(() => { const witness = document.getElementById('presentation-paint-witness'); if (witness) witness.style.background = 'rgb(19,211,41)'; });
      await frames(page, 2);
    };
    // The heading menu legitimately covers this clip. Its frame observer still
    // checks DOM/geometry; commands without an overlay also compare pixels.
    if (action === 'heading') await act();
    else await assertStablePaint(page, clip, act, label);
    const samples = await page.evaluate(() => {
      cancelAnimationFrame((window as any).__unitFrame);
      return (window as any).__unitFrames as Array<{ same: boolean; classes: string; height: number; top: number; scroll: number; sameCheckbox: boolean; history: boolean }>;
    });
    assert.ok(samples.length > 5, label + ': observe input and deferred settlement');
    assert.ok(samples.every(value => value.same && value.classes === samples[0].classes && value.height === samples[0].height), label + ': preserve unmodified heading');
    assert.ok(samples.every(value => Math.abs(value.top - samples[0].top) <= 1 && Math.abs(value.scroll - samples[0].scroll) <= 1), label + ': preserve body viewport');
    if (task) assert.ok(samples.every(value => value.sameCheckbox), label + ': keep the operated control mounted through history');
    const prefix = task ? '- [x] ' : ({ bulletList: '- ', numberedList: '1. ', task: '- [ ] ', quote: '> ', heading: '# ' } as Record<string, string>)[action];
    assert.ok(host.readHost().includes(prefix + 'Editable body'), label + ': commit command and history');
    assert.deepEqual(host.errors, [], label + ': no runtime errors');
    cases++;
  } finally { host.dispose(); await page.close(); }
}

async function columnFrameCase(large: boolean) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 900 });
  const table = ['| Sample | Scenario | Bytes | Lines | State | Notes |', '| --- | --- | ---: | ---: | --- | --- |',
    ...Array.from({ length: 12 }, (_, index) => `| R-${index} | 阅读位置与多语言内容 | 2,185 | 31 | Ready | Observation ${index} with a long description and code |`)].join('\n');
  const text = '# Column continuity\n\n' + table + '\n\nAfter.\n\n' + (large ? '\n'.repeat(8000) : '');
  const host = await open(page, text, false, 'live');
  const label = `column frames large ${large}`;
  try {
    await page.click('tbody tr:nth-child(1) td:nth-child(2) .meo-md-html-table-cell-preview');
    await frames(page, 6);
    await page.evaluate(() => {
      const scope = window as any;
      scope.__widthFrames = [];
      const sample = () => {
        const table = document.querySelector<HTMLTableElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)');
        scope.__widthFrames.push([...table?.tHead?.rows[0]?.cells ?? []].map(cell => cell.getBoundingClientRect().width));
        scope.__widthFrame = requestAnimationFrame(sample);
      };
      sample();
    });
    for (const command of ['insert-row-above', 'insert-row-below', 'delete-row', 'insert-column-left', 'insert-column-right']) {
      if (await page.$eval('.meo-md-html-table-context-menu', element => element.hasAttribute('hidden'))) await page.click('.meo-md-html-table-context-trigger');
      await page.click(`[data-command="${command}"]`);
      await frames(page, 24);
    }
    const samples = await page.evaluate(() => {
      cancelAnimationFrame((window as any).__widthFrame);
      return (window as any).__widthFrames as number[][];
    });
    assert.ok(samples.length > 20 && samples.every(widths => widths.length >= 6), label + ': table remains mounted');
    for (const count of [6, 7, 8]) {
      const group = samples.filter(widths => widths.length === count);
      assert.ok(group.length > 2, label + ': observe each column structure');
      assert.ok(group.every(widths => widths.every((width, index) => Math.abs(width - group.at(-1)![index]) <= 1)), label + ': each structure is painted at its accepted widths');
    }
    const sourceRows = host.readHost().split('\n').filter(line => line.startsWith('|'));
    assert.ok(sourceRows.every(line => line.split('|').length - 2 === 8), label + ': source columns match the command result');
    assert.equal(await page.$eval('.meo-md-html-table:not(.meo-md-html-table-sticky-table)', element => (element as HTMLTableElement).tBodies[0].rows.length), sourceRows.length - 2, label + ': rendered rows match complete source');
    assert.deepEqual(host.errors, []);
    cases++;
  } finally { host.dispose(); await page.close(); }
}

async function cellPreviewUnitCase(large: boolean) {
  const page = await browser.newPage(), host = await prepare(page, large);
  const label = `cell preview unit large ${large}`;
  try {
    await page.click('tbody tr:nth-child(2) td:nth-child(2) .meo-md-html-table-cell-preview');
    await page.keyboard.press('End'); await frames(page, 4);
    await page.evaluate(() => {
      const scope = window as any;
      const swatch = document.querySelector('.meo-md-html-table .meo-md-color-swatch-interactive');
      if (!swatch) throw new Error('Missing unrelated cell control');
      scope.__cellUnitSwatch = swatch;
      scope.__cellUnitFrames = [];
      const sample = () => {
        scope.__cellUnitFrames.push(document.querySelector('.meo-md-html-table .meo-md-color-swatch-interactive') === swatch);
        scope.__cellUnitFrame = requestAnimationFrame(sample);
      };
      sample();
    });
    await page.keyboard.type('777', { delay: 40 });
    await new Promise(resolve => setTimeout(resolve, 700)); await frames(page, 6);
    const samples = await page.evaluate(() => { cancelAnimationFrame((window as any).__cellUnitFrame); return (window as any).__cellUnitFrames as boolean[]; });
    assert.ok(samples.length > 10 && samples.every(Boolean), label + ': unrelated cell controls retain their DOM through commit');
    assert.ok(host.readHost().includes('10777'), label + ': edited cell commits');
    // An earlier edit moves the same control's absolute source coordinates.
    // Keeping its old click handler would apply a color to stale source.
    await page.click('thead th:nth-child(1) .meo-md-html-table-cell-preview');
    await page.keyboard.press('End'); await page.keyboard.type('777');
    await new Promise(resolve => setTimeout(resolve, 700)); await frames(page, 6);
    assert.ok(await page.evaluate(() => document.querySelector('.meo-md-html-table .meo-md-color-swatch-interactive') === (window as any).__cellUnitSwatch), label + ': source movement only rebases control metadata');
    assert.equal(await page.$eval('.meo-md-html-table .meo-md-color-swatch-interactive', element => Number((element as HTMLElement).dataset.colorFrom)),
      host.readHost().indexOf('#60A5FA', host.readHost().indexOf('| beta')), label + ': refresh moved source coordinates');
    await page.click('.meo-md-html-table .meo-md-color-swatch-interactive');
    await page.click('.meo-hex-color-adjustment-value');
    await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
    await page.keyboard.type('#112233');
    await page.click('.meo-hex-color-adjustment-apply'); await frames(page, 8);
    assert.ok(host.readHost().includes('| beta #112233'), label + ': retained control edits the current cell');
    assert.ok(host.readHost().includes('**Editable color** #60A5FA'), label + ': unrelated source remains intact');
    assert.deepEqual(host.errors, []);
    cases++;
  } finally { host.dispose(); await page.close(); }
}

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
  } catch (error) { throw new Error(label, { cause: error }); }
  finally { host.dispose(); await page.close(); }
}

async function tableCase(large: boolean, command: string, selected = false) {
  const page = await browser.newPage(), host = await prepare(page, large);
  const label = `table ${command} large ${large}${selected ? '/selected-cell' : ''}`;
  try {
    await page.click('tbody tr:nth-child(2) td:nth-child(2) .meo-md-html-table-cell-preview');
    await page.keyboard.press('End');
    if (selected) await page.evaluate(() => (document.activeElement as HTMLTextAreaElement).setSelectionRange(0, 2, 'backward'));
    // Pending native text and the command are accepted by one atomic
    // transaction. Undo restores its last confirmed source/cell state.
    const cellBefore = await captureHistoryInteraction(page, { witness: 'Controls' });
    if (!selected) await page.keyboard.type('777'); // Also retire an existing native-input viewport owner.
    await frames(page, 5);
    const before = await page.evaluate(() => (window as any).__commandView.state.doc.toString());
    let beforeInteraction: HistoryInteractionState;
    const clip = await observe(page);
    await assertStablePaint(page, clip, async () => {
      await page.click('.meo-md-html-table-context-trigger');
      if (/^(move|align|sort)-/.test(command)) await page.click('[data-page-action="next"]');
      const selector = `[data-command="${command}"]`;
      assert.equal(await page.$eval(selector, element => (element as HTMLButtonElement).disabled), false, label + ': enabled command');
      if (command === 'delete-table') await page.click(selector); // First click only confirms.
      beforeInteraction = await captureHistoryAction(page, { witness: 'Controls' }, selector);
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
    const afterInteraction = await captureHistoryInteraction(page, { witness: 'Controls' });
    // This fixture appends pending text at End. The source at the actual
    // command boundary decides whether it belongs to this atomic undo step.
    const acceptedCell = beforeInteraction!.text.split('\n')[cellBefore.focus.sourceLine! - 1].split('|')[Number(cellBefore.focus.col) + 1].trim();
    beforeInteraction!.focus = selected ? cellBefore.focus : { ...cellBefore.focus, value: acceptedCell, from: acceptedCell.length, to: acceptedCell.length };
    await assertHistoryRoundTrip(page, { witness: 'Controls', label, before: beforeInteraction!, after: afterInteraction,
      observePaint: (action, direction) => assertStableHistoryPaint(page, clip, action, label + '/' + direction) }); historyReceipts.push(label);
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
  const onlyColor = process.argv.includes('--color-only');
  const onlyCellPreview = process.argv.includes('--cell-preview');
  const onlyTableHistory = process.argv.includes('--table-history-only');
  const onlyAction = process.argv.find(arg => arg.startsWith('--action='))?.slice(9);
  const expectedHistory = [
    ...(!onlyColor && !onlyCellPreview && !onlyTableHistory && (!onlyAction || onlyAction === 'checkbox')
      ? [false, true].map(large => `task interaction large ${large} nested false/body-selection`) : []),
    ...((!process.argv.includes('--local-units') && !onlyCellPreview || onlyTableHistory) && !onlyColor
      ? [false, true].flatMap(large => commands.flatMap(command => [`table ${command} large ${large}`,
          ...(command === 'move-row-down' ? [`table ${command} large ${large}/selected-cell`] : [])])) : [])
  ];
  if (!onlyColor && !onlyCellPreview && !onlyTableHistory) {
    if (!onlyAction || onlyAction === 'checkbox') for (const large of [false, true]) for (const nested of [false, true]) await taskInteractionCase(large, nested);
    if (!onlyAction || onlyAction === 'checkbox' || onlyAction === 'task-backspace') for (const large of [false, true]) for (const action of ['Backspace', 'Enter', 'StartEnter', 'Tab', 'Outdent'] as const) await richTaskBackspaceCase(large, action);
    for (const large of [false, true]) for (const action of ['checkbox', 'bulletList', 'numberedList', 'task', 'quote', 'heading'].filter(action => !onlyAction || onlyAction === action)) await localUnitCase(large, action);
    if (!onlyAction || onlyAction === 'bulletList') for (const large of [false, true]) await localUnitCase(large, 'bulletList', true);
    if (!onlyAction) for (const large of [false, true]) await columnFrameCase(large);
  }
  if (!onlyColor && !onlyAction && !onlyTableHistory) for (const large of [false, true]) await cellPreviewUnitCase(large);
  if ((!process.argv.includes('--local-units') && !onlyCellPreview) || onlyTableHistory) {
  for (const large of [false, true]) {
    if (!onlyTableHistory) {
      for (const inTable of [false, true]) for (const apply of [false, true]) await colorCase(large, inTable, apply);
      for (const apply of [false, true]) await colorCase(large, true, apply, true);
    }
    if (!onlyColor) for (const command of commands) {
      await tableCase(large, command);
      if (command === 'move-row-down') await tableCase(large, command, true);
    }
  }
  if (!onlyColor && !onlyTableHistory) for (const command of ['insert-row-below', 'align-center', 'sort-descending', 'delete-table']) await longTableCase(command);
  }
  assertHistoryCoverage(expectedHistory);
  console.log(`Live command presentation passed: ${cases} cases, ${observedPaints} compositor frames; ${historyReceipts.length} complete history contracts`);
} catch (error) { failure = error; throw error; }
finally {
  server.stop(true);
  if (failure === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, failure);
}
