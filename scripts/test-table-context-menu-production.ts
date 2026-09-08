import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-context-menu-'));

async function waitForFrames(page: import('puppeteer-core').Page, count = 6): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function main(): Promise<void> {
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
    await page.setViewport({ width: 900, height: 620, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><style>
      :root {
        --vscode-editor-font-family: monospace;
        --vscode-editor-font-size: 14px;
        --vscode-editor-line-height: 20px;
        --vscode-editor-background: #22272e;
        --vscode-editor-foreground: #d7dde5;
        --vscode-sideBar-background: #22272e;
        --vscode-descriptionForeground: #8c98a5;
        --vscode-panel-border: #444c56;
        --vscode-toolbar-hoverBackground: #323942;
        --vscode-editor-selectionBackground: #264f78;
        --meo-color-base01: #d7dde5;
        --meo-color-base02: #8c98a5;
        --meo-color-base03: #444c56;
      }
      body { margin: 0; background: #20252b; }
      #app { width: 780px; height: 580px; }
      #app .cm-editor { height: 100%; }
    </style><main id="app"></main>`);
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const result = await page.evaluate(async () => {
      const app = document.getElementById('app')!;
      app.classList.add('editor-host');
      const editor = (window as any).TableStabilityHarness.createEditor({
        parent: app,
        text: [
          ...Array.from({ length: 12 }, (_, index) => `intro ${index + 1}`),
          '',
          '| A | B | C |',
          '| --- | --- | --- |',
          ...Array.from({ length: 18 }, (_, index) => `| row ${index + 1} | two | three |`),
          '',
          ...Array.from({ length: 24 }, (_, index) => `trailing ${index + 1}`)
        ].join('\n'),
        initialMode: 'live',
        onApplyChanges() {}
      });
      const frames = async (count = 1) => {
        for (let index = 0; index < count; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };
      const waitUntil = async (predicate: () => boolean, label: string) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (predicate()) return;
          await new Promise((resolve) => window.setTimeout(resolve, 20));
        }
        throw new Error(`Timed out waiting for ${label}`);
      };
      const pointer = (button: HTMLButtonElement) => button.dispatchEvent(new PointerEvent('pointerdown', {
        button: 0,
        bubbles: true,
        cancelable: true
      }));

      await waitUntil(() => Boolean(document.querySelector('.meo-md-html-table-shell tbody textarea')), 'table mount');
      await frames(8);
      const firstInput = document.querySelector<HTMLTextAreaElement>('.meo-md-html-table-shell tbody textarea')!;
      firstInput.focus();
      await frames(2);
      const shell = firstInput.closest<HTMLElement>('.meo-md-html-table-shell')!;
      const trigger = shell.querySelector<HTMLButtonElement>('.meo-md-html-table-context-trigger')!;
      const table = shell.querySelector<HTMLTableElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')!;
      const wrap = shell.querySelector<HTMLElement>('.meo-md-html-table-wrap')!;
      const initialWidths = Array.from(table.tHead!.rows[0].cells, (cell) => cell.getBoundingClientRect().width);
      const shellHeightBefore = shell.getBoundingClientRect().height;
      pointer(trigger);
      await frames(2);
      const menu = shell.querySelector<HTMLElement>('.meo-md-html-table-context-menu')!;
      const triggerRect = trigger.getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      const wrapRect = wrap.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const triggerVisible = getComputedStyle(trigger).visibility;
      const triggerInsideViewport = triggerRect.left >= -0.5 && triggerRect.right <= window.innerWidth + 0.5;
      const triggerOutsideTable = triggerRect.right <= wrapRect.left + 0.5;
      const tableUsesNormalContentLeft = Math.abs(wrapRect.left - shellRect.left) < 0.5;
      const menuInsideViewport = menuRect.left >= -0.5 && menuRect.right <= window.innerWidth + 0.5;
      const floating = getComputedStyle(menu).position;
      const menuStyle = getComputedStyle(menu);
      const triggerBackground = getComputedStyle(trigger).backgroundColor;
      const shellZIndex = Number(getComputedStyle(shell).zIndex);
      const gutterZIndex = Number(getComputedStyle(document.querySelector('.cm-gutters')!).zIndex);
      const shellHeightStable = Math.abs(shell.getBoundingClientRect().height - shellHeightBefore) < 0.5;
      const rootActionLabels = Array.from(
        menu.querySelectorAll('[data-context-panel="root"] .meo-md-html-table-context-btn-label'),
        (label) => label.textContent
      );

      pointer(menu.querySelector<HTMLButtonElement>('[data-context-panel-target="insert"]')!);
      await frames(1);
      const insertActionLabels = Array.from(
        menu.querySelectorAll('[data-context-panel="insert"] .meo-md-html-table-context-btn-label'),
        (label) => label.textContent
      );
      pointer(menu.querySelector<HTMLButtonElement>('button[title="Insert row below"]')!);
      await waitUntil(() => (
        document.querySelectorAll('.meo-md-html-table-shell tbody tr').length === 19
        && Boolean(document.querySelector('.meo-md-html-table-shell.is-context-menu-open .meo-md-html-table-context-menu:not([hidden])'))
      ), 'first persistent row insertion');
      const firstRestoredMenu = document.querySelector<HTMLElement>(
        '.meo-md-html-table-shell.is-context-menu-open .meo-md-html-table-context-menu:not([hidden])'
      )!;
      pointer(firstRestoredMenu.querySelector<HTMLButtonElement>('button[title="Insert row below"]')!);
      await waitUntil(() => (
        document.querySelectorAll('.meo-md-html-table-shell tbody tr').length === 20
        && Boolean(document.querySelector('.meo-md-html-table-shell.is-context-menu-open .meo-md-html-table-context-menu:not([hidden])'))
      ), 'second persistent row insertion');
      const rowCountAfterRepeatedInsert = document.querySelectorAll('.meo-md-html-table-shell tbody tr').length;
      const menuOpenAfterRepeatedInsert = Boolean(document.querySelector(
        '.meo-md-html-table-shell.is-context-menu-open .meo-md-html-table-context-menu:not([hidden])'
      ));
      await frames(12);

      const openPanel = (panel: 'insert' | 'move' | 'align' | 'delete') => {
        const currentMenu = document.querySelector<HTMLElement>('.meo-md-html-table-context-menu:not([hidden])')!;
        if (currentMenu.dataset.activePanel !== 'root') {
          pointer(currentMenu.querySelector<HTMLButtonElement>('.meo-md-html-table-context-back')!);
        }
        pointer(currentMenu.querySelector<HTMLButtonElement>(`[data-context-panel-target="${panel}"]`)!);
        return currentMenu;
      };
      const commandVisualDeltas: Record<string, number> = {};
      const commandVisualSamples: Record<string, number[]> = {};
      const runStableCommand = async (panel: 'insert' | 'move' | 'align' | 'delete', title: string) => {
        const currentMenu = openPanel(panel);
        const button = currentMenu.querySelector<HTMLButtonElement>(`button[title="${title}"]`)!;
        if (button.disabled) throw new Error(`${title} is unexpectedly disabled`);
        const textBefore = editor.getText();
        const visualAnchorBefore = document.querySelector<HTMLElement>('.meo-md-html-table-shell')!.getBoundingClientRect().top;
        pointer(button);
        await waitUntil(() => (
          editor.getText() !== textBefore
          && document.querySelector<HTMLElement>('.meo-md-html-table-context-menu:not([hidden])')?.dataset.activePanel === panel
        ), `${title} command`);
        const visualSamples: number[] = [];
        for (let index = 0; index < 24; index += 1) {
          await frames(1);
          visualSamples.push(document.querySelector<HTMLElement>('.meo-md-html-table-shell')!.getBoundingClientRect().top);
        }
        commandVisualDeltas[title] = Math.max(
          ...visualSamples.map((value) => Math.abs(value - visualAnchorBefore))
        );
        commandVisualSamples[title] = visualSamples.map((value) => value - visualAnchorBefore);
      };

      editor.view.scrollDOM.dispatchEvent(new WheelEvent('wheel', { deltaY: 500, bubbles: true }));
      editor.view.scrollDOM.scrollTop = 500;
      await frames(4);
      const scrollerRect = editor.view.scrollDOM.getBoundingClientRect();
      const moveInput = Array.from(document.querySelectorAll<HTMLTextAreaElement>(
        'textarea[data-table-col="0"]'
      )).find((input) => {
        const rect = input.getBoundingClientRect();
        return Number(input.dataset.tableRow) > 2 && input.value.startsWith('row ')
          && rect.top >= scrollerRect.top + 40 && rect.bottom <= scrollerRect.bottom - 40;
      })!;
      if (!moveInput) throw new Error('No visible content row found for command stability checks');
      moveInput.focus({ preventScroll: true });
      await frames(4);
      const focusedShell = moveInput.closest<HTMLElement>('.meo-md-html-table-shell')!;
      const focusedMenu = focusedShell.querySelector<HTMLElement>('.meo-md-html-table-context-menu')!;
      if (focusedMenu.hidden) {
        pointer(focusedShell.querySelector<HTMLButtonElement>('.meo-md-html-table-context-trigger')!);
      }
      await runStableCommand('move', 'Move row up');
      await runStableCommand('move', 'Move row down');
      await runStableCommand('insert', 'Insert row above');
      await runStableCommand('insert', 'Insert row below');
      await runStableCommand('delete', 'Delete row');

      const currentScrollerRect = editor.view.scrollDOM.getBoundingClientRect();
      const columnInput = Array.from(document.querySelectorAll<HTMLTextAreaElement>(
        'textarea[data-table-col="1"]'
      )).find((input) => {
        const rect = input.getBoundingClientRect();
        return rect.top >= currentScrollerRect.top + 40 && rect.bottom <= currentScrollerRect.bottom - 40;
      })!;
      if (!columnInput) throw new Error('No visible column target found for command stability checks');
      columnInput.focus({ preventScroll: true });
      await frames(2);
      await runStableCommand('insert', 'Insert column left');
      await runStableCommand('move', 'Move column left');
      await runStableCommand('move', 'Move column right');
      await runStableCommand('insert', 'Insert column right');
      await runStableCommand('align', 'Align selected column center');
      await runStableCommand('align', 'Align selected column right');
      await runStableCommand('align', 'Align selected column left');
      await runStableCommand('delete', 'Delete column');
      const activePanelAfterCommands = document.querySelector<HTMLElement>(
        '.meo-md-html-table-context-menu:not([hidden])'
      )?.dataset.activePanel;

      app.style.height = '260px';
      editor.view.scrollDOM.scrollTop = 0;
      await frames(8);
      const topRowInput = document.querySelector<HTMLTextAreaElement>('textarea[data-table-row="1"][data-table-col="0"]')!;
      topRowInput.focus({ preventScroll: true });
      await frames(2);
      const topRowShell = topRowInput.closest<HTMLElement>('.meo-md-html-table-shell')!;
      const topRowMenu = topRowShell.querySelector<HTMLElement>('.meo-md-html-table-context-menu')!;
      if (topRowMenu.hidden) {
        pointer(topRowShell.querySelector<HTMLButtonElement>('.meo-md-html-table-context-trigger')!);
      }
      editor.view.scrollDOM.dispatchEvent(new WheelEvent('wheel', { deltaY: 200, bubbles: true }));
      editor.view.scrollDOM.scrollTop = editor.view.scrollDOM.scrollHeight;
      await waitUntil(() => topRowMenu.hidden, 'context menu to close after its target row leaves the viewport');
      const menuClosedAfterTargetScroll = topRowMenu.hidden;
      app.style.height = '580px';

      app.style.width = '440px';
      await frames(12);
      const constrainedShell = document.querySelector<HTMLElement>('.meo-md-html-table-shell')!;
      const constrainedTable = constrainedShell.querySelector<HTMLTableElement>(
        '.meo-md-html-table:not(.meo-md-html-table-sticky-table)'
      )!;
      const constrainedWrap = constrainedShell.querySelector<HTMLElement>('.meo-md-html-table-wrap')!;
      const constrainedWidths = Array.from(
        constrainedTable.tHead!.rows[0].cells,
        (cell) => cell.getBoundingClientRect().width
      );
      const output = {
        triggerVisible,
        triggerInsideViewport,
        triggerOutsideTable,
        tableUsesNormalContentLeft,
        menuInsideViewport,
        floating,
        triggerBackground,
        shellZIndex,
        gutterZIndex,
        menuBackground: menuStyle.backgroundColor,
        menuBackdropFilter: menuStyle.backdropFilter,
        shellHeightStable,
        rootActionLabels,
        insertActionLabels,
        initialWidths,
        preferredColumnWidth: table.dataset.tablePreferredColumnWidth,
        rowCountAfterRepeatedInsert,
        menuOpenAfterRepeatedInsert,
        activePanelAfterCommands,
        commandVisualDeltas,
        commandVisualSamples,
        menuClosedAfterTargetScroll,
        constrainedWidths,
        constrainedFits: constrainedTable.getBoundingClientRect().width <= constrainedWrap.clientWidth + 1,
        constrainedOverflow: constrainedWrap.classList.contains('is-table-overflowing')
      };
      app.style.width = '780px';
      editor.view.scrollDOM.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
      editor.view.scrollDOM.scrollTop = 0;
      await frames(8);
      const previewInput = document.querySelector<HTMLTextAreaElement>('.meo-md-html-table-shell tbody textarea')!;
      previewInput.focus({ preventScroll: true });
      const previewShell = previewInput.closest<HTMLElement>('.meo-md-html-table-shell')!;
      const previewMenu = previewShell.querySelector<HTMLElement>('.meo-md-html-table-context-menu')!;
      if (previewMenu.hidden) {
        pointer(previewShell.querySelector<HTMLButtonElement>('.meo-md-html-table-context-trigger')!);
      }
      await frames(4);
      (window as any).__tableContextMenuEditor = editor;
      return output;
    });

    const resetTrustedClickScenario = async () => {
      await page.evaluate(async () => {
        const editor = (window as any).__tableContextMenuEditor;
        const openMenu = document.querySelector<HTMLElement>('.meo-md-html-table-context-menu:not([hidden])');
        if (openMenu) {
          openMenu.hidden = true;
          openMenu.closest('.meo-md-html-table-shell')?.classList.remove('is-context-menu-open');
        }
        editor.view.scrollDOM.scrollTop = 500;
        for (let index = 0; index < 4; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        const viewport = editor.view.scrollDOM.getBoundingClientRect();
        const input = Array.from(document.querySelectorAll<HTMLTextAreaElement>('.meo-md-html-table-shell textarea'))
          .find((candidate) => {
            const rect = candidate.getBoundingClientRect();
            return rect.top >= viewport.top + 60 && rect.bottom <= viewport.bottom - 60;
          });
        if (!input) throw new Error('No visible table cell for trusted-click scenario');
        input.focus({ preventScroll: true });
      });
      await waitForFrames(page, 4);
      const triggerState = await page.$eval('.meo-md-html-table-context-trigger', (trigger) => {
        const rect = trigger.getBoundingClientRect();
        const style = getComputedStyle(trigger);
        return {
          rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
          visibility: style.visibility,
          opacity: style.opacity,
          display: style.display,
          pointerEvents: style.pointerEvents,
          activeTag: document.activeElement?.tagName ?? null,
          shellFocusWithin: Boolean(trigger.closest('.meo-md-html-table-shell')?.matches(':focus-within'))
        };
      });
      if (
        triggerState.visibility !== 'visible' || triggerState.opacity === '0' ||
        triggerState.rect.width === 0 || triggerState.rect.height === 0
      ) {
        throw new Error(`Table trigger has no visible trusted-click target: ${JSON.stringify(triggerState)}`);
      }
      await trustedMouseClick('.meo-md-html-table-context-trigger');
      await page.waitForSelector('.meo-md-html-table-context-menu:not([hidden])');
      if (process.env.MEO_CAPTURE_TABLE_CONTEXT_MENU) {
        await page.screenshot({ path: process.env.MEO_CAPTURE_TABLE_CONTEXT_MENU });
      }
    };
    const trustedMouseClick = async (selector: string) => {
      const point = await page.$eval(selector, (element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      await page.mouse.click(point.x, point.y);
    };
    const trustedClickDeltas: Record<string, number> = {};
    const trustedClick = async (label: string, selector: string) => {
      const before = await page.evaluate(() => {
        const shell = document.querySelector<HTMLElement>('.meo-md-html-table-shell')!;
        return { shellTop: shell.getBoundingClientRect().top };
      });
      await trustedMouseClick(selector);
      await waitForFrames(page, 8);
      const after = await page.evaluate(() => {
        const shell = document.querySelector<HTMLElement>('.meo-md-html-table-shell')!;
        return { shellTop: shell.getBoundingClientRect().top };
      });
      trustedClickDeltas[label] = Math.max(
        Math.abs(after.shellTop - before.shellTop)
      );
    };
    await resetTrustedClickScenario();
    await trustedClick('Open insert panel', '[data-context-panel-target="insert"]');
    await trustedClick('Back to root panel', '.meo-md-html-table-context-back');
    await trustedClick('Open move panel', '[data-context-panel-target="move"]');
    await trustedClick('Move column right', 'button[title="Move column right"]');
    await trustedClick('Back after move', '.meo-md-html-table-context-back');
    await trustedClick('Reopen insert panel', '[data-context-panel-target="insert"]');
    await trustedClick('Insert row below', 'button[title="Insert row below"]');
    await trustedClick('Insert column right', 'button[title="Insert column right"]');
    await trustedClick('Back after insert', '.meo-md-html-table-context-back');
    await trustedClick('Open align panel', '[data-context-panel-target="align"]');
    await trustedClick('Align column center', 'button[title="Align selected column center"]');
    await trustedClick('Back after align', '.meo-md-html-table-context-back');
    await trustedClick('Open delete panel', '[data-context-panel-target="delete"]');
    await trustedClick('Delete row', 'button[title="Delete row"]');
    await trustedClick('Delete column', 'button[title="Delete column"]');

    assert.equal(result.triggerVisible, 'visible');
    assert.equal(result.triggerInsideViewport, true, 'the row action trigger must remain visible in the viewport');
    assert.equal(result.triggerOutsideTable, true, 'the row action trigger must float over the gutter to the left of the table');
    assert.equal(result.tableUsesNormalContentLeft, true, 'the table must not move right to reserve trigger space');
    assert.equal(result.menuInsideViewport, true, 'the menu must remain inside the viewport');
    assert.equal(result.floating, 'absolute');
    assert.ok(
      result.shellZIndex > result.gutterZIndex,
      `the active table controls must paint above the line-number/change-marker gutter: ${JSON.stringify({
        shell: result.shellZIndex,
        gutter: result.gutterZIndex
      })}`
    );
    assert.doesNotMatch(result.triggerBackground, /rgba\([^)]*,\s*(?:0(?:\.\d+)?|0?\.\d+)\s*\)/, 'the trigger must use an opaque surface');
    assert.doesNotMatch(result.menuBackground, /rgba\([^)]*,\s*0(?:\.0+)?\)/, 'the menu surface must be opaque');
    assert.ok(result.menuBackdropFilter === 'none' || result.menuBackdropFilter === '');
    assert.equal(result.shellHeightStable, true, 'the floating menu must not reserve document height');
    assert.deepEqual(result.rootActionLabels, ['Insert', 'Move', 'Align', 'Delete']);
    assert.deepEqual(result.insertActionLabels, ['Row above', 'Row below', 'Column left', 'Column right']);
    assert.equal(result.preferredColumnWidth, '90');
    assert.ok(result.initialWidths.every((width) => width >= 89.5), JSON.stringify(result.initialWidths));
    assert.equal(result.rowCountAfterRepeatedInsert, 20);
    assert.equal(result.menuOpenAfterRepeatedInsert, true);
    assert.equal(result.activePanelAfterCommands, 'delete', 'repeated commands must stay in the current submenu');
    assert.ok(
      Math.max(...Object.values(result.commandVisualDeltas)) <= 0.5,
      `table command shifted visible content: ${JSON.stringify({
        deltas: result.commandVisualDeltas,
        samples: result.commandVisualSamples
      })}`
    );
    assert.equal(result.menuClosedAfterTargetScroll, true, 'the menu must close when its target row leaves the viewport');
    assert.ok(
      Math.max(...Object.values(trustedClickDeltas)) <= 0.5,
      `trusted table-menu clicks shifted the viewport: ${JSON.stringify(trustedClickDeltas)}`
    );
    assert.equal(result.constrainedFits, true, 'preferred cell width must yield when the table reaches its available width');
    assert.equal(result.constrainedOverflow, false, 'a feasible constrained table must not gain horizontal overflow');
    console.log('table context menu production checks passed');
  } finally {
    await browser.close();
  }
}

main()
  .finally(() => fs.rmSync(tempDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
