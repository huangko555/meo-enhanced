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
    const runGeometryScenario = async (scenario: {
      dpr: number;
      zoom: number;
      transform?: string;
      dynamicZoom?: number;
      dynamicTransform?: string;
      dynamicShellTransform?: string;
      dynamicRootTransform?: string;
      expectFailure?: boolean;
    }) => {
      const geometryPage = await browser.newPage();
      await geometryPage.setViewport({ width: 960, height: 430, deviceScaleFactor: scenario.dpr });
      await geometryPage.setContent('<!doctype html><div id="outer"><div class="spacer"></div><div id="ancestor"><div id="host"></div></div><div class="tail"></div></div>');
      await geometryPage.addStyleTag({ path: path.join(root, 'webview', 'src', 'styles.css') });
      await geometryPage.addStyleTag({ content: `
        :root{--meo-background:#24292e;--meo-inset-background:#2a2d2f;--meo-foreground:#e6edf3;--meo-semantic-tableBorder:#474b50}
        html,body{height:100%;margin:0}#outer{height:390px;overflow-y:auto}#ancestor{transform:${scenario.transform ?? 'none'};transform-origin:0 0}
        #host{height:330px;width:360px;zoom:${scenario.zoom}}#host .meo-md-html-table{min-width:520px}.spacer{height:70px}.tail{height:260px}
      ` });
      await geometryPage.addScriptTag({ path: path.join(temp, 'bundle.js') });
      const result = await geometryPage.evaluate(async (scenarioInput) => {
      const harness = (window as any).TableStickyHeaderProductionHarness;
      harness.initializeImageHandling({ postMessage() {} });
      const outer = document.getElementById('outer')!;
      const host = document.getElementById('host')!;
      const ancestor = document.getElementById('ancestor')!;
      const nativeFrame = window.requestAnimationFrame.bind(window);
      let editor: any;
      const geometry = () => {
        const scroller = editor?.view.scrollDOM as HTMLElement | undefined;
        const toolbar = document.querySelector<HTMLElement>('.meo-md-html-table-toolbar');
        const chrome = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome');
        const stickyHeader = chrome?.querySelector<HTMLElement>('.meo-md-html-table-sticky-header');
        const mainCell = document.querySelector<HTMLElement>(
          '.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead th'
        );
        const stickyCell = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-table thead th');
        const shell = document.querySelector<HTMLElement>('.meo-md-html-table-shell');
        return {
          scrollerTop: scroller?.getBoundingClientRect().top ?? null,
          toolbarTop: toolbar?.getBoundingClientRect().top ?? null,
          toolbarHeight: toolbar?.getBoundingClientRect().height ?? null,
          toolbarLeft: toolbar?.getBoundingClientRect().left ?? null,
          shellLeft: shell?.getBoundingClientRect().left ?? null,
          chromeTop: chrome?.getBoundingClientRect().top ?? null,
          stickyHeaderTop: stickyHeader?.getBoundingClientRect().top ?? null,
          firstColumnDelta: mainCell && stickyCell
            ? Math.abs(mainCell.getBoundingClientRect().left - stickyCell.getBoundingClientRect().left)
            : null,
          controlsSticky: shell?.classList.contains('is-controls-sticky') ?? false,
          visible: Boolean(chrome && getComputedStyle(chrome).display !== 'none')
        };
      };
      const settle = async (action: () => void, accepted: () => boolean) => {
        const tracker = harness.installCausalFrameSettlement(window, geometry);
        let published = false;
        const publish = () => {
          if (!published && accepted()) { published = true; tracker.accept(); }
        };
        tracker.runRoot(() => { action(); publish(); });
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
        tracker.dispose();
      };
      const rows = Array.from({ length: 32 }, (_, i) => `| ${i + 1} | zoom row ${i + 1} |`);
      const text = [...Array.from({ length: 6 }, (_, index) => `before ${index + 1}`), '',
        '| Number | Content |', '| ---: | :--- |', ...rows,
        '', ...Array.from({ length: 20 }, (_, i) => `after table ${i + 1}`)].join('\n');
      await settle(() => {
        editor = harness.createEditor({ parent: host, text, initialMode: 'live', onApplyChanges() {} });
      }, () => Boolean(document.querySelector('.meo-md-html-table')));
      const scroller = editor.view.scrollDOM as HTMLElement;
      const header = document.querySelector<HTMLElement>('.meo-md-html-table thead')!;
      const input = document.querySelector<HTMLTextAreaElement>('.meo-md-html-table tbody textarea')!;
      await settle(() => {
        outer.scrollTop = 17.5;
        outer.dispatchEvent(new Event('scroll'));
      }, () => true);
      await settle(() => input.focus({ preventScroll: true }), () => (
        document.querySelector('.meo-md-html-table-shell')?.classList.contains('is-interacting') ?? false
      ));
      let threshold: null | {
        beforeGap: number;
        beforeSticky: boolean;
        afterGap: number;
        afterSticky: boolean;
        takeoverDelta: number;
      } = null;
      if (!scenarioInput.expectFailure) {
        const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')!;
        const toolbar = document.querySelector<HTMLElement>('.meo-md-html-table-toolbar')!;
        const beforeGap = table.getBoundingClientRect().top - scroller.getBoundingClientRect().top -
          toolbar.getBoundingClientRect().height;
        const beforeSticky = geometry().controlsSticky;
        if (!(beforeGap > 0) || beforeSticky) {
          throw new Error(`threshold fixture did not start before takeover: ${JSON.stringify({
            beforeGap,
            beforeSticky
          })}`);
        }
        await settle(() => {
          scroller.scrollTop = 160;
          scroller.dispatchEvent(new Event('scroll'));
        }, () => true);
        const afterGeometry = geometry();
        const afterGap = table.getBoundingClientRect().top - scroller.getBoundingClientRect().top -
          toolbar.getBoundingClientRect().height;
        if (!(afterGap <= 0) || !afterGeometry.controlsSticky) {
          throw new Error(`single threshold scroll did not cross takeover: ${JSON.stringify({
            afterGap,
            afterSticky: afterGeometry.controlsSticky,
            scrollTop: scroller.scrollTop
          })}`);
        }
        threshold = {
          beforeGap,
          beforeSticky,
          afterGap,
          afterSticky: afterGeometry.controlsSticky,
          takeoverDelta: Math.abs(afterGeometry.toolbarTop! - afterGeometry.scrollerTop!)
        };
      }
      await settle(() => {
        scroller.scrollTop += Math.max(1,
          header.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + 8);
        scroller.dispatchEvent(new Event('scroll'));
      }, () => scenarioInput.expectFailure || geometry().visible);
      const wrap = document.querySelector<HTMLElement>('.meo-md-html-table-wrap')!;
      await settle(() => {
        wrap.scrollLeft = 42;
        wrap.dispatchEvent(new Event('scroll'));
      }, () => true);
      const before = geometry();
      let after: ReturnType<typeof geometry> | null = null;
      if (scenarioInput.dynamicZoom !== undefined || scenarioInput.dynamicTransform !== undefined ||
        scenarioInput.dynamicShellTransform !== undefined || scenarioInput.dynamicRootTransform !== undefined) {
        await settle(() => {
          if (scenarioInput.dynamicZoom !== undefined) host.style.zoom = String(scenarioInput.dynamicZoom);
          if (scenarioInput.dynamicTransform !== undefined) ancestor.style.transform = scenarioInput.dynamicTransform;
          if (scenarioInput.dynamicShellTransform !== undefined) {
            document.querySelector<HTMLElement>('.meo-md-html-table-shell')!.style.transform =
              scenarioInput.dynamicShellTransform;
          }
          if (scenarioInput.dynamicRootTransform !== undefined) {
            document.documentElement.style.transform = scenarioInput.dynamicRootTransform;
            document.documentElement.style.transformOrigin = '0 0';
          }
        }, () => true);
        after = geometry();
      }
      editor.destroy();
      return { before, after, threshold };
      }, scenario);
      await geometryPage.close();
      return result;
    };
    const assertAlignedGeometry = (geometry: Awaited<ReturnType<typeof runGeometryScenario>>['before']) => {
      assert.equal(geometry.visible, true, JSON.stringify(geometry));
      assert.ok(Math.abs(geometry.toolbarTop! - geometry.scrollerTop!) <= 1, JSON.stringify(geometry));
      assert.ok(Math.abs(geometry.chromeTop! - geometry.scrollerTop!) <= 1, JSON.stringify(geometry));
      assert.ok(Math.abs(geometry.toolbarLeft! - geometry.shellLeft!) <= 1, JSON.stringify(geometry));
      assert.ok(Math.abs(
        geometry.stickyHeaderTop! - geometry.chromeTop! - geometry.toolbarHeight!
      ) <= 1, JSON.stringify(geometry));
      assert.ok(geometry.firstColumnDelta! <= 1, JSON.stringify(geometry));
    };
    for (const dpr of [1, 1.5, 2]) {
      for (const zoom of [0.8, 1, 1.25]) {
        const geometryResult = await runGeometryScenario({ dpr, zoom });
        assert.ok(geometryResult.threshold);
        assert.ok(geometryResult.threshold!.beforeGap > 0, JSON.stringify(geometryResult.threshold));
        assert.equal(geometryResult.threshold!.beforeSticky, false);
        assert.ok(geometryResult.threshold!.afterGap <= 0, JSON.stringify(geometryResult.threshold));
        assert.equal(geometryResult.threshold!.afterSticky, true);
        assert.ok(geometryResult.threshold!.takeoverDelta <= 1, JSON.stringify(geometryResult.threshold));
        assertAlignedGeometry(geometryResult.before);
        if (dpr === 1.5 && zoom === 1.25) {
          assert.ok(Math.abs(geometryResult.before.scrollerTop! - 52.5) <= 1,
            JSON.stringify(geometryResult.before));
        }
      }
    }
    const nestedResult = await runGeometryScenario({
      dpr: 1.5,
      zoom: 0.8,
      transform: 'translate(13px, 7px) scale(1.25, 0.9)'
    });
    assertAlignedGeometry(nestedResult.before);
    const dynamicZoomResult = await runGeometryScenario({
      dpr: 2,
      zoom: 1,
      transform: 'translate(4px, 3px) scale(1.1)',
      dynamicZoom: 1.25
    });
    assertAlignedGeometry(dynamicZoomResult.before);
    assert.ok(dynamicZoomResult.after);
    assertAlignedGeometry(dynamicZoomResult.after!);
    const dynamicTransformResult = await runGeometryScenario({
      dpr: 1.5,
      zoom: 1.25,
      transform: 'translate(4px, 3px) scale(1.1)',
      dynamicTransform: 'translate(17px, 9px) scale(0.85, 1.2)'
    });
    assertAlignedGeometry(dynamicTransformResult.before);
    assert.ok(dynamicTransformResult.after);
    assertAlignedGeometry(dynamicTransformResult.after!);
    const dynamicShellResult = await runGeometryScenario({
      dpr: 1,
      zoom: 1.25,
      dynamicShellTransform: 'translate(11px, 6px) scale(0.9, 1.1)'
    });
    assert.ok(dynamicShellResult.after);
    assertAlignedGeometry(dynamicShellResult.after!);
    const dynamicRootResult = await runGeometryScenario({
      dpr: 2,
      zoom: 0.8,
      dynamicRootTransform: 'translate(7px, 5px) scale(1.15, 0.95)'
    });
    assert.ok(dynamicRootResult.after);
    assertAlignedGeometry(dynamicRootResult.after!);
    for (const transform of ['rotate(5deg)', 'scale(-1, 1)', 'scale(0, 1)']) {
      const failedResult = await runGeometryScenario({
        dpr: 1.5,
        zoom: 1.25,
        transform,
        expectFailure: true
      });
      assert.equal(failedResult.before.controlsSticky, false, JSON.stringify(failedResult.before));
      assert.equal(failedResult.before.visible, false, JSON.stringify(failedResult.before));
    }

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
      const replacementText = delayedText.replace('Content |', 'Content updated |');
      transactions.push(await settle(() => editor.setText(replacementText), () => (
        editor.getText() === replacementText && !detachedStickyCell.isConnected
      )));
      const pendingAfterReplacement = delayedResolvers.length;
      const detachedAfterReplacement = !detachedStickyCell.isConnected;
      const publicNodeSnapshot = (node: HTMLElement) => {
        const rect = node.getBoundingClientRect();
        return {
          connected: node.isConnected,
          className: node.className,
          style: node.getAttribute('style') ?? '',
          html: node.outerHTML,
          rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
        };
      };
      const detachedBeforeLateResolution = publicNodeSnapshot(detachedStickyCell);
      transactions.push(await settle(() => {
        delayedImageReady = true;
        for (const resolve of delayedResolvers.splice(0)) resolve(resolvedImage);
      }, () => Boolean(
        document.querySelector('.meo-md-html-table-sticky-header .meo-md-image-img')
      )));
      const detachedAfterLateResolution = publicNodeSnapshot(detachedStickyCell);
      const detachedCloneBehavior = {
        detachedAfterReplacement,
        detachedBeforeLateResolution,
        detachedAfterLateResolution,
        controls: detachedStickyCell.querySelectorAll('.meo-md-image-controls button').length,
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
      const disposedBeforeLateEvents = detached.map(publicNodeSnapshot);
      transactions.push(await settle(() => {
        disposeImageReady = true;
        for (const resolve of disposeResolvers.splice(0)) resolve(resolvedImage);
        oldScroller.dispatchEvent(new Event('scroll')); outer.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('resize'));
      }, () => true, true));
      const disposedAfterLateEvents = detached.map(publicNodeSnapshot);
      return { transactions, initialHidden, appeared, controls, outerAligned, domContract,
        hiddenAtTail, tailState, equalExternalCount, changedExternal, sourceCount, liveCount, previewVisible,
        pendingBeforeReplacement, pendingAfterReplacement, delayedImageContract, detachedCloneBehavior,
        afterDispose: state().count, disposedBeforeLateEvents, disposedAfterLateEvents };
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
    assert.equal(result.detachedCloneBehavior.detachedAfterReplacement, true);
    assert.deepEqual(
      result.detachedCloneBehavior.detachedAfterLateResolution,
      result.detachedCloneBehavior.detachedBeforeLateResolution
    );
    assert.deepEqual([
      result.detachedCloneBehavior.controls,
      result.detachedCloneBehavior.openPosted,
      result.detachedCloneBehavior.fullscreenOpened
    ], [0, false, false]);
    assert.equal(result.afterDispose, 0);
    assert.deepEqual(result.disposedAfterLateEvents, result.disposedBeforeLateEvents);
  } finally {
    await browser.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

await main();
console.log('table sticky header production Chromium contract passed');
