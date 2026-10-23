import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import { createEditorInteractionContinuity, createNestedEditorInteractionContinuity } from '../webview/src/editor/interactionContinuity';

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

function checkPendingInputLayoutOwnership(): void {
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  globalThis.cancelAnimationFrame = (handle) => { frames.delete(handle); };
  try {
    for (const captureBeforeInput of [true, false]) {
      let caretTop = 350;
      let pendingCorrection = false;
      const dom = Object.assign(new EventTarget(), { ownerDocument: new EventTarget() });
      const scroller = Object.assign(new EventTarget(), {
        scrollTop: 1_000,
        getBoundingClientRect: () => ({ top: 0, bottom: 500 })
      });
      const correctVirtualHeights = () => {
        if (!pendingCorrection) return;
        pendingCorrection = false;
        // CodeMirror changes its absolute offset while the physical caret stays put.
        scroller.scrollTop = 600;
      };
      const view = {
        dom, scrollDOM: scroller, hasFocus: true, defaultLineHeight: 24,
        state: { selection: { main: { head: 100, empty: true } },
          doc: { length: 1_000, lineAt: () => ({ number: 10 }) } },
        coordsAtPos: () => {
          correctVirtualHeights();
          return { top: caretTop, bottom: caretTop + 24 };
        },
        lineBlockAt: () => { correctVirtualHeights(); return { height: 24 }; },
        requestMeasure: ({ read, write }: any) => write(read())
      };
      let reveals = 0;
      let retains = 0;
      const continuity = createEditorInteractionContinuity({
        view: view as any, getMode: () => 'live',
        viewport: {
          retainCaretTop(_position, top, isCurrent) {
            if (!isCurrent()) throw new Error('Stale physical input anchor');
            retains += 1;
            caretTop = top;
          },
          revealCaret() { reveals += 1; }
        }
      });
      if (captureBeforeInput) dom.dispatchEvent(new Event('beforeinput'));
      // A handled paste can dispatch input without a separate beforeinput event.
      pendingCorrection = true;
      view.state.selection.main.head += 1;
      continuity.observe({
        transactions: [{ docChanged: true, isUserEvent: () => true }], selectionSet: true
      } as any);
      if (reveals !== 0 || caretTop !== 350 || scroller.scrollTop !== 600) {
        throw new Error(`Virtual height correction must retain the physical input anchor: ${JSON.stringify({
          captureBeforeInput, reveals, caretTop, scrollTop: scroller.scrollTop
        })}`);
      }
      caretTop = 700;
      continuity.observe({ transactions: [], selectionSet: false, geometryChanged: true } as any);
      if (caretTop !== 350 || retains !== 1) throw new Error('Later layout must retain the adopted physical anchor');
      view.state.selection.main.head += 10;
      continuity.observe({ transactions: [], selectionSet: true } as any);
      caretTop = 700;
      continuity.observe({ transactions: [], selectionSet: false, geometryChanged: true } as any);
      continuity.dispose();
      if (caretTop !== 700 || retains !== 1) throw new Error('New navigation must cancel the physical input anchor');
    }
    for (const reflowed of [false, true]) {
      let caretTop = 350;
      let lineHeight = 24;
      let pendingHeightMapShift = false;
      const dom = Object.assign(new EventTarget(), { ownerDocument: new EventTarget() });
      const scroller = Object.assign(new EventTarget(), {
        scrollTop: 1_000,
        getBoundingClientRect: () => ({ top: 0, bottom: 500 })
      });
      const view = {
        dom, scrollDOM: scroller, hasFocus: true, defaultLineHeight: 24,
        state: { selection: { main: { head: 100, empty: true } },
          doc: { length: 1_000, lineAt: () => ({ number: 10 }) } },
        coordsAtPos: () => ({ top: caretTop, bottom: caretTop + 24 }),
        lineBlockAt: () => {
          if (pendingHeightMapShift) {
            pendingHeightMapShift = false;
            caretTop = 700;
            scroller.scrollTop = 800;
          }
          return { height: lineHeight };
        },
        requestMeasure: ({ read, write }: any) => write(read())
      };
      let retains = 0;
      let reveals = 0;
      const continuity = createEditorInteractionContinuity({
        view: view as any, getMode: () => 'live',
        viewport: {
          retainCaretTop(_position, top, isCurrent) {
            if (!isCurrent()) throw new Error('Stale input correction');
            retains += 1;
            caretTop = top;
          },
          revealCaret() { reveals += 1; }
        }
      });
      dom.dispatchEvent(new Event('beforeinput'));
      // Upstream virtual heights change while the accepted line stays intact.
      // A structural edit instead changes that line and must await presentation.
      caretTop = reflowed ? 700 : 30;
      scroller.scrollTop = 600;
      if (reflowed) lineHeight = 48;
      view.state.selection.main.head += 1;
      continuity.observe({
        transactions: [{ docChanged: true, isUserEvent: () => true }],
        selectionSet: true
      } as any);
      if (!reflowed) {
        // A following key must inherit the physical caret anchor, even though
        // virtual heights changed the burst's original absolute scroll offset.
        dom.dispatchEvent(new Event('beforeinput'));
        view.state.selection.main.head += 1;
        continuity.observe({
          transactions: [{ docChanged: true, isUserEvent: () => true }], selectionSet: true
        } as any);
        continuity.observe({ transactions: [{ docChanged: false, effects: [{ is: () => true }] }], selectionSet: false } as any);
        // Two post-refresh geometry receipts can arrive before any queued RAF.
        // They must not consume the input's two stable animation frames.
        for (let receipt = 0; receipt < 2; receipt++) {
          continuity.observe({ transactions: [{ docChanged: false, effects: [] }], selectionSet: false, geometryChanged: true } as any);
        }
        // CodeMirror can correct virtual heights during its current measure
        // pass, while the input owner already has a later RAF scheduled.
        caretTop = 700;
        scroller.scrollTop = 800;
        continuity.observe({ transactions: [], selectionSet: false, viewportChanged: true } as any);
        if (caretTop !== 350 || retains !== 2) {
          throw new Error('Post-refresh receipts ended input retention before a frame advanced');
        }
        // A height-map query can flush a queued CodeMirror measurement. Its
        // final caret must be read afterwards, not paired with an older rect.
        pendingHeightMapShift = true;
        continuity.observe({ transactions: [], selectionSet: false, geometryChanged: true } as any);
        if (caretTop !== 350 || retains !== 3) throw new Error('Input measurement mixed two height-map layouts');
        view.state.selection.main.head += 10;
        continuity.observe({ transactions: [], selectionSet: true } as any);
        caretTop = 700;
        continuity.observe({ transactions: [], selectionSet: false, geometryChanged: true } as any);
        if (caretTop !== 700 || retains !== 3) throw new Error('New navigation must retire the main input anchor');
      }
      continuity.dispose();
      if (reflowed ? retains !== 0 || reveals !== 0 : retains !== 3 || reveals !== 0 || caretTop !== 700) {
        throw new Error(`Pending input layout ownership failed: ${JSON.stringify({ reflowed, retains, reveals, caretTop })}`);
      }
    }
    let nestedTop = 100;
    const nestedDom = new EventTarget();
    const outerScroller = new EventTarget();
    const nestedView = {
      dom: nestedDom, hasFocus: true,
      state: { selection: { main: { head: 1, empty: true } }, doc: { length: 20 } },
      coordsAtPos: () => ({ top: nestedTop, bottom: nestedTop + 24 }),
      requestMeasure: ({ read, write }: any) => write(read())
    };
    let lateReveals = 0;
    const nested = createNestedEditorInteractionContinuity({
      view: nestedView as any, isActive: () => true, interactionTarget: outerScroller as any,
      viewport: {
        readBounds: () => ({ top: 0, bottom: 500 }), readScrollTop: () => 1_000,
        revealCaret(_position, isCurrent) {
          if (!isCurrent()) throw new Error('Stale nested correction');
          lateReveals += 1;
          nestedTop = 100;
        }
      }
    });
    const flush = () => {
      for (let step = 0; frames.size && step < 20; step += 1) {
        const callbacks = [...frames.values()];
        frames.clear();
        for (const callback of callbacks) callback(0);
      }
    };
    nestedDom.dispatchEvent(new Event('beforeinput'));
    nested.observe({ transactions: [{ docChanged: true, isUserEvent: () => true }], selectionSet: true } as any);
    flush();
    nestedTop = 700;
    nested.observe({ transactions: [], selectionSet: false, geometryChanged: true } as any);
    flush();
    nestedTop = 700;
    // A parent height-map correction can move the embedded editor without any
    // inner ViewUpdate. Its owning scroller must also resume the input check.
    outerScroller.dispatchEvent(new Event('scroll'));
    flush();
    nestedTop = 700;
    outerScroller.dispatchEvent(new Event('meo-viewport-layout-change'));
    flush();
    // History and external source synchronization can replace the document
    // without changing the mapped head. That must retire the old input anchor.
    nested.observe({
      docChanged: true,
      transactions: [{ docChanged: true, isUserEvent: () => false, effects: [] }],
      selectionSet: false
    } as any);
    nestedTop = 700;
    outerScroller.dispatchEvent(new Event('meo-viewport-layout-change'));
    outerScroller.dispatchEvent(new Event('scroll'));
    flush();
    nested.observe({ transactions: [{ docChanged: true, isUserEvent: () => true }], selectionSet: true } as any);
    nestedTop = 100;
    flush();
    outerScroller.dispatchEvent(new Event('wheel'));
    nestedTop = 700;
    outerScroller.dispatchEvent(new Event('scroll'));
    flush();
    nested.dispose();
    if (lateReveals !== 3 || nestedTop !== 700) {
      throw new Error(`Late nested geometry lost input visibility: ${JSON.stringify({ lateReveals, nestedTop })}`);
    }
  } finally {
    globalThis.requestAnimationFrame = originalRequest;
    globalThis.cancelAnimationFrame = originalCancel;
  }
}

