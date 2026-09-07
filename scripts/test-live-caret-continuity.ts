import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-live-caret-continuity-'));

type CaretGeometry = {
  readonly blockHeight: number;
  readonly caretTop: number | null;
  readonly caretBottom: number | null;
  readonly defaultLineHeight: number;
  readonly viewportTop: number;
  readonly viewportBottom: number;
  readonly scrollTop: number;
  readonly visible: boolean;
};

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-live-layout-stability-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'webview.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  let primaryError: unknown;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 700, height: 360, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><body><div id="app"></div></body>');
    await page.addStyleTag({ content: 'html,body,#app{height:100%;margin:0}' });
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'webview.js') });

    const text = [
      ...Array.from({ length: 1_499 }, (_, index) => `普通正文 ${index + 1}`),
      `窗口底部 ${'A'.repeat(58)}`
    ].join('\n');
    await page.evaluate((initialText) => {
      (window as any).__editor = (window as any).LiveLayoutStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text: initialText,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, text);
    await page.waitForSelector('.cm-editor');

    await page.evaluate(async () => {
      const editor = (window as any).__editor;
      const view = editor.view;
      editor.scrollToLine(116, 'top');
      for (let index = 0; index < 4; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const target = view.state.doc.line(120);
      view.dispatch({ selection: { anchor: target.to } });
      view.focus();
      view.scrollDOM.scrollTop = Math.max(
        0,
        view.lineBlockAt(target.from).top - view.scrollDOM.clientHeight * 0.18
      );
      for (let index = 0; index < 4; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const enterBefore = await page.evaluate(() => {
      const view = (window as any).__editor.view;
      const target = view.state.doc.line(120);
      return {
        scrollTop: view.scrollDOM.scrollTop,
        targetTop: view.coordsAtPos(target.from)?.top ?? null
      };
    });
    await page.keyboard.press('Enter');
    await page.evaluate(async () => {
      for (let index = 0; index < 4; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const enterAfter = await page.evaluate(() => {
      const view = (window as any).__editor.view;
      const target = view.state.doc.line(120);
      const caret = view.coordsAtPos(view.state.selection.main.head);
      const viewport = view.scrollDOM.getBoundingClientRect();
      return {
        scrollTop: view.scrollDOM.scrollTop,
        targetTop: view.coordsAtPos(target.from)?.top ?? null,
        caretLine: view.state.doc.lineAt(view.state.selection.main.head).number,
        caretVisible: Boolean(caret && caret.top >= viewport.top && caret.bottom <= viewport.bottom)
      };
    });
    if (
      enterBefore.targetTop === null || enterAfter.targetTop === null ||
      Math.abs(enterAfter.scrollTop - enterBefore.scrollTop) > 0.5 ||
      Math.abs(enterAfter.targetTop - enterBefore.targetTop) > 0.5 ||
      enterAfter.caretLine !== 121 || !enterAfter.caretVisible
    ) {
      throw new Error(`Enter moved the viewport while the new caret remained visible: ${JSON.stringify({
        enterBefore,
        enterAfter
      })}`);
    }

    await page.click('.cm-content');
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    await page.evaluate(async () => {
      for (let index = 0; index < 6; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });

    const readCaret = (): Promise<CaretGeometry> => page.evaluate(() => {
      const editor = (window as any).__editor;
      const view = editor.view;
      const head = view.state.selection.main.head;
      const coords = view.coordsAtPos(head);
      const viewport = view.scrollDOM.getBoundingClientRect();
      return {
        blockHeight: view.lineBlockAt(head).height,
        caretTop: coords?.top ?? null,
        caretBottom: coords?.bottom ?? null,
        defaultLineHeight: view.defaultLineHeight,
        viewportTop: viewport.top,
        viewportBottom: viewport.bottom,
        scrollTop: view.scrollDOM.scrollTop,
        visible: Boolean(coords && coords.top >= viewport.top && coords.bottom <= viewport.bottom)
      };
    });

    const initial = await readCaret();
    let wrapped: CaretGeometry | null = null;
    for (let index = 0; index < 160; index += 1) {
      await page.keyboard.type('W');
      const current = await readCaret();
      if (current.blockHeight > initial.blockHeight + 1) {
        wrapped = current;
        break;
      }
      if (Math.abs(current.scrollTop - initial.scrollTop) > 0.5) {
        throw new Error(`Live input moved the viewport while the caret was still visible: ${JSON.stringify({
          initial,
          current
        })}`);
      }
    }
    if (!wrapped) throw new Error('Fixture did not produce a visual line wrap');

    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    const afterFirstFrame = await readCaret();
    if (!afterFirstFrame.visible) {
      throw new Error(`Live caret remained outside the viewport after wrapping: ${JSON.stringify({
        initial,
        wrapped,
        afterFirstFrame
      })}`);
    }
    if (
      afterFirstFrame.scrollTop > initial.scrollTop + 0.5 &&
      afterFirstFrame.caretBottom !== null &&
      afterFirstFrame.viewportBottom - afterFirstFrame.caretBottom < afterFirstFrame.defaultLineHeight - 2
    ) {
      throw new Error(`Live caret reveal did not preserve one visual line of context: ${JSON.stringify({
        initial,
        wrapped,
        afterFirstFrame
      })}`);
    }

    const numericBurstText = [
      ...Array.from({ length: 799 }, (_, index) => `数字前正文 ${index + 1}`),
      `数字输入目标 ${'1'.repeat(54)}`,
      ...Array.from({ length: 300 }, (_, index) => `数字后正文 ${index + 1}`)
    ].join('\n');
    await page.evaluate(async (nextText) => {
      const editor = (window as any).__editor;
      editor.setText(nextText, true);
      const view = editor.view;
      const target = nextText.indexOf('数字输入目标');
      const line = view.state.doc.lineAt(target);
      view.dispatch({ selection: { anchor: line.to } });
      view.focus();
      for (let index = 0; index < 6; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const coords = view.coordsAtPos(line.to);
      const viewport = view.scrollDOM.getBoundingClientRect();
      if (!coords) throw new Error('Could not measure numeric target caret');
      view.scrollDOM.scrollTop += coords.bottom - viewport.bottom + 2;
    }, numericBurstText);
    const burstBefore = await readCaret();
    await page.keyboard.type('1234567890'.repeat(24));
    const burstImmediate = await readCaret();
    await page.evaluate(async () => {
      for (let index = 0; index < 4; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const burstSettled = await readCaret();
    if (!burstSettled.visible) {
      throw new Error(`Rapid numeric Live input left the active line outside the viewport: ${JSON.stringify({
        burstBefore,
        burstImmediate,
        burstSettled
      })}`);
    }

    const formulaText = [
      ...Array.from({ length: 799 }, (_, index) => `公式前正文 ${index + 1}`),
      '$$',
      'x = 1',
      '$$',
      ...Array.from({ length: 300 }, (_, index) => `公式后正文 ${index + 1}`)
    ].join('\n');
    await page.evaluate((nextText) => (window as any).__editor.setText(nextText, true), formulaText);
    await page.evaluate(async () => {
      for (let index = 0; index < 6; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    await page.evaluate(() => {
      const editor = (window as any).__editor;
      const position = editor.getText().indexOf('x = 1');
      editor.view.dispatch({ selection: { anchor: position } });
      editor.view.dispatch({ effects: (window as any).EditorView?.scrollIntoView?.(position) ?? [] });
    });
    await page.waitForSelector('.meo-latex-math-mode-btn');
    await page.click('.meo-latex-math-mode-btn');
    await page.evaluate(async () => {
      for (let index = 0; index < 6; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const editor = (window as any).__editor;
      const block = document.querySelector<HTMLElement>('.meo-latex-math-editing-block')!;
      const innerView = (block as any).__meoLatexMathEditingController.innerView;
      const head = innerView.state.doc.length;
      innerView.dispatch({ selection: { anchor: head } });
      innerView.focus();
      const coords = innerView.coordsAtPos(head);
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      if (!coords) throw new Error('Could not measure formula source caret');
      editor.view.scrollDOM.scrollTop += coords.bottom - viewport.bottom + 2;
    });
    await page.keyboard.type('1234567890'.repeat(30));
    await page.evaluate(async () => {
      for (let index = 0; index < 6; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const formulaCaret = await page.evaluate(() => {
      const editor = (window as any).__editor;
      const block = document.querySelector<HTMLElement>('.meo-latex-math-editing-block')!;
      const innerView = (block as any).__meoLatexMathEditingController.innerView;
      const coords = innerView.coordsAtPos(innerView.state.selection.main.head);
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      return {
        caretTop: coords?.top ?? null,
        caretBottom: coords?.bottom ?? null,
        viewportTop: viewport.top,
        viewportBottom: viewport.bottom,
        visible: Boolean(coords && coords.top >= viewport.top && coords.bottom <= viewport.bottom)
      };
    });
    if (!formulaCaret.visible) {
      throw new Error(`Numeric formula input left its source line outside the outer viewport: ${JSON.stringify(formulaCaret)}`);
    }

    const tableText = [
      ...Array.from({ length: 799 }, (_, index) => `表格前正文 ${index + 1}`),
      '| ID | 名称 | 状态 |',
      '| --- | --- | --- |',
      '| 1 | Alpha | Ready |',
      '| 2 | Bravo | Editing |',
      '| 3 | Charlie | Done |',
      ...Array.from({ length: 300 }, (_, index) => `表格后正文 ${index + 1}`)
    ].join('\n');
    await page.evaluate((nextText) => (window as any).__editor.setText(nextText, true), tableText);
    await page.evaluate(async () => {
      for (let index = 0; index < 8; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const editor = (window as any).__editor;
      const tablePosition = editor.getText().indexOf('| ID | 名称 | 状态 |');
      editor.view.scrollDOM.scrollTop = editor.view.lineBlockAt(tablePosition).top - 80;
    });
    await page.waitForSelector('.meo-md-html-table-shell tbody tr:first-child td:first-child textarea');
    const numericCell = await page.$('.meo-md-html-table-shell tbody tr:first-child td:first-child textarea');
    if (!numericCell) throw new Error('Could not locate numeric table cell');
    await numericCell.click();
    await numericCell.press('End');
    await page.evaluate(() => {
      const editor = (window as any).__editor;
      const input = document.querySelector<HTMLTextAreaElement>(
        '.meo-md-html-table-shell tbody tr:first-child td:first-child textarea'
      )!;
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      const cell = input.closest<HTMLTableCellElement>('td')!;
      editor.view.scrollDOM.scrollTop += cell.getBoundingClientRect().bottom - viewport.bottom + 2;
    });
    await page.keyboard.type('1234567890'.repeat(30));
    await page.evaluate(async () => {
      for (let index = 0; index < 8; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const tableCaret = await page.evaluate(() => {
      const editor = (window as any).__editor;
      const input = document.querySelector<HTMLTextAreaElement>(
        '.meo-md-html-table-shell tbody tr:first-child td:first-child textarea'
      )!;
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      const inputRect = input.getBoundingClientRect();
      const cellRect = input.closest<HTMLTableCellElement>('td')!.getBoundingClientRect();
      return {
        active: document.activeElement === input,
        selectionEnd: input.selectionEnd,
        valueLength: input.value.length,
        inputBottom: inputRect.bottom,
        cellBottom: cellRect.bottom,
        viewportBottom: viewport.bottom,
        inputScrollTop: input.scrollTop,
        visible: inputRect.bottom <= viewport.bottom && cellRect.bottom <= viewport.bottom && input.scrollTop <= 1
      };
    });
    if (!tableCaret.visible || !tableCaret.active || tableCaret.selectionEnd !== tableCaret.valueLength) {
      throw new Error(`Numeric table input left its active line outside the viewport: ${JSON.stringify(tableCaret)}`);
    }

    console.log('live caret continuity browser test passed');
  } catch (error) {
    primaryError = error;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (primaryError === undefined) await closeTestBrowser(browser);
    else await closeTestBrowser(browser, primaryError);
  }
}

await main();
