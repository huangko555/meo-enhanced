import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const root = path.resolve(import.meta.dir, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-sticky-production-'));

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(root, 'scripts', 'test-table-sticky-header-production-entry.ts')],
    outdir: temp, target: 'browser', format: 'iife', naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));
  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 960, height: 430 });
    await page.setContent('<!doctype html><div id="outer"><div class="spacer"></div><div id="host"></div><div class="tail"></div></div>');
    await page.addStyleTag({ path: path.join(root, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({ content: `
      :root{--meo-background:#24292e;--meo-inset-background:#2a2d2f;--meo-foreground:#e6edf3;--meo-semantic-tableBorder:#474b50}
      html,body{height:100%;margin:0}#outer{height:390px;overflow-y:auto}#host{height:330px;width:360px}#host .meo-md-html-table{min-width:520px}.spacer{height:70px}.tail{height:260px}
    ` });
    await page.addScriptTag({ path: path.join(temp, 'bundle.js') });
    const result = await page.evaluate(async () => {
      const harness = (window as any).TableStickyHeaderProductionHarness;
      const postMessages: unknown[] = [];
      harness.initializeImageHandling({ postMessage: (message: unknown) => postMessages.push(message) });
      const outer = document.getElementById('outer')!;
      const host = document.getElementById('host')!;
      const nativeFrame = window.requestAnimationFrame.bind(window);
      let editor: any;
      const state = () => {
        const scroller = editor?.view.scrollDOM as HTMLElement | undefined;
        const chrome = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome');
        const stickyTable = chrome?.querySelector<HTMLElement>('.meo-md-html-table-sticky-table');
        return {
          visible: Boolean(chrome && getComputedStyle(chrome).display !== 'none'),
          chromeTop: chrome?.getBoundingClientRect().top ?? null,
          scrollerTop: scroller?.getBoundingClientRect().top ?? null,
          transform: stickyTable?.style.transform ?? '',
          count: document.querySelectorAll('.meo-md-html-table-sticky-chrome').length
        };
      };
      const settle = async (action: () => void, accepted: () => boolean, returnIsAcceptance = false) => {
        const tracker = harness.installCausalFrameSettlement(window, state);
        let published = false;
        const publish = () => {
          if (!published && accepted()) { published = true; tracker.accept(); }
        };
        const observer = new MutationObserver(publish);
        observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
        tracker.runRoot(() => { action(); if (returnIsAcceptance) publish(); });
        publish();
        await new Promise<void>((resolve, reject) => {
          const poll = () => {
            try {
              publish();
              const diagnostics = tracker.diagnostics();
              if (diagnostics.failure) throw new Error(diagnostics.failure);
              if (diagnostics.phase === 'complete') return resolve();
              nativeFrame(poll);
            } catch (error) { reject(error); }
          };
          nativeFrame(poll);
        });
        observer.disconnect();
        const outcome = { trace: tracker.trace(), diagnostics: tracker.diagnostics() };
        tracker.dispose();
        return outcome;
      };
      const transactions: any[] = [];
      const rows = Array.from({ length: 32 }, (_, i) => `| ${i + 1} | row ${i + 1} wrapping content |`);
      const after = Array.from({ length: 20 }, (_, i) => `after table ${i + 1}`);
      const text = ['before', '', '| Number | Content |', '| ---: | :--- |', ...rows, '', ...after].join('\n');
      transactions.push(await settle(() => {
        editor = harness.createEditor({ parent: host, text, initialMode: 'live', onApplyChanges() {} });
      }, () => Boolean(document.querySelector('.meo-md-html-table'))));
      const initialHidden = !state().visible;
      const scroller = editor.view.scrollDOM as HTMLElement;
      const header = document.querySelector<HTMLElement>('.meo-md-html-table thead')!;
      transactions.push(await settle(() => {
        scroller.scrollTop += Math.max(1, header.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + 8);
        scroller.dispatchEvent(new Event('scroll'));
      }, () => state().visible));
      const appeared = state();

      const input = document.querySelector<HTMLTextAreaElement>('.meo-md-html-table tbody textarea')!;
      transactions.push(await settle(() => input.focus({ preventScroll: true }), () => (
        document.querySelector('.meo-md-html-table-sticky-chrome')?.classList.contains('has-sticky-controls') ?? false
      )));
      const chrome = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome')!;
      const toolbar = document.querySelector<HTMLElement>('.meo-md-html-table-toolbar')!;
      const stickyHeader = chrome.querySelector<HTMLElement>('.meo-md-html-table-sticky-header')!;
      const controls = [toolbar.getBoundingClientRect().top, chrome.getBoundingClientRect().top,
        stickyHeader.getBoundingClientRect().top, toolbar.getBoundingClientRect().height];
      input.blur();

      transactions.push(await settle(() => {
        outer.scrollTop = 28; outer.dispatchEvent(new Event('scroll'));
      }, () => state().visible && Math.abs(state().chromeTop! - state().scrollerTop!) <= 1));
      const outerAligned = state();
      const wrap = document.querySelector<HTMLElement>('.meo-md-html-table-wrap')!;
      transactions.push(await settle(() => {
        wrap.scrollLeft = 42; wrap.dispatchEvent(new Event('scroll'));
      }, () => true, true));
      const colWidths = (selector: string) => Array.from(document.querySelectorAll<HTMLElement>(selector))
        .map((col) => col.getBoundingClientRect().width);
      const domContract = {
        normalCols: colWidths('.meo-md-html-table:not(.meo-md-html-table-sticky-table) colgroup col'),
        stickyCols: colWidths('.meo-md-html-table-sticky-table colgroup col'),
        normalHandles: document.querySelectorAll('.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead .meo-md-html-table-column-resize-handle').length,
        stickyHandles: document.querySelectorAll('.meo-md-html-table-sticky-table thead .meo-md-html-table-column-resize-handle').length,
        interactive: document.querySelectorAll('.meo-md-html-table-sticky-header textarea, .meo-md-html-table-sticky-header input, .meo-md-html-table-sticky-header button, .meo-md-html-table-sticky-header a[href], .meo-md-html-table-sticky-header [contenteditable]:not([contenteditable="false"])').length,
        wrapOverflow: getComputedStyle(wrap).overflowX,
        lineNumbers: Boolean(document.querySelector('.meo-md-html-table-line-numbers')),
        horizontalScroll: wrap.scrollLeft,
        firstColumnDelta: Math.abs(
          document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead th')!.getBoundingClientRect().left -
          document.querySelector<HTMLElement>('.meo-md-html-table-sticky-table thead th')!.getBoundingClientRect().left
        )
      };
      transactions.push(await settle(() => {
        scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
        scroller.dispatchEvent(new Event('scroll'));
      }, () => true, true));
      const hiddenAtTail = !state().visible;
      const tailState = { ...state(), scrollTop: scroller.scrollTop, maxScroll: scroller.scrollHeight - scroller.clientHeight };

      transactions.push(await settle(() => editor.setText(editor.getText()), () => true, true));
      const equalExternalCount = state().count;
      transactions.push(await settle(() => editor.setText(`prefix\n\n${editor.getText()}`), () => true, true));
      const changedExternal = { count: state().count, text: editor.getText() };
      transactions.push(await settle(() => editor.setMode('source'), () => true, true));
      const sourceCount = state().count;
      transactions.push(await settle(() => editor.setMode('live'), () => true, true));
      const liveCount = state().count;
      transactions.push(await settle(() => { host.hidden = true; window.dispatchEvent(new Event('resize')); }, () => !state().visible));
      const previewVisible = state().visible;
      host.hidden = false;

      const delayedResolvers: Array<(value: string) => void> = [];
      const resolvedImage = 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>'
      );
      let delayedImageReady = false;
      harness.setImageSrcResolver((url: string) => url === 'late-sticky.png'
        ? delayedImageReady
          ? resolvedImage
          : new Promise<string>((resolve) => delayedResolvers.push(resolve))
        : url);
      const delayedRows = Array.from({ length: 32 }, (_, i) => `| ${i + 1} | delayed row ${i + 1} |`);
      const delayedText = [
        'before', '', '| ![slow](late-sticky.png) | Content |', '| --- | --- |',
        ...delayedRows, '', ...after
      ].join('\n');
      transactions.push(await settle(() => editor.setText(delayedText), () => delayedResolvers.length > 0));
      const pendingBeforeReplacement = delayedResolvers.length;
      const delayedScroller = editor.view.scrollDOM as HTMLElement;
      transactions.push(await settle(() => {
        delayedScroller.scrollTop = 0;
        const delayedHeader = document.querySelector<HTMLElement>(
          '.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead'
        )!;
        delayedScroller.scrollTop = Math.max(
          1,
          delayedHeader.getBoundingClientRect().bottom - delayedScroller.getBoundingClientRect().top + 8
        );
        delayedScroller.dispatchEvent(new Event('scroll'));
      }, () => true, true));
      const detachedStickyCell = document.querySelector<HTMLElement>(
        '.meo-md-html-table-sticky-table thead th'
      )!;
      let detachedCloneMutated = false;
      const detachedCloneObserver = new MutationObserver((records) => {
        detachedCloneMutated = true;
        for (const record of records) {
          for (const added of Array.from(record.addedNodes)) {
            if (!(added instanceof Element)) continue;
            const buttons = added.matches('.meo-md-image-controls button')
              ? [added]
              : Array.from(added.querySelectorAll('.meo-md-image-controls button'));
            for (const button of buttons) {
              button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
            }
          }
        }
      });
      detachedCloneObserver.observe(detachedStickyCell, { attributes: true, childList: true, subtree: true });
      const replacementText = delayedText.replace('Content |', 'Content updated |');
      transactions.push(await settle(() => editor.setText(replacementText), () => (
        editor.getText() === replacementText && !detachedStickyCell.isConnected
      )));
      const pendingAfterReplacement = delayedResolvers.length;
      const detachedAfterReplacement = !detachedStickyCell.isConnected;
      transactions.push(await settle(() => {
        delayedImageReady = true;
        for (const resolve of delayedResolvers.splice(0)) resolve(resolvedImage);
      }, () => Boolean(
        document.querySelector('.meo-md-html-table-sticky-header .meo-md-image-img')
      )));
      detachedCloneObserver.disconnect();
      const detachedCloneBehavior = {
        detachedAfterReplacement,
        mutated: detachedCloneMutated,
        openPosted: postMessages.some((message: any) => message?.type === 'openImageExternally'),
        fullscreenOpened: Boolean(document.querySelector('.meo-md-image-fullscreen-scrim'))
      };
      document.querySelector<HTMLElement>('.meo-md-image-fullscreen-scrim')?.remove();
      postMessages.length = 0;

      const mainControls = document.querySelector<HTMLElement>(
        '.meo-md-html-table:not(.meo-md-html-table-sticky-table) .meo-md-image-controls'
      )!;
      mainControls.querySelector<HTMLButtonElement>('[aria-label="Open with system app"]')!
        .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      const mainOpenPosted = postMessages.some((message: any) => message?.type === 'openImageExternally');
      mainControls.querySelector<HTMLButtonElement>('[aria-label="Fullscreen image"]')!
        .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      const mainFullscreenOpened = Boolean(document.querySelector('.meo-md-image-fullscreen-scrim'));
      document.querySelector<HTMLElement>('.meo-md-image-fullscreen-scrim')?.remove();
      const stickyPostCountBefore = postMessages.length;
      const lateStickyButton = document.querySelector<HTMLButtonElement>(
        '.meo-md-html-table-sticky-header .meo-md-image-controls button'
      );
      lateStickyButton?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      const delayedImageContract = {
        stickyControls: document.querySelectorAll(
          '.meo-md-html-table-sticky-header .meo-md-image-controls button'
        ).length,
        commandExecuted: Boolean(document.querySelector('.meo-md-image-fullscreen-scrim')),
        openPosted: postMessages.length > stickyPostCountBefore,
        fullscreenOpened: Boolean(document.querySelector('.meo-md-image-fullscreen-scrim')),
        mainOpenPosted,
        mainFullscreenOpened,
        stickyHandles: document.querySelectorAll(
          '.meo-md-html-table-sticky-table thead .meo-md-html-table-column-resize-handle'
        ).length,
        sourcePresented: Boolean(document.querySelector(
          '.meo-md-html-table:not(.meo-md-html-table-sticky-table) .meo-md-image-img'
        ))
      };

      const disposeResolvers: Array<(value: string) => void> = [];
      let disposeImageReady = false;
      harness.setImageSrcResolver((url: string) => url === 'dispose-sticky.png'
        ? disposeImageReady
          ? resolvedImage
          : new Promise<string>((resolve) => disposeResolvers.push(resolve))
        : url);
      const disposeText = [
        'before', '', '| ![dispose](dispose-sticky.png) | Content |', '| --- | --- |',
        ...delayedRows, '', ...after
      ].join('\n');
      transactions.push(await settle(() => editor.setText(disposeText), () => disposeResolvers.length > 0));

      const oldScroller = editor.view.scrollDOM as HTMLElement;
      const detached = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-table-sticky-chrome'));
      transactions.push(await settle(() => editor.destroy(), () => true, true));
      let lateWrites = 0;
      const lateObserver = new MutationObserver((records) => { lateWrites += records.length; });
      detached.forEach((node) => lateObserver.observe(node, { attributes: true, childList: true, subtree: true }));
      transactions.push(await settle(() => {
        disposeImageReady = true;
        for (const resolve of disposeResolvers.splice(0)) resolve(resolvedImage);
        oldScroller.dispatchEvent(new Event('scroll')); outer.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('resize'));
      }, () => true, true));
      lateObserver.disconnect();
      return { transactions, initialHidden, appeared, controls, outerAligned, domContract,
        hiddenAtTail, tailState, equalExternalCount, changedExternal, sourceCount, liveCount, previewVisible,
        pendingBeforeReplacement, pendingAfterReplacement, delayedImageContract, detachedCloneBehavior,
        afterDispose: state().count, lateWrites };
    });

    result.transactions.forEach((transaction: any) => {
      assert.deepEqual(transaction.diagnostics, { phase:'complete', rootReturned:true, acceptances:1,
        pendingMicrotasks:0, pendingFrames:0, failure:null });
      assert.ok(transaction.trace.length >= 2);
    });
    assert.equal(result.initialHidden, true);
    assert.equal(result.appeared.visible, true);
    assert.ok(Math.abs(result.appeared.chromeTop - result.appeared.scrollerTop) <= 1);
    assert.ok(Math.abs(result.controls[0] - result.controls[1]) <= 1);
    assert.ok(Math.abs(result.controls[2] - result.controls[1] - result.controls[3]) <= 1);
    assert.ok(Math.abs(result.outerAligned.chromeTop - result.outerAligned.scrollerTop) <= 1);
    assert.deepEqual(result.domContract.stickyCols, result.domContract.normalCols);
    assert.deepEqual([result.domContract.normalHandles, result.domContract.stickyHandles], [2, 2]);
    assert.equal(result.domContract.interactive, 0);
    assert.ok(result.domContract.horizontalScroll > 0);
    assert.ok(result.domContract.firstColumnDelta <= 1);
    assert.match(result.domContract.wrapOverflow, /auto|scroll/);
    assert.equal(result.domContract.lineNumbers, true);
    assert.equal(result.hiddenAtTail, true, JSON.stringify(result.tailState));
    assert.equal(result.equalExternalCount, 1);
    assert.equal(result.changedExternal.count, 1);
    assert.match(result.changedExternal.text, /^prefix/);
    assert.deepEqual([result.sourceCount, result.liveCount, result.previewVisible], [0, 1, false]);
    assert.equal(result.delayedImageContract.stickyControls, 0);
    assert.deepEqual([result.pendingBeforeReplacement, result.pendingAfterReplacement], [1, 2]);
    assert.equal(result.delayedImageContract.commandExecuted, false);
    assert.deepEqual([
      result.delayedImageContract.openPosted,
      result.delayedImageContract.fullscreenOpened,
      result.delayedImageContract.mainOpenPosted,
      result.delayedImageContract.mainFullscreenOpened
    ], [false, false, true, true]);
    assert.equal(result.delayedImageContract.stickyHandles, 2);
    assert.equal(result.delayedImageContract.sourcePresented, true);
    assert.deepEqual(result.detachedCloneBehavior, {
      detachedAfterReplacement: true,
      mutated: false,
      openPosted: false,
      fullscreenOpened: false
    });
    assert.deepEqual([result.afterDispose, result.lateWrites], [0, 0]);
  } finally {
    await browser.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

await main();
console.log('table sticky header production Chromium contract passed');
