import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-sticky-header-production-'));

async function waitFrames(page: any, count = 8): Promise<void> {
  await page.evaluate(async (frameCount: number) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function ownerState(page: any): Promise<{
  shells: number;
  owners: number;
  toolbars: number;
  stickyInteractive: number;
}> {
  return page.evaluate(() => ({
    shells: document.querySelectorAll('.meo-md-html-table-shell').length,
    owners: document.querySelectorAll('[data-table-sticky-header-owner="adapter"]').length,
    toolbars: document.querySelectorAll('.meo-md-html-table-toolbar').length,
    stickyInteractive: document.querySelectorAll(
      '.meo-md-html-table-sticky-header button, .meo-md-html-table-sticky-header textarea, ' +
      '.meo-md-html-table-sticky-header input, .meo-md-html-table-sticky-header a[href]'
    ).length
  }));
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-table-stability-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'production.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 940, height: 420 });
    await page.setContent('<!doctype html><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'production.js') });

    const rows = Array.from({ length: 16 }, (_, index) => `| ${index + 1} | row ${index + 1} |`);
    const markdown = [
      '| First A | First B |',
      '| --- | --- |',
      ...rows,
      '',
      ...Array.from({ length: 10 }, (_, index) => `between ${index + 1}`),
      '',
      '| Second A | Second B |',
      '| --- | --- |',
      ...rows,
      '',
      ...Array.from({ length: 20 }, (_, index) => `tail ${index + 1}`)
    ].join('\n');

    await page.evaluate((text) => {
      (window as any).__stickyProduction = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, markdown);
    await waitFrames(page);

    assert.deepEqual(await ownerState(page), {
      shells: 2,
      owners: 2,
      toolbars: 2,
      stickyInteractive: 0
    });

    const projectionState = await page.evaluate(async () => {
      const editor = (window as any).__stickyProduction;
      const shells = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-table-shell'));
      const secondHeader = shells[1].querySelector<HTMLElement>('thead')!;
      const scroller = editor.view.scrollDOM as HTMLElement;
      const beforeText = editor.getText();
      const beforeScrollLeft = scroller.scrollLeft;
      scroller.scrollTop += secondHeader.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + 8;
      scroller.scrollLeft = 35;
      const appliedScrollLeft = scroller.scrollLeft;
      scroller.dispatchEvent(new Event('scroll'));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const visible = shells.map((shell) => {
        const chrome = shell.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome')!;
        return getComputedStyle(chrome).display !== 'none';
      });
      const input = shells[1].querySelector<HTMLTextAreaElement>('thead textarea')!;
      input.focus({ preventScroll: true });
      input.setSelectionRange(2, 5);
      window.dispatchEvent(new Event('resize'));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return {
        visible,
        textUnchanged: editor.getText() === beforeText,
        focusPreserved: document.activeElement === input && input.selectionStart === 2 && input.selectionEnd === 5,
        horizontalScrollPreserved: scroller.scrollLeft === appliedScrollLeft && beforeScrollLeft === 0,
        toolbarButtonUsable: !shells[1].querySelector<HTMLButtonElement>('.meo-md-html-table-toolbar-btn')!.disabled
      };
    });
    assert.deepEqual(projectionState, {
      visible: [false, true],
      textUnchanged: true,
      focusPreserved: true,
      horizontalScrollPreserved: true,
      toolbarButtonUsable: true
    });

    await page.evaluate(() => (window as any).__stickyProduction.setMode('source'));
    await waitFrames(page);
    assert.deepEqual(await ownerState(page), { shells: 0, owners: 0, toolbars: 0, stickyInteractive: 0 });
    await page.evaluate(() => (window as any).__stickyProduction.setMode('live'));
    await waitFrames(page);
    assert.equal((await ownerState(page)).owners, 2);

    await page.evaluate(() => {
      const editor = (window as any).__stickyProduction;
      editor.setText(editor.getText());
      editor.setText(`prefix\n\n${editor.getText()}`);
    });
    await waitFrames(page);
    assert.equal((await ownerState(page)).owners, 2);

    await page.evaluate(() => {
      const input = document.querySelector<HTMLTextAreaElement>('.meo-md-html-table-shell tbody textarea')!;
      input.focus();
      input.value = `${input.value} changed`;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      (window as any).__stickyProduction.commitTransientEdits();
    });
    await waitFrames(page);
    await page.evaluate(async () => { await (window as any).__stickyProduction.undo(); });
    await waitFrames(page);
    assert.equal((await ownerState(page)).owners, 2);
    await page.evaluate(async () => { await (window as any).__stickyProduction.redo(); });
    await waitFrames(page);
    assert.equal((await ownerState(page)).owners, 2);

    await page.evaluate(() => {
      const editor = (window as any).__stickyProduction;
      const scroller = editor.view.scrollDOM as HTMLElement;
      editor.destroy();
      scroller.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('resize'));
    });
    await waitFrames(page, 3);
    assert.deepEqual(await ownerState(page), { shells: 0, owners: 0, toolbars: 0, stickyInteractive: 0 });
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
console.log('table sticky header production cutover Chromium trace passed');
