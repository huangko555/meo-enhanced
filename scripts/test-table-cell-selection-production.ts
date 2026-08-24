import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-cell-selection-'));
const source = [
  '| A&B | <tag> |',
  '| --- | --- |',
  '| **bold &** <img src=x onerror=alert(1)> | apostrophe\'s |',
  '| r2a | r2b |',
  '',
  'outside',
  '',
  '| C | D |',
  '| --- | --- |',
  '| c1 | d1 |',
  '| c2 | d2 |'
].join('\n');

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
    await page.setViewport({ width: 1000, height: 700 });
    await page.setContent('<!doctype html><button id="outside">outside</button><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate((text) => {
      (window as any).__selectionEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
    }, source);
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table-shell').length === 2);
    await page.evaluate(() => {
      document.querySelectorAll<HTMLElement>('.meo-md-html-table-shell').forEach((shell, index) => {
        shell.dataset.testTable = String(index);
      });
    });

    const rect = async (selector: string) => {
      const value = await page.$eval(selector, (element) => {
        const box = element.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      });
      return value;
    };
    const drag = async (from: string, to: string, hold = false) => {
      const start = await rect(from);
      const end = await rect(to);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 4 });
      const selected = await page.$$eval('.meo-md-html-table-cell-selected', (elements) => elements.length);
      if (selected <= 1) throw new Error(`drag ${from} -> ${to} selected ${selected} cells`);
      if (!hold) await page.mouse.up();
    };

    const first = '.meo-md-html-table-shell[data-test-table="0"] tbody tr:first-child td:first-child .meo-md-html-table-cell-preview';
    const last = '.meo-md-html-table-shell[data-test-table="0"] tbody tr:nth-child(2) td:nth-child(2) .meo-md-html-table-cell-preview';
    await drag(first, last);
    const persisted = await page.evaluate(() => ({
      count: document.querySelectorAll('.meo-md-html-table-cell-selected').length,
      active: document.activeElement?.tagName
    }));
    if (persisted.count !== 4 || persisted.active !== 'TABLE') {
      throw new Error(`pointerup did not persist the visible rectangle: ${JSON.stringify(persisted)}`);
    }

    await page.evaluate(() => {
      (window as any).__selectionClipboard = null;
      document.addEventListener('copy', (event) => {
        (window as any).__selectionClipboard = {
          types: Array.from(event.clipboardData?.types ?? []),
          plain: event.clipboardData?.getData('text/plain') ?? '',
          html: event.clipboardData?.getData('text/html') ?? ''
        };
      }, { capture: true, once: true });
    });
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyC');
    await page.keyboard.up('Control');
    const copied = await page.evaluate(() => (window as any).__selectionClipboard);
    const expectedPlain = '**bold &** <img src=x onerror=alert(1)>\tapostrophe\'s\nr2a\tr2b';
    const expectedHtml = '<table><tr><td><strong>bold &amp;</strong> &lt;img src=x onerror=alert(1)&gt;</td><td>apostrophe&#39;s</td></tr><tr><td>r2a</td><td>r2b</td></tr></table>';
    if (copied?.plain !== expectedPlain || copied?.html !== expectedHtml || !copied.types.includes('text/plain') || !copied.types.includes('text/html')) {
      throw new Error(`Ctrl+C clipboard payload was incomplete: ${JSON.stringify(copied)}`);
    }

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table-cell-selected').length === 0);
    const sameCell = await rect(`${first} [data-meo-source-from]`);
    await page.mouse.move(sameCell.x - 8, sameCell.y);
    await page.mouse.down();
    await page.mouse.move(sameCell.x + 8, sameCell.y, { steps: 4 });
    await page.mouse.up();
    const textSelection = await page.evaluate(() => {
      const input = document.activeElement as HTMLTextAreaElement | null;
      return { tag: input?.tagName, selected: (input?.selectionEnd ?? 0) - (input?.selectionStart ?? 0), cells: document.querySelectorAll('.meo-md-html-table-cell-selected').length };
    });
    if (textSelection.tag !== 'TEXTAREA' || textSelection.selected < 1 || textSelection.cells !== 0) {
      throw new Error(`same-cell drag did not prefer ordinary text: ${JSON.stringify(textSelection)}`);
    }

    await page.evaluate(() => {
      (window as any).__selectionEscapePrevented = null;
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          (window as any).__selectionEscapePrevented = event.defaultPrevented;
        }
      }, { capture: true, once: true });
    });
    await page.keyboard.press('Escape');
    const persistedSingleEscape = await page.evaluate(() => ({
      prevented: (window as any).__selectionEscapePrevented,
      interacting: Boolean(document.querySelector('.meo-md-html-table-shell[data-test-table="0"]')?.classList.contains('is-interacting')),
      nativeText: document.getSelection()?.toString() ?? ''
    }));
    if (!persistedSingleEscape.prevented || persistedSingleEscape.interacting || persistedSingleEscape.nativeText) {
      throw new Error(`persisted same-cell Escape was not Module-owned: ${JSON.stringify(persistedSingleEscape)}`);
    }

    await page.click('#outside');
    await page.waitForFunction((selector) => {
      const preview = document.querySelector<HTMLElement>(selector);
      return preview?.isConnected && getComputedStyle(preview).visibility === 'visible';
    }, {}, first);
    await page.evaluate(() => {
      const table = document.querySelector<HTMLTableElement>('.meo-md-html-table-shell[data-test-table="0"] table')!;
      const nativeRelease = table.releasePointerCapture.bind(table);
      (window as any).__sameCellEscape = { released: [] as number[], nativeRelease };
      table.releasePointerCapture = (pointerId: number) => {
        (window as any).__sameCellEscape.released.push(pointerId);
        nativeRelease(pointerId);
      };
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          (window as any).__sameCellEscape.prevented = event.defaultPrevented;
        }
      }, { capture: true, once: true });
    });
    const activeEscapeStart = await rect(`${first} [data-meo-source-from]`);
    await page.mouse.move(activeEscapeStart.x - 8, activeEscapeStart.y);
    await page.mouse.down();
    await page.mouse.move(activeEscapeStart.x + 8, activeEscapeStart.y, { steps: 4 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    const activeSameCellEscape = await page.evaluate(() => {
      const table = document.querySelector<HTMLTableElement>('.meo-md-html-table-shell[data-test-table="0"] table')!;
      const facts = (window as any).__sameCellEscape;
      table.releasePointerCapture = facts.nativeRelease;
      return {
        released: facts.released,
        prevented: facts.prevented,
        captured: table.hasPointerCapture?.(1) ?? false,
        interacting: Boolean(table.closest('.meo-md-html-table-shell')?.classList.contains('is-interacting')),
        nativeText: document.getSelection()?.toString() ?? ''
      };
    });
    if (
      JSON.stringify(activeSameCellEscape.released) !== JSON.stringify([1]) ||
      !activeSameCellEscape.prevented ||
      activeSameCellEscape.captured ||
      activeSameCellEscape.interacting ||
      activeSameCellEscape.nativeText
    ) {
      throw new Error(`active same-cell Escape cleanup failed: ${JSON.stringify(activeSameCellEscape)}`);
    }

    await page.click('#outside');
    await page.waitForFunction((selector) => {
      const preview = document.querySelector<HTMLElement>(selector);
      return preview?.isConnected && getComputedStyle(preview).visibility === 'visible';
    }, {}, first);
    const ownerStart = await rect(`${first} [data-meo-source-from]`);
    await page.mouse.move(ownerStart.x - 8, ownerStart.y);
    await page.mouse.down();
    await page.mouse.move(ownerStart.x + 8, ownerStart.y, { steps: 4 });
    const secondPointer = await page.evaluate(async () => {
      const cell = document.querySelector<HTMLTableCellElement>(
        '.meo-md-html-table-shell[data-test-table="0"] tbody tr:first-child td:nth-child(2)'
      )!;
      const preview = cell.querySelector<HTMLElement>('.meo-md-html-table-cell-preview')!;
      const input = cell.querySelector<HTMLTextAreaElement>('textarea')!;
      const box = preview.getBoundingClientRect();
      const selection = document.getSelection();
      const ranges = Array.from({ length: selection?.rangeCount ?? 0 }, (_value, index) => (
        selection!.getRangeAt(index).cloneRange()
      ));
      const originalRemoveAllRanges = Selection.prototype.removeAllRanges;
      let removeAllRangesCalls = 0;
      Selection.prototype.removeAllRanges = function () {
        removeAllRangesCalls += 1;
        return originalRemoveAllRanges.call(this);
      };
      const before = {
        text: selection?.toString() ?? '',
        selected: document.querySelectorAll('.meo-md-html-table-cell-selected').length
      };
      const styleMutations: string[] = [];
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          styleMutations.push(`${(record.target as Element).className}:${record.attributeName}`);
        }
      });
      observer.observe(input, { attributes: true, attributeFilter: ['style'] });
      observer.observe(preview, { attributes: true, attributeFilter: ['style'] });
      const dispatch = (target: Element, type: 'pointerdown' | 'pointermove' | 'pointerup', pointerId: number) => {
        const event = new PointerEvent(type, {
          pointerId,
          pointerType: 'touch',
          isPrimary: false,
          button: 0,
          bubbles: true,
          cancelable: true,
          clientX: box.left + box.width / 2,
          clientY: box.top + box.height / 2
        });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      };
      let defaultPrevented: boolean[] = [];
      try {
        defaultPrevented = [
          dispatch(preview, 'pointerdown', 2),
          dispatch(preview, 'pointermove', 2),
          dispatch(preview, 'pointerup', 2),
          dispatch(input, 'pointerdown', 3)
        ];
        await Promise.resolve();
      } finally {
        observer.disconnect();
        Selection.prototype.removeAllRanges = originalRemoveAllRanges;
      }
      // Synthetic pointerdown performs a browser default selection collapse that
      // a physical secondary touch does not. Restore only that synthetic default;
      // an Adapter call to removeAllRanges remains observable and fails below.
      if (removeAllRangesCalls === 0 && selection?.rangeCount === 0) {
        for (const range of ranges) selection.addRange(range);
      }
      return {
        before,
        after: {
          text: selection?.toString() ?? '',
          selected: document.querySelectorAll('.meo-md-html-table-cell-selected').length
        },
        removeAllRangesCalls,
        defaultPrevented,
        styleMutations,
        capturedSecondPointer: document.querySelector<HTMLTableElement>(
          '.meo-md-html-table-shell[data-test-table="0"] table'
        )!.hasPointerCapture?.(2) || document.querySelector<HTMLTableElement>(
          '.meo-md-html-table-shell[data-test-table="0"] table'
        )!.hasPointerCapture?.(3) || false
      };
    });
    if (
      !secondPointer.before.text ||
      secondPointer.after.text !== secondPointer.before.text ||
      secondPointer.after.selected !== secondPointer.before.selected ||
      secondPointer.removeAllRangesCalls !== 0 ||
      secondPointer.defaultPrevented.some(Boolean) ||
      secondPointer.styleMutations.length !== 0 ||
      secondPointer.capturedSecondPointer
    ) {
      throw new Error(`second pointer changed the active pointer transaction: ${JSON.stringify(secondPointer)}`);
    }
    await page.mouse.up();
    const ownerCommit = await page.evaluate(() => {
      const input = document.activeElement as HTMLTextAreaElement | null;
      return {
        tag: input?.tagName,
        selected: (input?.selectionEnd ?? 0) - (input?.selectionStart ?? 0)
      };
    });
    if (ownerCommit.tag !== 'TEXTAREA' || ownerCommit.selected < 1) {
      throw new Error(`second pointer prevented the owner pointerup: ${JSON.stringify(ownerCommit)}`);
    }
    await page.click('button[title="Delete column"]');
    await page.waitForFunction(() => (window as any).__selectionEditor.getText().startsWith('| <tag> |'));
    await page.evaluate((text) => (window as any).__selectionEditor.setText(text), source);
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table-shell').length === 2);
    await page.evaluate(() => {
      document.querySelectorAll<HTMLElement>('.meo-md-html-table-shell').forEach((shell, index) => {
        shell.dataset.testTable = String(index);
      });
    });

    await page.click('#outside');
    await page.waitForFunction(() => document.activeElement?.id === 'outside');
    await page.waitForFunction((selector) => {
      const preview = document.querySelector<HTMLElement>(selector);
      return preview?.isConnected && getComputedStyle(preview).visibility === 'visible';
    }, {}, first);
    await drag(last, first);
    const reverseCount = await page.$$eval('.meo-md-html-table-cell-selected', (elements) => elements.length);
    if (reverseCount !== 4) throw new Error(`reverse drag selected ${reverseCount} cells`);
    await page.click('#outside');
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table-cell-selected').length === 0);
    await page.waitForFunction((selector) => {
      const preview = document.querySelector<HTMLElement>(selector);
      return preview?.isConnected && getComputedStyle(preview).visibility === 'visible';
    }, {}, first);

    const beginCapturedDrag = async () => {
      await page.evaluate(() => {
        const table = document.querySelector<HTMLTableElement>(
          '.meo-md-html-table-shell[data-test-table="0"] table'
        )!;
        const nativeRelease = table.releasePointerCapture.bind(table);
        (window as any).__selectionCapture = { table, released: [] as number[], nativeRelease };
        table.releasePointerCapture = (pointerId: number) => {
          (window as any).__selectionCapture.released.push(pointerId);
          nativeRelease(pointerId);
        };
      });
      await drag(first, last, true);
      const captured = await page.evaluate(() => {
        const facts = (window as any).__selectionCapture;
        return facts.table.hasPointerCapture?.(1) ?? false;
      });
      if (!captured) throw new Error('real drag did not establish pointer capture');
    };
    const assertCaptureCleared = async (reason: string) => {
      const facts = await page.evaluate(() => {
        const capture = (window as any).__selectionCapture;
        const table = capture.table as HTMLTableElement;
        table.releasePointerCapture = capture.nativeRelease;
        return {
          released: capture.released,
          captured: table.hasPointerCapture?.(1) ?? false,
          selected: table.querySelectorAll('.meo-md-html-table-cell-selected').length,
          interacting: Boolean(table.closest('.meo-md-html-table-shell')?.classList.contains('is-interacting')),
          nativeText: document.getSelection()?.toString() ?? ''
        };
      });
      if (
        JSON.stringify(facts.released) !== JSON.stringify([1]) ||
        facts.captured ||
        facts.selected ||
        facts.interacting ||
        facts.nativeText
      ) {
        throw new Error(`${reason} did not complete active capture cleanup: ${JSON.stringify(facts)}`);
      }
    };

    await beginCapturedDrag();
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await assertCaptureCleared('Escape');

    await beginCapturedDrag();
    await page.evaluate((text) => (window as any).__selectionEditor.setText(text), source);
    await page.mouse.up();
    await assertCaptureCleared('same-text external presentation');

    await beginCapturedDrag();
    const outside = await rect('#outside');
    await page.mouse.move(outside.x, outside.y, { steps: 2 });
    await page.mouse.up();
    await assertCaptureCleared('outside pointerup');

    await beginCapturedDrag();
    await page.evaluate(() => {
      const target = document.querySelector<HTMLElement>(
        '.meo-md-html-table-shell[data-test-table="1"] tbody tr:first-child td:first-child'
      )!;
      const box = target.getBoundingClientRect();
      target.dispatchEvent(new PointerEvent('pointerdown', {
        pointerId: 2,
        pointerType: 'touch',
        isPrimary: false,
        button: 0,
        bubbles: true,
        cancelable: true,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2
      }));
      target.dispatchEvent(new PointerEvent('pointercancel', {
        pointerId: 2, pointerType: 'touch', bubbles: true, cancelable: true
      }));
    });
    await page.mouse.up();
    await assertCaptureCleared('cross-table transfer');

    const secondFirst = '.meo-md-html-table-shell[data-test-table="1"] tbody tr:first-child td:first-child .meo-md-html-table-cell-preview';
    const secondLast = '.meo-md-html-table-shell[data-test-table="1"] tbody tr:nth-child(2) td:nth-child(2) .meo-md-html-table-cell-preview';
    await drag(first, last);
    await drag(secondFirst, secondLast);
    const tableSelections = await page.$$eval('.meo-md-html-table-shell', (shells) => shells.map((shell) => shell.querySelectorAll('.meo-md-html-table-cell-selected').length));
    if (JSON.stringify(tableSelections) !== JSON.stringify([0, 4])) {
      throw new Error(`cross-table transfer retained the old owner: ${JSON.stringify(tableSelections)}`);
    }

    for (const type of ['pointercancel', 'lostpointercapture'] as const) {
      await page.keyboard.press('Escape');
      await drag(first, last, true);
      await page.evaluate((eventType) => {
        document.querySelector('.meo-md-html-table-shell table')!.dispatchEvent(new PointerEvent(eventType, {
          pointerId: 2, bubbles: true, cancelable: true
        }));
      }, type);
      const afterForeignBoundary = await page.$$eval('.meo-md-html-table-cell-selected', (elements) => elements.length);
      if (afterForeignBoundary !== 4) {
        throw new Error(`${type} from a non-owner cleared ${afterForeignBoundary} selected cells`);
      }
      await page.mouse.up();
      const afterOwnerUp = await page.$$eval('.meo-md-html-table-cell-selected', (elements) => elements.length);
      if (afterOwnerUp !== 4) throw new Error(`${type} from a non-owner prevented owner pointerup persistence`);

      await page.keyboard.press('Escape');
      await drag(first, last, true);
      await page.evaluate((eventType) => {
        document.querySelector('.meo-md-html-table-shell table')!.dispatchEvent(new PointerEvent(eventType, {
          pointerId: 1, bubbles: true, cancelable: true
        }));
      }, type);
      await page.mouse.up();
      const count = await page.$$eval('.meo-md-html-table-cell-selected', (elements) => elements.length);
      if (count !== 0) throw new Error(`${type} retained ${count} selected cells`);
    }

    await drag(first, last);
    await page.evaluate((text) => {
      (window as any).__externalTable = document.querySelector('.meo-md-html-table-shell[data-test-table="0"] table');
      (window as any).__selectionEditor.setText(text);
    }, source);
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table-cell-selected').length === 0);
    const externalPresentation = await page.evaluate(() => ({
      sameTable: (window as any).__externalTable === document.querySelector('.meo-md-html-table-shell[data-test-table="0"] table'),
      connected: Boolean((window as any).__externalTable?.isConnected)
    }));
    if (!externalPresentation.sameTable || !externalPresentation.connected) {
      throw new Error(`same-text external presentation replaced table DOM: ${JSON.stringify(externalPresentation)}`);
    }

    await drag(first, last);
    await page.evaluate(() => {
      (window as any).__replacementTable = document.querySelector('.meo-md-html-table-shell[data-test-table="0"] table');
      (window as any).__selectionEditor.setText('| X | Y |\n| --- | --- |\n| one | two |');
    });
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table-cell-selected').length === 0);
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('tbody textarea')?.value === 'one');
    const replacement = await page.evaluate(() => ({
      oldConnected: Boolean((window as any).__replacementTable?.isConnected),
      replaced: (window as any).__replacementTable !== document.querySelector('.meo-md-html-table-shell table')
    }));
    if (replacement.oldConnected || !replacement.replaced) {
      throw new Error(`replacement lifecycle was not distinct: ${JSON.stringify(replacement)}`);
    }

    await drag(
      '.meo-md-html-table-shell tbody tr:first-child td:first-child .meo-md-html-table-cell-preview',
      '.meo-md-html-table-shell tbody tr:first-child td:nth-child(2) .meo-md-html-table-cell-preview'
    );
    await page.evaluate(() => (window as any).__selectionEditor.setMode('source'));
    await page.waitForFunction(() => !document.querySelector('.meo-md-html-table-shell'));
    await page.evaluate(() => (window as any).__selectionEditor.setMode('live'));
    await page.waitForFunction(() => document.querySelector('.meo-md-html-table-shell'));
    const afterMode = await page.$$eval('.meo-md-html-table-cell-selected', (elements) => elements.length);
    if (afterMode !== 0) throw new Error(`mode replacement restored ${afterMode} stale selected cells`);

    await drag(
      '.meo-md-html-table-shell tbody tr:first-child td:first-child .meo-md-html-table-cell-preview',
      '.meo-md-html-table-shell tbody tr:first-child td:nth-child(2) .meo-md-html-table-cell-preview',
      true
    );
    const afterDestroy = await page.evaluate(() => {
      const table = document.querySelector<HTMLTableElement>('.meo-md-html-table-shell table')!;
      (window as any).__lateTable = table;
      const released: number[] = [];
      const nativeRelease = table.releasePointerCapture.bind(table);
      table.releasePointerCapture = (pointerId: number) => {
        released.push(pointerId);
        nativeRelease(pointerId);
      };
      (window as any).__selectionEditor.destroy();
      const before = table.outerHTML;
      const clipboard = new DataTransfer();
      const copy = new ClipboardEvent('copy', { clipboardData: clipboard, bubbles: true, cancelable: true });
      document.dispatchEvent(copy);
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        table.dispatchEvent(new PointerEvent(type, { pointerId: 1, bubbles: true, cancelable: true }));
      }
      return {
        connected: table.isConnected,
        selected: table.querySelectorAll('.meo-md-html-table-cell-selected').length,
        unchanged: table.outerHTML === before,
        copyPrevented: copy.defaultPrevented,
        clipboardTypes: Array.from(clipboard.types),
        retainedCapture: table.hasPointerCapture?.(1) ?? false,
        released
      };
    });
    await page.mouse.up();
    if (
      afterDestroy.connected ||
      afterDestroy.selected ||
      !afterDestroy.unchanged ||
      afterDestroy.copyPrevented ||
      afterDestroy.clipboardTypes.length ||
      afterDestroy.retainedCapture ||
      JSON.stringify(afterDestroy.released) !== JSON.stringify([1])
    ) {
      throw new Error(`destroy leaked late pointer/copy effects: ${JSON.stringify(afterDestroy)}`);
    }

    await page.evaluate(() => {
      (window as any).__selectionEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text: '| A | B |\n| --- | --- |\n| one | two |',
        initialMode: 'live',
        onApplyChanges() {}
      });
    });
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table-shell').length === 1);
    await drag(
      '.meo-md-html-table-shell tbody tr:first-child td:first-child .meo-md-html-table-cell-preview',
      '.meo-md-html-table-shell tbody tr:first-child td:nth-child(2) .meo-md-html-table-cell-preview',
      true
    );
    const faultedDestroy = await page.evaluate(() => {
      const table = document.querySelector<HTMLTableElement>('.meo-md-html-table-shell table')!;
      const laterImageOwner = document.createElement('span');
      laterImageOwner.className = 'meo-md-image';
      let laterImageOwnerRuns = 0;
      laterImageOwner.addEventListener('meo-dispose-image-presentation', () => { laterImageOwnerRuns += 1; });
      table.append(laterImageOwner);
      const nativeRemoveAllRanges = Selection.prototype.removeAllRanges;
      const nativeRelease = table.releasePointerCapture.bind(table);
      let removeAllRangesCalls = 0;
      table.releasePointerCapture = () => {
        throw new Error('controlled release failure');
      };
      Selection.prototype.removeAllRanges = function () {
        nativeRemoveAllRanges.call(this);
        removeAllRangesCalls += 1;
        if (removeAllRangesCalls === 1) throw new Error('controlled primary cleanup failure');
      };
      let observed: unknown = null;
      try {
        (window as any).__selectionEditor.destroy();
      } catch (error) {
        observed = error;
      } finally {
        Selection.prototype.removeAllRanges = nativeRemoveAllRanges;
        table.releasePointerCapture = nativeRelease;
      }

      const clipboard = new DataTransfer();
      const copy = new ClipboardEvent('copy', { clipboardData: clipboard, bubbles: true, cancelable: true });
      document.dispatchEvent(copy);
      table.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true, cancelable: true }));
      const aggregate = observed instanceof AggregateError ? observed : null;
      return {
        errorName: observed instanceof Error ? observed.name : typeof observed,
        errors: aggregate?.errors.map((error) => error instanceof Error ? error.message : String(error)) ?? [],
        cause: aggregate?.cause instanceof Error ? aggregate.cause.message : String(aggregate?.cause ?? ''),
        laterImageOwnerRuns,
        connected: table.isConnected,
        selected: table.querySelectorAll('.meo-md-html-table-cell-selected').length,
        interacting: Boolean(table.closest('.meo-md-html-table-shell')?.classList.contains('is-interacting')),
        removeAllRangesCalls,
        copyPrevented: copy.defaultPrevented,
        clipboardTypes: Array.from(clipboard.types)
      };
    });
    await page.mouse.up();
    if (
      faultedDestroy.errorName !== 'AggregateError' ||
      JSON.stringify(faultedDestroy.errors) !== JSON.stringify([
        'controlled primary cleanup failure',
        'controlled release failure'
      ]) ||
      faultedDestroy.cause !== 'controlled primary cleanup failure' ||
      faultedDestroy.laterImageOwnerRuns !== 0 ||
      !faultedDestroy.connected ||
      faultedDestroy.selected ||
      faultedDestroy.interacting ||
      faultedDestroy.removeAllRangesCalls < 1 ||
      faultedDestroy.copyPrevented ||
      faultedDestroy.clipboardTypes.length
    ) {
      throw new Error(`release failure masked primary or skipped cleanup: ${JSON.stringify(faultedDestroy)}`);
    }

    for (const fault of ['image', 'sticky', 'listeners', 'interaction'] as const) {
      await page.evaluate((text) => {
        document.getElementById('app')!.replaceChildren();
        const nativeQueueMicrotask = window.queueMicrotask.bind(window);
        const harness = {
          active: false,
          queueCalls: 0,
          nativeQueueMicrotask
        };
        (window as any).__destroyOwnerFault = harness;
        window.queueMicrotask = (callback) => {
          if (harness.active) {
            harness.queueCalls += 1;
            if ((window as any).__destroyOwnerFaultKind === 'command') {
              throw new Error('controlled command owner failure');
            }
          }
          return nativeQueueMicrotask(callback);
        };
        (window as any).__selectionEditor = (window as any).TableStabilityHarness.createEditor({
          parent: document.getElementById('app')!,
          text,
          initialMode: 'live',
          onApplyChanges() {}
        });
      }, '| A | B |\n| --- | --- |\n| one | two |');
      await page.waitForFunction(() => document.querySelector('.meo-md-html-table-shell table'));
      const ownerFault = await page.evaluate((faultKind) => {
        const editor = (window as any).__selectionEditor;
        const harness = (window as any).__destroyOwnerFault;
        const table = document.querySelector<HTMLTableElement>('.meo-md-html-table-shell table')!;
        const input = table.querySelector<HTMLTextAreaElement>('textarea')!;
        const nativeWindowRemove = window.removeEventListener.bind(window);
        const nativeRemove = EventTarget.prototype.removeEventListener;
        const nativeDispatch = EventTarget.prototype.dispatchEvent;
        const nativeMapGet = Map.prototype.get;
        const nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
        const nativeClearTimeout = window.clearTimeout.bind(window);
        const nativeSetTimeout = window.setTimeout.bind(window);
        const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
        const counters = { sticky: 0, listeners: 0, frame: 0, interaction: 0 };
        let interactionTimer: number | undefined;

        window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
          if (harness.active && type === 'resize') {
            counters.sticky += 1;
            if (faultKind === 'sticky') throw new Error('controlled sticky owner failure');
          }
          nativeWindowRemove(type, listener, options);
        }) as typeof window.removeEventListener;
        EventTarget.prototype.removeEventListener = function (type, listener, options) {
          if (harness.active && this === table) {
            counters.listeners += 1;
            if (faultKind === 'listeners') throw new Error('controlled listeners owner failure');
          }
          return nativeRemove.call(this, type, listener, options);
        };
        EventTarget.prototype.dispatchEvent = function (event) {
          if (
            harness.active &&
            faultKind === 'image' &&
            event.type === 'meo-dispose-image-presentation' &&
            this instanceof Element &&
            this.classList.contains('meo-md-image')
          ) {
            throw new Error('controlled image owner failure');
          }
          return nativeDispatch.call(this, event);
        };
        Map.prototype.get = function (key) {
          if (harness.active && typeof key === 'string' && key.startsWith('table-command-target-')) {
            harness.queueCalls += 1;
            if (faultKind === 'command') throw new Error('controlled command owner failure');
          }
          return nativeMapGet.call(this, key);
        };
        window.cancelAnimationFrame = (handle) => {
          if (harness.active && handle === 4242) {
            counters.frame += 1;
            if (faultKind === 'frame') throw new Error('controlled frame owner failure');
          }
          nativeCancelAnimationFrame(handle);
        };
        window.clearTimeout = ((handle?: number) => {
          if (harness.active && handle === interactionTimer) {
            counters.interaction += 1;
            if (faultKind === 'interaction') throw new Error('controlled interaction owner failure');
          }
          nativeClearTimeout(handle);
        }) as typeof window.clearTimeout;

        window.requestAnimationFrame = () => 4242;
        window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
          interactionTimer = nativeSetTimeout(handler, timeout, ...args);
          return interactionTimer;
        }) as typeof window.setTimeout;
        input.value = 'changed';
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'd' }));
        window.setTimeout = nativeSetTimeout;
        window.requestAnimationFrame = nativeRequestAnimationFrame;

        if (faultKind === 'image') {
          const image = document.createElement('span');
          image.className = 'meo-md-image';
          image.addEventListener('meo-dispose-image-presentation', () => {
            throw new Error('controlled image owner failure');
          });
          table.append(image);
        }
        (window as any).__destroyOwnerFaultKind = faultKind;
        harness.active = true;
        let observed: unknown = null;
        try {
          editor.destroy();
        } catch (error) {
          observed = error;
        } finally {
          harness.active = false;
          window.queueMicrotask = harness.nativeQueueMicrotask;
          window.removeEventListener = nativeWindowRemove;
          EventTarget.prototype.removeEventListener = nativeRemove;
          EventTarget.prototype.dispatchEvent = nativeDispatch;
          Map.prototype.get = nativeMapGet;
          window.cancelAnimationFrame = nativeCancelAnimationFrame;
          window.clearTimeout = nativeClearTimeout;
          window.setTimeout = nativeSetTimeout;
          window.requestAnimationFrame = nativeRequestAnimationFrame;
        }
        return {
          message: observed instanceof Error ? observed.message : String(observed),
          connected: table.isConnected,
          queueCalls: harness.queueCalls,
          ...counters
        };
      }, fault);
      const expectedMessage = `controlled ${fault} owner failure`;
      if (ownerFault.message !== expectedMessage || !ownerFault.connected) {
        throw new Error(`${fault} owner did not preserve first-error DOM semantics: ${JSON.stringify(ownerFault)}`);
      }
      if (
        (fault === 'image' && (ownerFault.queueCalls || ownerFault.sticky || ownerFault.listeners || ownerFault.frame || ownerFault.interaction)) ||
        (fault === 'sticky' && (ownerFault.listeners || ownerFault.frame || ownerFault.interaction)) ||
        (fault === 'listeners' && (ownerFault.frame || ownerFault.interaction)) ||
        (fault === 'interaction' && ownerFault.interaction !== 1)
      ) {
        throw new Error(`${fault} owner ran a later destroy owner: ${JSON.stringify(ownerFault)}`);
      }
    }

    const commandPage = await browser.newPage();
    try {
      await commandPage.setContent('<!doctype html><div id="app"></div>');
      await commandPage.evaluate(() => {
        const nativeQueueMicrotask = window.queueMicrotask.bind(window);
        (window as any).__commandDestroyFault = { active: false, calls: 0, nativeQueueMicrotask };
        window.queueMicrotask = (callback) => {
          const harness = (window as any).__commandDestroyFault;
          if (harness.active) {
            harness.calls += 1;
            throw new Error('controlled command owner failure');
          }
          return nativeQueueMicrotask(callback);
        };
      });
      await commandPage.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
      await commandPage.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
      await commandPage.evaluate(() => {
        (window as any).__selectionEditor = (window as any).TableStabilityHarness.createEditor({
          parent: document.getElementById('app')!,
          text: '| A | B |\n| --- | --- |\n| one | two |',
          initialMode: 'live',
          onApplyChanges() {}
        });
      });
      await commandPage.waitForFunction(() => document.querySelector('.meo-md-html-table-shell table'));
      const commandFault = await commandPage.evaluate(() => {
        const harness = (window as any).__commandDestroyFault;
        const table = document.querySelector<HTMLTableElement>('.meo-md-html-table-shell table')!;
        const nativeWindowRemove = window.removeEventListener.bind(window);
        let laterStickyOwnerRuns = 0;
        window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
          if (harness.active && type === 'resize') laterStickyOwnerRuns += 1;
          nativeWindowRemove(type, listener, options);
        }) as typeof window.removeEventListener;
        harness.active = true;
        let observed: unknown = null;
        try {
          (window as any).__selectionEditor.setText('replacement');
        } catch (error) {
          observed = error;
        } finally {
          harness.active = false;
          window.queueMicrotask = harness.nativeQueueMicrotask;
          window.removeEventListener = nativeWindowRemove;
        }
        return {
          message: observed instanceof Error ? observed.message : String(observed),
          connected: table.isConnected,
          calls: harness.calls,
          laterStickyOwnerRuns
        };
      });
      if (
        commandFault.message !== 'controlled command owner failure' ||
        !commandFault.connected ||
        commandFault.calls !== 1 ||
        commandFault.laterStickyOwnerRuns !== 0
      ) {
        throw new Error(`command owner did not short-circuit later destroy owners: ${JSON.stringify(commandFault)}`);
      }
    } finally {
      await commandPage.close();
    }

    const framePage = await browser.newPage();
    try {
      await framePage.setContent('<!doctype html><div id="app"></div>');
      await framePage.evaluate(() => {
        const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
        const nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
        (window as any).__frameDestroyFault = {
          active: false,
          requests: 0,
          cancels: 0,
          nativeRequestAnimationFrame,
          nativeCancelAnimationFrame
        };
        window.requestAnimationFrame = () => {
          (window as any).__frameDestroyFault.requests += 1;
          return 4242;
        };
        window.cancelAnimationFrame = (handle) => {
          const harness = (window as any).__frameDestroyFault;
          if (harness.active && handle === 4242) {
            harness.cancels += 1;
            throw new Error('controlled frame owner failure');
          }
          nativeCancelAnimationFrame(handle);
        };
      });
      await framePage.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
      await framePage.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
      await framePage.evaluate(() => {
        (window as any).__selectionEditor = (window as any).TableStabilityHarness.createEditor({
          parent: document.getElementById('app')!,
          text: '| A | B |\n| --- | --- |\n| one | two |',
          initialMode: 'live',
          onApplyChanges() {}
        });
      });
      await framePage.waitForFunction(() => document.querySelector('.meo-md-html-table-shell table'));
      const frameFault = await framePage.evaluate(() => {
        const harness = (window as any).__frameDestroyFault;
        const table = document.querySelector<HTMLTableElement>('.meo-md-html-table-shell table')!;
        const nativeClearTimeout = window.clearTimeout.bind(window);
        let laterInteractionOwnerRuns = 0;
        window.clearTimeout = ((handle?: number) => {
          if (harness.active) laterInteractionOwnerRuns += 1;
          nativeClearTimeout(handle);
        }) as typeof window.clearTimeout;
        harness.active = true;
        let observed: unknown = null;
        try {
          (window as any).__selectionEditor.destroy();
        } catch (error) {
          observed = error;
        } finally {
          harness.active = false;
          window.requestAnimationFrame = harness.nativeRequestAnimationFrame;
          window.cancelAnimationFrame = harness.nativeCancelAnimationFrame;
          window.clearTimeout = nativeClearTimeout;
        }
        return {
          message: observed instanceof Error ? observed.message : String(observed),
          connected: table.isConnected,
          requests: harness.requests,
          cancels: harness.cancels,
          laterInteractionOwnerRuns
        };
      });
      if (
        frameFault.message !== 'controlled frame owner failure' ||
        !frameFault.connected ||
        frameFault.requests < 1 ||
        frameFault.cancels !== 1 ||
        frameFault.laterInteractionOwnerRuns !== 0
      ) {
        throw new Error(`frame owner did not short-circuit interaction owner: ${JSON.stringify(frameFault)}`);
      }
    } finally {
      await framePage.close();
    }
    console.log('table cell selection production checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
