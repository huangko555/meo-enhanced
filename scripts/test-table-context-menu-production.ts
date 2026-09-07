import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-context-menu-'));

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
      const editor = (window as any).TableStabilityHarness.createEditor({
        parent: app,
        text: ['| A | B | C |', '| --- | --- | --- |', '| one | two | three |', '| four | five | six |'].join('\n'),
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
      const menuRect = menu.getBoundingClientRect();
      const triggerVisible = getComputedStyle(trigger).visibility;
      const triggerInsideShell = triggerRect.left >= shellRect.left - 0.5 && triggerRect.right <= shellRect.right + 0.5;
      const menuInsideViewport = menuRect.left >= -0.5 && menuRect.right <= window.innerWidth + 0.5;
      const floating = getComputedStyle(menu).position;
      const shellHeightStable = Math.abs(shell.getBoundingClientRect().height - shellHeightBefore) < 0.5;
      const groupLabels = Array.from(
        menu.querySelectorAll('.meo-md-html-table-context-group-label'),
        (label) => label.textContent
      );
      const visibleActionLabels = Array.from(
        menu.querySelectorAll('.meo-md-html-table-context-btn-label'),
        (label) => label.textContent
      );

      pointer(menu.querySelector<HTMLButtonElement>('button[title="Insert row below"]')!);
      await waitUntil(() => (
        document.querySelectorAll('.meo-md-html-table-shell tbody tr').length === 3
        && Boolean(document.querySelector('.meo-md-html-table-shell.is-context-menu-open .meo-md-html-table-context-menu:not([hidden])'))
      ), 'first persistent row insertion');
      const firstRestoredMenu = document.querySelector<HTMLElement>(
        '.meo-md-html-table-shell.is-context-menu-open .meo-md-html-table-context-menu:not([hidden])'
      )!;
      pointer(firstRestoredMenu.querySelector<HTMLButtonElement>('button[title="Insert row below"]')!);
      await waitUntil(() => (
        document.querySelectorAll('.meo-md-html-table-shell tbody tr').length === 4
        && Boolean(document.querySelector('.meo-md-html-table-shell.is-context-menu-open .meo-md-html-table-context-menu:not([hidden])'))
      ), 'second persistent row insertion');

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
        triggerInsideShell,
        menuInsideViewport,
        floating,
        shellHeightStable,
        groupLabels,
        visibleActionLabels,
        initialWidths,
        rowCountAfterRepeatedInsert: constrainedTable.tBodies[0].rows.length,
        menuOpenAfterRepeatedInsert: constrainedShell.classList.contains('is-context-menu-open'),
        constrainedWidths,
        constrainedFits: constrainedTable.getBoundingClientRect().width <= constrainedWrap.clientWidth + 1,
        constrainedOverflow: constrainedWrap.classList.contains('is-table-overflowing')
      };
      app.style.width = '780px';
      await frames(8);
      (window as any).__tableContextMenuEditor = editor;
      return output;
    });

    if (process.env.MEO_CAPTURE_TABLE_CONTEXT_MENU) {
      await page.screenshot({ path: process.env.MEO_CAPTURE_TABLE_CONTEXT_MENU });
    }

    assert.equal(result.triggerVisible, 'visible');
    assert.equal(result.triggerInsideShell, true, 'the row action trigger must remain inside the table shell');
    assert.equal(result.menuInsideViewport, true, 'the menu must remain inside the viewport');
    assert.equal(result.floating, 'absolute');
    assert.equal(result.shellHeightStable, true, 'the floating menu must not reserve document height');
    assert.deepEqual(result.groupLabels, ['Rows', 'Columns', 'Align']);
    assert.deepEqual(result.visibleActionLabels, [
      'Insert row above', 'Insert row below', 'Move row up', 'Move row down', 'Delete row',
      'Insert column left', 'Insert column right', 'Move column left', 'Move column right', 'Delete column'
    ]);
    assert.ok(result.initialWidths.every((width) => width >= 179.5), JSON.stringify(result.initialWidths));
    assert.equal(result.rowCountAfterRepeatedInsert, 4);
    assert.equal(result.menuOpenAfterRepeatedInsert, true);
    assert.ok(result.constrainedWidths.some((width) => width < 179.5), JSON.stringify(result.constrainedWidths));
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
