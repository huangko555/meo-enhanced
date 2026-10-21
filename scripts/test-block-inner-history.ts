import { enterMermaidSource } from './history-mermaid-chromium';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';
import { installCausalFrameSettlement } from './causal-frame-settlement';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-block-inner-history-'));
const causalFrameSettlementSource = installCausalFrameSettlement.toString();

async function waitForFrames(page: any, count = 6) {
  await page.evaluate(async (frameCount: number) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function pressShortcut(page: any, key: 'z' | 'y') {
  await page.keyboard.down('Control');
  await page.keyboard.press(key);
  await page.keyboard.up('Control');
  await waitForFrames(page);
}

async function roundTripLatestHistory(page: any) {
  const receipt = await page.evaluate(async () => {
    const editor = (window as any).__blockHistoryEditor;
    const undone = await editor.undo();
    const redone = await editor.redo();
    return { undone, redone };
  });
  if (!receipt.undone || !receipt.redone) {
    throw new Error(`Public history round trip did not complete: ${JSON.stringify(receipt)}`);
  }
}

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-mermaid-editing-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 520, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate(() => {
      (window as any).mermaid = {
        initialize() {},
        async render(_id: string, text: string) {
          return { svg: `<svg width="320" height="120"><text>${text.length}</text></svg>` };
        }
      };
      (window as any).__blockHistoryEditor = (window as any).MermaidEditingHarness.createEditor({
        parent: document.getElementById('app')!,
        text: ['```mermaid', 'graph TD', 'A --> B', '```', '', '$$', 'x = 1', '$$'].join('\n'),
        initialMode: 'live',
        onApplyChanges() {}
      });
    });
    await waitForFrames(page);

    const source = await enterMermaidSource(page, '__blockHistoryEditor', 1, 'end');
    const immediateMode = await page.evaluate(({ to }) => {
      const view = (window as any).__blockHistoryEditor.view;
      const insert = '\nB --> IMMEDIATE_MODE_PROBE';
      view.dispatch({ changes: { from: to, insert }, selection: { anchor: to + insert.length } });
      view.dom.querySelector<HTMLButtonElement>('.meo-mermaid-mode-btn')!.click();
      return view.dom.querySelector<HTMLElement>('.meo-mermaid-toolbar')?.dataset.meoMermaidMode;
    }, source);
    if (immediateMode !== 'preview') throw new Error(`Finish deferred behind document input: ${immediateMode}`);
    await waitForFrames(page);

    await enterMermaidSource(page, '__blockHistoryEditor', 1, 'end');
    await page.$eval('.meo-mermaid-mode-btn', button => button.setAttribute('data-meo-input-mode-switch-probe', 'retained'));
    await page.keyboard.type('\nB --> C');
    const retained = await page.$eval('.meo-mermaid-mode-btn', button => button.getAttribute('data-meo-input-mode-switch-probe'));
    if (retained !== 'retained') throw new Error('Finish button was replaced while input was settling');
    await page.evaluate(() => {
      const trace: string[] = [];
      (window as any).__renderedBlockModePointerTrace = trace;
      const view = (window as any).__blockHistoryEditor.view;
      const button = view.dom.querySelector<HTMLButtonElement>('.meo-mermaid-mode-btn')!;
      button.addEventListener('pointerdown', () => trace.push('pointerdown'));
      button.addEventListener('click', () => trace.push('click'));
      view.contentDOM.addEventListener('blur', () => trace.push('blur'));
    });
    await page.click('.meo-mermaid-mode-btn');
    const finish = await page.evaluate(() => ({
      trace: (window as any).__renderedBlockModePointerTrace as string[],
      mode: document.querySelector<HTMLElement>('.meo-mermaid-toolbar')?.dataset.meoMermaidMode
    }));
    const clickIndex = finish.trace.indexOf('click'), blurIndex = finish.trace.indexOf('blur');
    if (clickIndex < 0 || (blurIndex >= 0 && blurIndex < clickIndex)) throw new Error(`Finish blurred before click: ${JSON.stringify(finish)}`);
    if (finish.mode !== 'preview') throw new Error(`Finish deferred behind pending input: ${JSON.stringify(finish)}`);
    await waitForFrames(page);
    if (await page.$('.meo-mermaid-editing-preview')) throw new Error('Finish did not collapse the document source');

    await page.evaluate(() => {
      const editor = (window as any).__blockHistoryEditor;
      editor.view.dispatch({
        changes: { from: editor.view.state.doc.length, insert: '\n\n$$\nz = 3\n$$' }
      });
    });
    await waitForFrames(page);
    await page.click('.meo-md-math-fenced-display .katex');
    await waitForFrames(page);
    await page.keyboard.press('End'); await page.keyboard.type(' + SHIFT');
    await page.locator('.meo-md-math-fenced-display:not(.meo-math-live-result) .katex').click();
    await waitForFrames(page);
    const switched = await page.evaluate(() => { const view = (window as any).__blockHistoryEditor.view;
      return { line: view.state.doc.lineAt(view.state.selection.main.head).text, focused: view.hasFocus }; });
    if (!switched.line.includes('z = 3') || !switched.focused) throw new Error('Switching between formulas lost the main caret');
    if (process.argv.includes('--mode-switch-only')) {
      console.log('rendered block mode switching after projected input passed');
      return;
    }

    await page.evaluate(() => {
      (window as any).__blockHistoryEditor.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).__blockHistoryEditor = (window as any).MermaidEditingHarness.createEditor({
        parent: document.getElementById('app')!,
        text: ['```mermaid', 'graph TD', 'A --> B', '```', '', '$$', 'x = 1', '$$'].join('\n'),
        initialMode: 'live',
        onApplyChanges() {}
      });
    });
    await waitForFrames(page);

    await enterMermaidSource(page, '__blockHistoryEditor', 1, 'end');
    await page.keyboard.type('MERMAID_ONE');
    await roundTripLatestHistory(page);
    await page.keyboard.type('_TWO');
    await roundTripLatestHistory(page);
    await page.keyboard.type('_THREE');
    await waitForFrames(page);
    const mermaidEdited = await page.evaluate(() => (
      (window as any).__blockHistoryEditor.view.state.doc.toString()
    ));
    if (!mermaidEdited.includes('MERMAID_ONE_TWO_THREE')) {
      throw new Error(`Mermaid keyboard edit did not reach the outer document: ${mermaidEdited}`);
    }

    await pressShortcut(page, 'z');
    const mermaidFirstUndo = await page.evaluate(() => {
      const editor = (window as any).__blockHistoryEditor;
      const innerView = editor.view;
      return {
        text: editor.view.state.doc.toString(),
        focused: Boolean(innerView?.hasFocus),
        head: innerView?.state.selection.main.head ?? null
      };
    });
    if (mermaidFirstUndo.text.includes('_THREE') || !mermaidFirstUndo.text.includes('MERMAID_ONE_TWO') || !mermaidFirstUndo.focused) {
      throw new Error(`First Mermaid Ctrl+Z was blocked inside its source editor: ${JSON.stringify(mermaidFirstUndo)}`);
    }

    await pressShortcut(page, 'z');
    const mermaidSecondUndo = await page.evaluate(() => {
      const editor = (window as any).__blockHistoryEditor;
      const innerView = editor.view;
      return {
        text: editor.view.state.doc.toString(),
        focused: Boolean(innerView?.hasFocus),
        head: innerView?.state.selection.main.head ?? null
      };
    });
    if (mermaidSecondUndo.text.includes('_TWO') || !mermaidSecondUndo.text.includes('MERMAID_ONE') || !mermaidSecondUndo.focused) {
      throw new Error(`Second Mermaid Ctrl+Z was blocked inside its source editor: ${JSON.stringify({ mermaidFirstUndo, mermaidSecondUndo })}`);
    }

    await pressShortcut(page, 'z');
    const mermaidThirdUndo = await page.evaluate(() => {
      const editor = (window as any).__blockHistoryEditor;
      const innerView = editor.view;
      return {
        text: editor.view.state.doc.toString(),
        focused: Boolean(innerView?.hasFocus),
        head: innerView?.state.selection.main.head ?? null
      };
    });
    if (mermaidThirdUndo.text.includes('MERMAID_ONE') || !mermaidThirdUndo.focused) {
      throw new Error(`Third Mermaid Ctrl+Z was blocked inside its source editor: ${JSON.stringify(mermaidThirdUndo)}`);
    }

    for (let index = 0; index < 3; index += 1) {
      await pressShortcut(page, 'y');
    }
    const mermaidRedo = await page.evaluate(() => {
      const editor = (window as any).__blockHistoryEditor;
      const innerView = editor.view;
      return {
        text: editor.view.state.doc.toString(),
        focused: Boolean(innerView?.hasFocus),
        head: innerView?.state.selection.main.head ?? null
      };
    });
    if (!mermaidRedo.text.includes('MERMAID_ONE_TWO_THREE') || !mermaidRedo.focused) {
      throw new Error(`Mermaid Ctrl+Y was blocked inside its source editor: ${JSON.stringify(mermaidRedo)}`);
    }

    await page.click('.meo-md-math-fenced-display .katex');
    await waitForFrames(page);
    await page.keyboard.press('End');
    await page.keyboard.type('MATH_ONE');
    await roundTripLatestHistory(page);
    await page.keyboard.type('_TWO');
    await waitForFrames(page);

    await pressShortcut(page, 'z');
    const mathFirstUndo = await page.evaluate(() => {
      const editor = (window as any).__blockHistoryEditor;
      const innerView = editor.view;
      return {
        text: editor.view.state.doc.toString(),
        source: innerView?.state.doc.lineAt(innerView.state.selection.main.head).text ?? null,
        focused: Boolean(innerView?.hasFocus)
      };
    });
    if (mathFirstUndo.source !== 'x = 1MATH_ONE' || !mathFirstUndo.focused) {
      throw new Error(`First formula Ctrl+Z was blocked inside its source editor: ${JSON.stringify(mathFirstUndo)}`);
    }

    await pressShortcut(page, 'z');
    const mathSecondUndo = await page.evaluate(() => {
      const editor = (window as any).__blockHistoryEditor;
      const innerView = editor.view;
      return {
        text: editor.view.state.doc.toString(),
        source: innerView?.state.doc.lineAt(innerView.state.selection.main.head).text ?? null,
        focused: Boolean(innerView?.hasFocus)
      };
    });
    if (mathSecondUndo.source !== 'x = 1' || !mathSecondUndo.focused) {
      throw new Error(`Second formula Ctrl+Z was blocked inside its source editor: ${JSON.stringify(mathSecondUndo)}`);
    }

    await pressShortcut(page, 'y');
    await pressShortcut(page, 'y');
    const mathRedo = await page.evaluate(() => {
      const editor = (window as any).__blockHistoryEditor;
      const innerView = editor.view;
      return {
        text: editor.view.state.doc.toString(),
        source: innerView?.state.doc.lineAt(innerView.state.selection.main.head).text ?? null,
        focused: Boolean(innerView?.hasFocus)
      };
    });
    if (mathRedo.source !== 'x = 1MATH_ONE_TWO' || !mathRedo.focused) {
      throw new Error(`Formula Ctrl+Y was blocked inside its source editor: ${JSON.stringify(mathRedo)}`);
    }

    const tallMermaidText = [
      'before block',
      '```mermaid',
      'graph TD',
      ...Array.from({ length: 80 }, (_, index) => `NODE_${index} --> NODE_${index + 1}`),
      '```',
      ...Array.from({ length: 60 }, (_, index) => `after block ${index + 1}`)
    ].join('\n');
    await page.evaluate(({ text, settlementSource }) => {
      (window as any).__blockHistoryEditor.destroy();
      const app = document.getElementById('app')!;
      app.replaceChildren();
      const receipt = {
        currentBlock: null as HTMLElement | null,
        currentSource: null as HTMLElement | null,
        currentModeButton: null as HTMLButtonElement | null,
        observer: null as MutationObserver | null,
        modeAccepted: false,
        publish: null as (() => void) | null
      };
      const publish = () => {
        receipt.currentBlock = app.querySelector<HTMLElement>(':scope > .cm-editor');
        receipt.currentSource = receipt.currentBlock;
        receipt.currentModeButton = app.querySelector<HTMLButtonElement>('.meo-mermaid-mode-btn');
        if (app.querySelector('.meo-mermaid-toolbar[data-meo-mermaid-mode="edit"]') && !receipt.modeAccepted) receipt.modeAccepted = true;
      };
      receipt.observer = new MutationObserver(publish);
      receipt.observer.observe(app, { childList: true, subtree: true });
      receipt.publish = publish;
      (window as any).__mermaidBlockReceipt = receipt;

      const installSettlement = (0, eval)(`(${settlementSource})`) as typeof installCausalFrameSettlement;
      let tracker!: ReturnType<typeof installCausalFrameSettlement>;
      tracker = installSettlement(window, () => {
        const editor = (window as any).__blockHistoryEditor;
        const scroller = document.querySelector<HTMLElement>('#app > .cm-editor .cm-scroller')!;
        const frame = {
          markerRemoved: !editor.getText().includes('STALE_MEASURE'),
          sourceConnected: Boolean(receipt.currentSource?.isConnected),
          scrollTop: scroller.scrollTop
        };
        if (tracker.diagnostics().phase === 'complete') app.dataset.staleMermaidSettled = 'true';
        return frame;
      });
      const endRoot = tracker.beginExternalRoot();
      (window as any).__staleInnerMeasureSettlement = { applied: false, endRoot, tracker };
      (window as any).__blockHistoryEditor = (window as any).MermaidEditingHarness.createEditor({
        parent: app,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
      publish();
    }, { text: tallMermaidText, settlementSource: causalFrameSettlementSource });
    await enterMermaidSource(page, '__blockHistoryEditor', 2, 'end');
    const sourceInputStart = await page.evaluate(() => {
      const source = (window as any).__blockHistoryEditor.view.dom as HTMLElement;
      const block = source.querySelector<HTMLElement>('.meo-mermaid-toolbar');
      return {
        scrollTop: document.querySelector<HTMLElement>('#app > .cm-editor .cm-scroller')!.scrollTop,
        focused: Boolean(source?.contains(document.activeElement)),
        mode: block?.dataset.meoMermaidMode ?? 'edit'
      };
    });
    await page.keyboard.type('STALE_MEASURE');
    const sourceInputProjection = await page.evaluate((marker) => {
      const editor = (window as any).__blockHistoryEditor;
      const block = editor.view.dom as HTMLElement;
      const sourceEditor = editor.view.contentDOM as HTMLElement;
      const scroller = document.querySelector<HTMLElement>('#app > .cm-editor .cm-scroller')!;
      return {
        markerProjected: editor.getText().includes(marker),
        textSuffix: editor.getText().slice(-80),
        mode: block?.dataset.meoMermaidMode ?? 'edit',
        sourceConnected: Boolean(block?.isConnected && sourceEditor?.isConnected),
        sourceFocused: Boolean(sourceEditor?.contains(document.activeElement)),
        scrollTop: scroller.scrollTop
      };
    }, 'STALE_MEASURE');
    if (
      !sourceInputProjection.markerProjected ||
      !sourceInputProjection.sourceConnected ||
      !sourceInputProjection.sourceFocused ||
      !sourceInputStart.focused ||
      Math.abs(sourceInputProjection.scrollTop - sourceInputStart.scrollTop) > 1
    ) {
      throw new Error(`Tall Mermaid source input lost its current projection: ${JSON.stringify({
        sourceInputStart,
        sourceInputProjection
      })}`);
    }
    await page.keyboard.down('Control');
    await page.keyboard.press('z');
    await page.keyboard.up('Control');
    await page.evaluate(() => {
      const editor = (window as any).__blockHistoryEditor;
      const scroller = document.querySelector<HTMLElement>('#app > .cm-editor .cm-scroller')!;
      const receipt = (window as any).__mermaidBlockReceipt as {
        currentBlock: HTMLElement | null;
        observer: MutationObserver;
      };
      const state = (window as any).__staleInnerMeasureSettlement;
      try {
        const currentBlock = receipt.currentBlock;
        if (!currentBlock?.isConnected) {
          state.tracker.reject('Undo completed without a connected current Mermaid block');
          throw new Error('Undo completed without a connected current Mermaid block');
        }
        state.applied = !editor.getText().includes('STALE_MEASURE');
        if (!state.applied) {
          state.tracker.reject('Keyboard undo did not remove the Mermaid marker');
          throw new Error('Keyboard undo did not remove the Mermaid marker');
        }
        scroller.scrollTop += currentBlock.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }));
        state.tracker.accept();
      } catch (error) {
        receipt.observer.disconnect();
        state.tracker.dispose();
        throw error;
      } finally {
        state.endRoot();
      }
    });
    try {
      await page.waitForSelector('#app[data-stale-mermaid-settled="true"]');
    } catch (error) {
      const diagnostics = await page.evaluate(() => (
        (window as any).__staleInnerMeasureSettlement?.tracker.diagnostics() ?? null
      ));
      throw new Error(`Stale Mermaid causal settlement did not complete: ${JSON.stringify(diagnostics)}`, { cause: error });
    }
    const staleInnerMeasure = await page.evaluate(() => {
      const editor = (window as any).__blockHistoryEditor;
      const scroller = document.querySelector<HTMLElement>('#app > .cm-editor .cm-scroller')!;
      const state = (window as any).__staleInnerMeasureSettlement;
      const receipt = (window as any).__mermaidBlockReceipt;
      const trace = state.tracker.trace();
      const diagnostics = state.tracker.diagnostics();
      const currentBlock = receipt.currentBlock as HTMLElement | null;
      receipt.observer.disconnect();
      state.tracker.dispose();
      delete document.getElementById('app')!.dataset.staleMermaidSettled;
      delete (window as any).__staleInnerMeasureSettlement;
      delete (window as any).__mermaidBlockReceipt;
      return {
        applied: state.applied,
        markerRemoved: !editor.getText().includes('STALE_MEASURE'),
        sourceConnected: Boolean(currentBlock?.isConnected),
        scrollTop: scroller.scrollTop,
        trace,
        diagnostics
      };
    });
    if (
      !staleInnerMeasure.applied ||
      !staleInnerMeasure.markerRemoved ||
      !staleInnerMeasure.sourceConnected ||
      staleInnerMeasure.scrollTop > 1 ||
      staleInnerMeasure.trace.length === 0 ||
      staleInnerMeasure.trace.some((frame: { scrollTop: number }) => frame.scrollTop > 1) ||
      staleInnerMeasure.diagnostics.phase !== 'complete'
    ) {
      throw new Error(`Stale Mermaid inner measure overrode a newer wheel: ${JSON.stringify(staleInnerMeasure)}`);
    }

    await page.evaluate((text) => {
      (window as any).__blockHistoryEditor.destroy();
      const app = document.getElementById('app')!;
      app.replaceChildren();
      app.style.display = 'grid';
      app.style.gridTemplateRows = '1fr 1fr';
      const firstHost = document.createElement('div');
      const secondHost = document.createElement('div');
      firstHost.id = 'multi-mermaid-first';
      secondHost.id = 'multi-mermaid-second';
      firstHost.style.minHeight = secondHost.style.minHeight = '0';
      app.append(firstHost, secondHost);
      (window as any).__multiMermaidFirst = (window as any).MermaidEditingHarness.createEditor({
        parent: firstHost,
        text: text.replace('before block', 'first before block'),
        initialMode: 'live',
        onApplyChanges() {}
      });
      (window as any).__multiMermaidSecond = (window as any).MermaidEditingHarness.createEditor({
        parent: secondHost,
        text: text.replace('before block', 'second before block'),
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, tallMermaidText);

    await enterMermaidSource(page, '__multiMermaidFirst', 2, 'end');
    const firstMultiScrollTop = await page.evaluate(() => (
      document.querySelector<HTMLElement>('#multi-mermaid-first > .cm-editor .cm-scroller')!.scrollTop
    ));
    await page.keyboard.type('MULTI_FIRST');

    await enterMermaidSource(page, '__multiMermaidSecond', 2, 'end');
    const secondMultiScrollTop = await page.evaluate(() => (
      document.querySelector<HTMLElement>('#multi-mermaid-second > .cm-editor .cm-scroller')!.scrollTop
    ));
    await page.keyboard.type('MULTI_SECOND');

    const multiBeforeDestroy = await page.evaluate(({ firstTop, secondTop }) => {
      const first = (window as any).__multiMermaidFirst;
      const second = (window as any).__multiMermaidSecond;
      const firstHost = document.getElementById('multi-mermaid-first')!;
      const secondHost = document.getElementById('multi-mermaid-second')!;
      const firstScroller = firstHost.querySelector<HTMLElement>(':scope > .cm-editor .cm-scroller')!;
      const secondScroller = secondHost.querySelector<HTMLElement>(':scope > .cm-editor .cm-scroller')!;
      const secondSource = second.view.dom as HTMLElement;
      return {
        firstMarker: first.getText().includes('MULTI_FIRST'),
        firstSuffix: first.getText().slice(-80),
        firstIsolated: !first.getText().includes('MULTI_SECOND'),
        secondMarker: second.getText().includes('MULTI_SECOND'),
        secondSuffix: second.getText().slice(-80),
        secondMode: secondHost.querySelector<HTMLElement>('.meo-mermaid-toolbar')?.dataset.meoMermaidMode ?? null,
        secondIsolated: !second.getText().includes('MULTI_FIRST'),
        firstTop,
        firstActualTop: firstScroller.scrollTop,
        secondTop,
        secondActualTop: secondScroller.scrollTop,
        firstScrollStable: Math.abs(firstScroller.scrollTop - firstTop) <= 1,
        secondScrollStable: Math.abs(secondScroller.scrollTop - secondTop) <= 1,
        secondFocused: Boolean(secondSource?.contains(document.activeElement))
      };
    }, { firstTop: firstMultiScrollTop, secondTop: secondMultiScrollTop });
    if (
      !multiBeforeDestroy.firstMarker ||
      !multiBeforeDestroy.firstIsolated ||
      !multiBeforeDestroy.secondMarker ||
      !multiBeforeDestroy.secondIsolated ||
      !multiBeforeDestroy.firstScrollStable ||
      !multiBeforeDestroy.secondScrollStable ||
      !multiBeforeDestroy.secondFocused
    ) {
      throw new Error(`Concurrent Mermaid source projections were not isolated: ${JSON.stringify(multiBeforeDestroy)}`);
    }

    await page.evaluate(() => {
      (window as any).__multiMermaidFirst.destroy();
    });
    await waitForFrames(page);
    const multiAfterDestroy = await page.evaluate((secondTop) => {
      const second = (window as any).__multiMermaidSecond;
      const secondHost = document.getElementById('multi-mermaid-second')!;
      const secondScroller = secondHost.querySelector<HTMLElement>(':scope > .cm-editor .cm-scroller')!;
      const secondSource = second.view.dom as HTMLElement;
      return {
        marker: second.getText().includes('MULTI_SECOND'),
        connected: Boolean(second.view.dom.isConnected),
        focused: Boolean(secondSource?.contains(document.activeElement)),
        scrollStable: Math.abs(secondScroller.scrollTop - secondTop) <= 1,
        expectedTop: secondTop,
        actualTop: secondScroller.scrollTop
      };
    }, secondMultiScrollTop);
    if (!multiAfterDestroy.marker || !multiAfterDestroy.connected || !multiAfterDestroy.focused || !multiAfterDestroy.scrollStable) {
      throw new Error(`Destroying one Mermaid editor affected the other: ${JSON.stringify(multiAfterDestroy)}`);
    }
    // Destruction must retain the other viewport. Further input can wrap at
    // the bottom edge, so its separate contract is a visible, focused caret.
    await page.keyboard.type('_AFTER_FIRST_DESTROY');
    await waitForFrames(page);
    const multiAfterInput = await page.evaluate(() => {
      const host = document.getElementById('multi-mermaid-second')!;
      const inner = (window as any).__multiMermaidSecond.view;
      const source = inner.contentDOM as HTMLElement;
      const block = inner.dom as HTMLElement;
      const caret = inner?.coordsAtPos(inner.state.selection.main.head);
      const bounds = host.querySelector<HTMLElement>(':scope > .cm-editor .cm-scroller')!.getBoundingClientRect();
      return {
        marker: (window as any).__multiMermaidSecond.getText().includes('MULTI_SECOND_AFTER_FIRST_DESTROY'),
        connected: Boolean(block?.isConnected),
        focused: Boolean(source?.contains(document.activeElement)),
        caretVisible: Boolean(caret && caret.top >= bounds.top && caret.bottom <= bounds.bottom)
      };
    });
    if (!multiAfterInput.marker || !multiAfterInput.connected || !multiAfterInput.focused || !multiAfterInput.caretVisible) {
      throw new Error(`Remaining Mermaid input lost its visible caret: ${JSON.stringify(multiAfterInput)}`);
    }
    await page.evaluate(() => {
      (window as any).__multiMermaidSecond.destroy();
    });

    console.log('block inner history checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
