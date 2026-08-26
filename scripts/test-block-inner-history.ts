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

    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);
    await page.evaluate(() => {
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block')! as any;
      const innerView = block.__meoMermaidEditingController.innerView;
      block.__meoMermaidEditingController.focusOffset(innerView.state.doc.length);
    });
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
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block');
      const innerView = (block as any)?.__meoMermaidEditingController?.innerView;
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
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block');
      const innerView = (block as any)?.__meoMermaidEditingController?.innerView;
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
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block');
      const innerView = (block as any)?.__meoMermaidEditingController?.innerView;
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
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block');
      const innerView = (block as any)?.__meoMermaidEditingController?.innerView;
      return {
        text: editor.view.state.doc.toString(),
        focused: Boolean(innerView?.hasFocus),
        head: innerView?.state.selection.main.head ?? null
      };
    });
    if (!mermaidRedo.text.includes('MERMAID_ONE_TWO_THREE') || !mermaidRedo.focused) {
      throw new Error(`Mermaid Ctrl+Y was blocked inside its source editor: ${JSON.stringify(mermaidRedo)}`);
    }

    await page.click('.meo-latex-math-mode-btn');
    await waitForFrames(page);
    await page.evaluate(() => {
      const block = document.querySelector<HTMLElement>('.meo-latex-math-editing-block')! as any;
      const innerView = block.__meoLatexMathEditingController.innerView;
      block.__meoLatexMathEditingController.focusOffset(innerView.state.doc.length);
    });
    await page.keyboard.type('MATH_ONE');
    await roundTripLatestHistory(page);
    await page.keyboard.type('_TWO');
    await waitForFrames(page);

    await pressShortcut(page, 'z');
    const mathFirstUndo = await page.evaluate(() => {
      const editor = (window as any).__blockHistoryEditor;
      const block = document.querySelector<HTMLElement>('.meo-latex-math-editing-block');
      const innerView = (block as any)?.__meoLatexMathEditingController?.innerView;
      return {
        text: editor.view.state.doc.toString(),
        source: innerView?.state.doc.toString() ?? null,
        focused: Boolean(innerView?.hasFocus)
      };
    });
    if (mathFirstUndo.source !== 'x = 1MATH_ONE' || !mathFirstUndo.focused) {
      throw new Error(`First formula Ctrl+Z was blocked inside its source editor: ${JSON.stringify(mathFirstUndo)}`);
    }

    await pressShortcut(page, 'z');
    const mathSecondUndo = await page.evaluate(() => {
      const editor = (window as any).__blockHistoryEditor;
      const block = document.querySelector<HTMLElement>('.meo-latex-math-editing-block');
      const innerView = (block as any)?.__meoLatexMathEditingController?.innerView;
      return {
        text: editor.view.state.doc.toString(),
        source: innerView?.state.doc.toString() ?? null,
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
      const block = document.querySelector<HTMLElement>('.meo-latex-math-editing-block');
      const innerView = (block as any)?.__meoLatexMathEditingController?.innerView;
      return {
        text: editor.view.state.doc.toString(),
        source: innerView?.state.doc.toString() ?? null,
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
        receipt.currentBlock = app.querySelector<HTMLElement>('.meo-mermaid-editing-block');
        receipt.currentSource = receipt.currentBlock?.querySelector<HTMLElement>('.meo-mermaid-source-editor') ?? null;
        receipt.currentModeButton = app.querySelector<HTMLButtonElement>('.meo-mermaid-mode-btn');
        if (receipt.currentSource?.isConnected && !receipt.modeAccepted) receipt.modeAccepted = true;
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
    const sourceModeAction = await page.evaluate(() => (
      (window as any).__mermaidBlockReceipt.currentModeButton?.getAttribute('aria-label') ?? null
    ));
    if (sourceModeAction === 'Edit Mermaid in split view') {
      await page.evaluate(() => {
        const receipt = (window as any).__mermaidBlockReceipt;
        receipt.publish();
        const button = receipt.currentModeButton as HTMLButtonElement | null;
        if (!button?.isConnected) throw new Error('Current Mermaid mode button was not connected');
        button.click();
        receipt.publish();
        if (receipt.currentModeButton?.getAttribute('aria-label') === 'Edit Mermaid in split view') {
          throw new Error('Current Mermaid mode button did not publish source mode');
        }
      });
    } else if (sourceModeAction !== 'Show Mermaid code only' && sourceModeAction !== 'Show Mermaid preview') {
      throw new Error(`Unexpected Mermaid mode receipt: ${JSON.stringify(sourceModeAction)}`);
    }
    await page.evaluate(async () => {
      const editor = (window as any).__blockHistoryEditor;
      const receipt = (window as any).__mermaidBlockReceipt;
      await editor.scrollToLine(2, 'center');
      receipt.publish();
      const content = receipt.currentSource?.querySelector<HTMLElement>('.cm-content') ?? null;
      if (!content?.isConnected) {
        const modeLabel = document.querySelector<HTMLButtonElement>('.meo-mermaid-mode-btn')?.getAttribute('aria-label');
        throw new Error(`Public scroll receipt did not mount the current Mermaid source: ${JSON.stringify({ modeLabel })}`);
      }
      content.focus({ preventScroll: true });
      if (!receipt.currentSource.contains(document.activeElement)) {
        throw new Error('Current Mermaid source did not retain focus after public scroll receipt');
      }
    });
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    const sourceInputScrollTop = await page.evaluate(() => (
      document.querySelector<HTMLElement>('#app > .cm-editor .cm-scroller')!.scrollTop
    ));
    await page.keyboard.type('STALE_MEASURE');
    const sourceInputProjection = await page.evaluate((marker) => {
      const editor = (window as any).__blockHistoryEditor;
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block');
      const sourceEditor = block?.querySelector<HTMLElement>('.meo-mermaid-source-editor') ?? null;
      const scroller = document.querySelector<HTMLElement>('#app > .cm-editor .cm-scroller')!;
      return {
        markerProjected: editor.getText().includes(marker),
        sourceConnected: Boolean(block?.isConnected && sourceEditor?.isConnected),
        sourceFocused: Boolean(sourceEditor?.contains(document.activeElement)),
        scrollTop: scroller.scrollTop
      };
    }, 'STALE_MEASURE');
    if (
      !sourceInputProjection.markerProjected ||
      !sourceInputProjection.sourceConnected ||
      !sourceInputProjection.sourceFocused ||
      Math.abs(sourceInputProjection.scrollTop - sourceInputScrollTop) > 1
    ) {
      throw new Error(`Tall Mermaid source input lost its current projection: ${JSON.stringify({
        sourceInputScrollTop,
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

    await page.evaluate(() => (window as any).__multiMermaidFirst.scrollToLine(2, 'center'));
    await page.click('#multi-mermaid-first .meo-mermaid-mode-btn');
    await page.evaluate(() => (window as any).__multiMermaidFirst.scrollToLine(2, 'center'));
    await page.evaluate(() => {
      document.querySelector<HTMLElement>(
        '#multi-mermaid-first .meo-mermaid-source-editor .cm-content'
      )!.focus({ preventScroll: true });
    });
    const firstMultiFocused = await page.evaluate(() => (
      document.querySelector<HTMLElement>('#multi-mermaid-first .meo-mermaid-source-editor')
        ?.contains(document.activeElement) ?? false
    ));
    if (!firstMultiFocused) throw new Error('First concurrent Mermaid source did not receive focus');
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    const firstMultiScrollTop = await page.evaluate(() => (
      document.querySelector<HTMLElement>('#multi-mermaid-first > .cm-editor .cm-scroller')!.scrollTop
    ));
    await page.keyboard.type('MULTI_FIRST');

    await page.evaluate(() => (window as any).__multiMermaidSecond.scrollToLine(2, 'center'));
    await page.click('#multi-mermaid-second .meo-mermaid-mode-btn');
    await page.evaluate(() => (window as any).__multiMermaidSecond.scrollToLine(2, 'center'));
    await page.evaluate(() => {
      document.querySelector<HTMLElement>(
        '#multi-mermaid-second .meo-mermaid-source-editor .cm-content'
      )!.focus({ preventScroll: true });
    });
    const secondMultiFocused = await page.evaluate(() => (
      document.querySelector<HTMLElement>('#multi-mermaid-second .meo-mermaid-source-editor')
        ?.contains(document.activeElement) ?? false
    ));
    if (!secondMultiFocused) throw new Error('Second concurrent Mermaid source did not receive focus');
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
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
      const secondSource = secondHost.querySelector<HTMLElement>('.meo-mermaid-source-editor');
      return {
        firstMarker: first.getText().includes('MULTI_FIRST'),
        firstIsolated: !first.getText().includes('MULTI_SECOND'),
        secondMarker: second.getText().includes('MULTI_SECOND'),
        secondIsolated: !second.getText().includes('MULTI_FIRST'),
        firstScrollStable: Math.abs(firstScroller.scrollTop - firstTop) <= 1,
        secondScrollStable: Math.abs(secondScroller.scrollTop - secondTop) <= 1,
        secondFocused: Boolean(secondSource?.contains(document.activeElement))
      };
    }, { firstTop: firstMultiScrollTop, secondTop: secondMultiScrollTop });
    if (Object.values(multiBeforeDestroy).some((value) => value !== true)) {
      throw new Error(`Concurrent Mermaid source projections were not isolated: ${JSON.stringify(multiBeforeDestroy)}`);
    }

    await page.evaluate(() => {
      (window as any).__multiMermaidFirst.destroy();
    });
    await page.keyboard.type('_AFTER_FIRST_DESTROY');
    const multiAfterDestroy = await page.evaluate((secondTop) => {
      const second = (window as any).__multiMermaidSecond;
      const secondHost = document.getElementById('multi-mermaid-second')!;
      const secondScroller = secondHost.querySelector<HTMLElement>(':scope > .cm-editor .cm-scroller')!;
      const secondSource = secondHost.querySelector<HTMLElement>('.meo-mermaid-source-editor');
      return {
        marker: second.getText().includes('MULTI_SECOND_AFTER_FIRST_DESTROY'),
        connected: Boolean(secondHost.querySelector('.meo-mermaid-editing-block')?.isConnected),
        focused: Boolean(secondSource?.contains(document.activeElement)),
        scrollStable: Math.abs(secondScroller.scrollTop - secondTop) <= 1
      };
    }, secondMultiScrollTop);
    if (Object.values(multiAfterDestroy).some((value) => value !== true)) {
      throw new Error(`Destroying one Mermaid editor affected the other: ${JSON.stringify(multiAfterDestroy)}`);
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