checkPendingInputLayoutOwnership();

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
    ].join('\n'), '<del>HTML 第 51 行式目标</del>');

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

    const rapidInputOrigin = await page.evaluate(async () => {
      const editor = (window as any).__editor;
      const view = editor.view;
      const target = view.state.doc.line(800);
      editor.scrollToLine(target.number, 'center');
      view.dispatch({ selection: { anchor: target.to } });
      view.focus();
      for (let index = 0; index < 8; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      return view.scrollDOM.scrollTop;
    });
    await page.keyboard.type('A');
    await page.evaluate(async () => {
      for (let index = 0; index < 8; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const rapidInputShifted = await page.evaluate(() => {
      const view = (window as any).__editor.view;
      view.scrollDOM.scrollTop = Math.max(0, view.scrollDOM.scrollTop - 120);
      return view.scrollDOM.scrollTop;
    });
    await page.keyboard.type('B');
    await page.evaluate(async () => {
      for (let index = 0; index < 8; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const rapidInputSettled = await page.evaluate(() => (window as any).__editor.view.scrollDOM.scrollTop as number);
    if (
      Math.abs(rapidInputShifted - rapidInputOrigin) < 60 ||
      Math.abs(rapidInputSettled - rapidInputOrigin) > 1
    ) {
      throw new Error(`Rapid Live input adopted a transient layout correction as its new origin: ${JSON.stringify({
        rapidInputOrigin,
        rapidInputShifted,
        rapidInputSettled
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
    await page.waitForSelector('.meo-math-source-line');
    await page.evaluate(async () => {
      for (let index = 0; index < 6; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const editor = (window as any).__editor;
      const innerView = editor.view;
      const head = innerView.state.doc.toString().indexOf('x = 1') + 'x = 1'.length;
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
      const innerView = editor.view;
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
      const innerView = editor.view;
      const sourceStart = innerView.state.doc.toString().indexOf('x = 1');
      innerView.dispatch({ selection: { anchor: sourceStart } });
      innerView.focus();
      const viewport = (window as any).LiveLayoutStabilityHarness.editorViewportBounds(editor.view);
      const caret = innerView.coordsAtPos(sourceStart);
      if (!caret) throw new Error('Could not measure formula top caret');
      editor.view.scrollDOM.dispatchEvent(new WheelEvent('wheel', { deltaY: 60, bubbles: true }));
      editor.view.scrollDOM.scrollTop += caret.top - viewport.top + 3;
      return {
        scrollTop: editor.view.scrollDOM.scrollTop,
        caretTop: innerView.coordsAtPos(sourceStart)?.top ?? null,
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
      const innerView = editor.view;
      const caret = innerView.coordsAtPos(innerView.state.selection.main.head);
      const viewport = (window as any).LiveLayoutStabilityHarness.editorViewportBounds(editor.view);
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
    // Chromium's native text node uses the textarea's actual shaping and
    // wrapping rules, which a separate DOM mirror cannot fully reproduce.
    const caretClient = await page.createCDPSession();
    const { root } = await caretClient.send('DOM.getDocument', { depth: 0, pierce: true });
    const { nodeId } = await caretClient.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '.meo-md-html-table-shell tbody tr:first-child td:first-child textarea'
    });
    const described = await caretClient.send('DOM.describeNode', { nodeId, depth: -1, pierce: true });
    const descendants = (node: typeof described.node): Array<typeof described.node> => [
      node, ...(node.shadowRoots ?? []).flatMap(descendants), ...(node.children ?? []).flatMap(descendants)
    ];
    const nativeText = descendants(described.node).filter(node => node.nodeType === 3);
    if (nativeText.length !== 1) throw new Error('Expected one native numeric textarea text node');
    const { object } = await caretClient.send('DOM.resolveNode', { backendNodeId: nativeText[0].backendNodeId });
    const measured = await caretClient.send('Runtime.callFunctionOn', {
      objectId: object.objectId, returnByValue: true,
      functionDeclaration: function(this: Text) {
        const input = (this.getRootNode() as ShadowRoot).host;
        if (!(input instanceof HTMLTextAreaElement) || this.data !== input.value) {
          throw new Error('Native textarea text no longer matches its input');
        }
        const range = this.ownerDocument.createRange();
        range.setStart(this, input.selectionEnd);
        range.collapse(true);
        const caret = range.getBoundingClientRect();
        const viewport = (window as any).__editor.view.scrollDOM.getBoundingClientRect();
        return {
          active: document.activeElement === input,
          selectionStart: input.selectionStart,
          selectionEnd: input.selectionEnd,
          selectionDirection: input.selectionDirection,
          valueLength: input.value.length,
          inputBottom: input.getBoundingClientRect().bottom,
          cellBottom: input.closest('td')!.getBoundingClientRect().bottom,
          caretTop: caret.top,
          caretBottom: caret.bottom,
          viewportBottom: viewport.bottom,
          inputScrollTop: input.scrollTop,
          visible: caret.height > 0 && caret.top >= viewport.top && caret.bottom <= viewport.bottom && input.scrollTop <= 1
        };
      }.toString()
    });
    if (measured.exceptionDetails || !measured.result.value) {
      throw new Error(`Native textarea caret measurement failed: ${JSON.stringify(measured.exceptionDetails)}`);
    }
    const tableCaret = measured.result.value as {
      visible: boolean; active: boolean; selectionStart: number; selectionEnd: number; valueLength: number;
    };
    if (!tableCaret.visible || !tableCaret.active || tableCaret.selectionStart !== tableCaret.selectionEnd
      || tableCaret.selectionEnd !== tableCaret.valueLength) {
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
    const { nodeId: stickyInputId } = await caretClient.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '.meo-md-html-table-shell tbody tr:nth-child(12) td:nth-child(2) textarea'
    });
    const stickyInput = await caretClient.send('DOM.describeNode', { nodeId: stickyInputId, depth: -1, pierce: true });
    const stickyText = descendants(stickyInput.node).filter(node => node.nodeType === 3);
    if (stickyText.length !== 1) throw new Error('Expected one native sticky-header textarea text node');
    const { object: stickyObject } = await caretClient.send('DOM.resolveNode', { backendNodeId: stickyText[0].backendNodeId });
    const stickyMeasured = await caretClient.send('Runtime.callFunctionOn', {
      objectId: stickyObject.objectId, returnByValue: true,
      functionDeclaration: function(this: Text) {
        const input = (this.getRootNode() as ShadowRoot).host as HTMLTextAreaElement;
        if (this.data !== input.value) throw new Error('Sticky-header textarea text no longer matches its input');
        const range = this.ownerDocument.createRange();
        range.setStart(this, input.selectionEnd);
        range.collapse(true);
        const caret = range.getBoundingClientRect();
        return { top: caret.top, height: caret.height, focused: document.activeElement === input };
      }.toString()
    });
    await caretClient.detach();
    if (stickyMeasured.exceptionDetails || !stickyMeasured.result.value) throw new Error('Native sticky-header caret measurement failed');
    const stickyCaret = stickyMeasured.result.value as { top: number; height: number; focused: boolean };
    if (
      stickyBefore.stickyBottom === null || stickyAfter.stickyBottom === null ||
      stickyBefore.inputTop >= stickyBefore.stickyBottom ||
      // Reveal operates on the caret, which is inset from the textarea's border.
      !stickyCaret.focused || stickyCaret.height <= 0 ||
      stickyCaret.top < stickyAfter.stickyBottom + stickyAfter.lineHeight - 2 ||
      stickyAfter.scrollTop < stickyBefore.scrollTop - stickyAfter.lineHeight * 3
    ) {
      throw new Error(`Table input hidden by the sticky header was not minimally revealed: ${JSON.stringify({
        stickyBefore,
        stickyAfter,
        stickyCaret
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
