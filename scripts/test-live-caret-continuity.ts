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

    const topRevealBefore = await page.evaluate(async () => {
      const view = (window as any).__editor.view;
      const target = view.state.doc.line(120);
      view.dispatch({ selection: { anchor: target.to } });
      view.focus();
      for (let index = 0; index < 3; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const caret = view.coordsAtPos(target.to);
      const viewport = view.scrollDOM.getBoundingClientRect();
      if (!caret) throw new Error('Could not measure top reveal target');
      view.scrollDOM.scrollTop += caret.top - viewport.top + 3;
      for (let index = 0; index < 3; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const positioned = view.coordsAtPos(target.to);
      return {
        scrollTop: view.scrollDOM.scrollTop,
        caretTop: positioned?.top ?? null,
        viewportTop: view.scrollDOM.getBoundingClientRect().top,
        lineHeight: view.defaultLineHeight
      };
    });
    await page.keyboard.type('X');
    await page.evaluate(async () => {
      for (let index = 0; index < 8; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const topRevealAfter = await page.evaluate(() => {
      const view = (window as any).__editor.view;
      const caret = view.coordsAtPos(view.state.selection.main.head);
      const viewport = view.scrollDOM.getBoundingClientRect();
      return {
        scrollTop: view.scrollDOM.scrollTop,
        caretTop: caret?.top ?? null,
        viewportTop: viewport.top,
        lineHeight: view.defaultLineHeight
      };
    });
    if (
      topRevealBefore.caretTop === null || topRevealAfter.caretTop === null ||
      topRevealBefore.caretTop >= topRevealBefore.viewportTop ||
      topRevealAfter.caretTop < topRevealAfter.viewportTop + topRevealAfter.lineHeight - 2 ||
      topRevealAfter.scrollTop < topRevealBefore.scrollTop - topRevealAfter.lineHeight - 8
    ) {
      throw new Error(`Typing above the viewport did not use the nearest edge plus one line: ${JSON.stringify({
        topRevealBefore,
        topRevealAfter
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

    const verifyMainTopReveal = async (
      name: string,
      documentText: string,
      targetNeedle: string,
      activateSelector?: string
    ) => {
      await page.evaluate(async (nextText) => {
        (window as any).__editor.setText(nextText, true);
        for (let index = 0; index < 8; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      }, documentText);
      if (activateSelector) {
        await page.waitForSelector(activateSelector);
        await page.click(activateSelector);
        await page.waitForSelector('.cm-line.meo-md-html-source-range');
      }
      const before = await page.evaluate(async ({ needle }) => {
        const view = (window as any).__editor.view;
        const position = view.state.doc.toString().indexOf(needle) + needle.length;
        if (position < needle.length) throw new Error(`Missing reveal target: ${needle}`);
        view.dispatch({ selection: { anchor: position } });
        view.focus();
        const block = view.lineBlockAt(position);
        view.scrollDOM.scrollTop = block.top + 3;
        for (let index = 0; index < 5; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        const viewport = view.scrollDOM.getBoundingClientRect();
        const initialCaret = view.coordsAtPos(position);
        if (!initialCaret) throw new Error(`Could not measure reveal target: ${needle}`);
        view.scrollDOM.dispatchEvent(new WheelEvent('wheel', { deltaY: 60, bubbles: true }));
        view.scrollDOM.scrollTop += initialCaret.top - viewport.top + 3;
        const caret = view.coordsAtPos(position);
        return {
          scrollTop: view.scrollDOM.scrollTop,
          caretTop: caret?.top ?? null,
          viewportTop: viewport.top,
          lineHeight: view.defaultLineHeight
        };
      }, { needle: targetNeedle });
      await page.keyboard.type('X');
      await page.evaluate(async () => {
        for (let index = 0; index < 8; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      });
      const after = await page.evaluate(() => {
        const view = (window as any).__editor.view;
        const caret = view.coordsAtPos(view.state.selection.main.head);
        const viewport = view.scrollDOM.getBoundingClientRect();
        return {
          scrollTop: view.scrollDOM.scrollTop,
          caretTop: caret?.top ?? null,
          viewportTop: viewport.top,
          lineHeight: view.defaultLineHeight
        };
      });
      if (
        before.caretTop === null || after.caretTop === null ||
        before.caretTop >= before.viewportTop ||
        after.caretTop < after.viewportTop + after.lineHeight - 2 ||
        after.scrollTop < before.scrollTop - after.lineHeight - 10
      ) {
        throw new Error(`${name} did not use minimal top reveal: ${JSON.stringify({ before, after })}`);
      }
    };

    const matrixPrefix = Array.from({ length: 120 }, (_, index) => `矩阵前正文 ${index + 1}`);
    const matrixSuffix = Array.from({ length: 40 }, (_, index) => `矩阵后正文 ${index + 1}`);
    await verifyMainTopReveal('language-less fenced code', [
      ...matrixPrefix, '```', '无语言代码块目标', '```', ...matrixSuffix
    ].join('\n'), '无语言代码块目标');
    await verifyMainTopReveal('text fenced code', [
      ...matrixPrefix, '```text', 'text 代码块目标', '```', ...matrixSuffix
    ].join('\n'), 'text 代码块目标');
    await verifyMainTopReveal('multi-line HTML source', [
      ...matrixPrefix,
      '<p>',
      '  HTML 普通内容',
      '  <del>HTML 第 51 行式目标</del>',
      '</p>',
      ...matrixSuffix
    ].join('\n'), '<del>HTML 第 51 行式目标</del>', '.meo-md-html-source-toggle');

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

    const formulaTopBefore = await page.evaluate(() => {
      const editor = (window as any).__editor;
      const block = document.querySelector<HTMLElement>('.meo-latex-math-editing-block')!;
      const innerView = (block as any).__meoLatexMathEditingController.innerView;
      innerView.dispatch({ selection: { anchor: 0 } });
      innerView.focus();
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      const caret = innerView.coordsAtPos(0);
      if (!caret) throw new Error('Could not measure formula top caret');
      editor.view.scrollDOM.dispatchEvent(new WheelEvent('wheel', { deltaY: 60, bubbles: true }));
      editor.view.scrollDOM.scrollTop += caret.top - viewport.top + 3;
      return {
        scrollTop: editor.view.scrollDOM.scrollTop,
        caretTop: innerView.coordsAtPos(0)?.top ?? null,
        viewportTop: viewport.top,
        lineHeight: editor.view.defaultLineHeight
      };
    });
    await page.keyboard.type('X');
    await page.evaluate(async () => {
      for (let index = 0; index < 8; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const formulaTopAfter = await page.evaluate(() => {
      const editor = (window as any).__editor;
      const block = document.querySelector<HTMLElement>('.meo-latex-math-editing-block')!;
      const innerView = (block as any).__meoLatexMathEditingController.innerView;
      const caret = innerView.coordsAtPos(innerView.state.selection.main.head);
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      return {
        scrollTop: editor.view.scrollDOM.scrollTop,
        caretTop: caret?.top ?? null,
        viewportTop: viewport.top,
        lineHeight: editor.view.defaultLineHeight
      };
    });
    if (
      formulaTopBefore.caretTop === null || formulaTopAfter.caretTop === null ||
      formulaTopBefore.caretTop >= formulaTopBefore.viewportTop ||
      formulaTopAfter.caretTop < formulaTopAfter.viewportTop + formulaTopAfter.lineHeight - 2 ||
      formulaTopAfter.scrollTop < formulaTopBefore.scrollTop - formulaTopAfter.lineHeight - 10
    ) {
      throw new Error(`Formula source did not use minimal top reveal: ${JSON.stringify({
        formulaTopBefore,
        formulaTopAfter
      })}`);
    }

    const tableText = [
      ...Array.from({ length: 799 }, (_, index) => `表格前正文 ${index + 1}`),
      '| ID | 名称 | 状态 |',
      '| --- | --- | --- |',
      ...Array.from({ length: 24 }, (_, index) => `| ${index + 1} | Row ${index + 1} | Ready |`),
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
      for (let index = 0; index < 12; index += 1) {
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
        visible: inputRect.bottom <= viewport.bottom + 3 && cellRect.bottom <= viewport.bottom + 3 && input.scrollTop <= 1
      };
    });
    if (!tableCaret.visible || !tableCaret.active || tableCaret.selectionEnd !== tableCaret.valueLength) {
      throw new Error(`Numeric table input left its active line outside the viewport: ${JSON.stringify(tableCaret)}`);
    }

    const stickyBefore = await page.evaluate(async () => {
      const editor = (window as any).__editor;
      const input = document.querySelector<HTMLTextAreaElement>(
        '.meo-md-html-table-shell tbody tr:nth-child(12) td:nth-child(2) textarea'
      )!;
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      editor.view.scrollDOM.scrollTop += input.getBoundingClientRect().top - viewport.top - 48;
      for (let index = 0; index < 8; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const sticky = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome.is-visible');
      editor.view.scrollDOM.scrollTop += input.getBoundingClientRect().top - viewport.top - 2;
      return {
        scrollTop: editor.view.scrollDOM.scrollTop,
        inputTop: input.getBoundingClientRect().top,
        viewportTop: editor.view.scrollDOM.getBoundingClientRect().top,
        stickyBottom: sticky?.getBoundingClientRect().bottom ?? null,
        lineHeight: editor.view.defaultLineHeight
      };
    });
    await page.keyboard.type('X');
    await page.evaluate(async () => {
      for (let index = 0; index < 8; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const stickyAfter = await page.evaluate(() => {
      const editor = (window as any).__editor;
      const input = document.querySelector<HTMLTextAreaElement>(
        '.meo-md-html-table-shell tbody tr:nth-child(12) td:nth-child(2) textarea'
      )!;
      const sticky = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome.is-visible');
      return {
        scrollTop: editor.view.scrollDOM.scrollTop,
        inputTop: input.getBoundingClientRect().top,
        stickyBottom: sticky?.getBoundingClientRect().bottom ?? null,
        lineHeight: editor.view.defaultLineHeight
      };
    });
    if (
      stickyBefore.stickyBottom === null || stickyAfter.stickyBottom === null ||
      stickyBefore.inputTop >= stickyBefore.stickyBottom ||
      stickyAfter.inputTop < stickyAfter.stickyBottom + stickyAfter.lineHeight - 2 ||
      stickyAfter.scrollTop < stickyBefore.scrollTop - stickyAfter.lineHeight * 3
    ) {
      throw new Error(`Table input hidden by the sticky header was not minimally revealed: ${JSON.stringify({
        stickyBefore,
        stickyAfter
      })}`);
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
