import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-colors-'));

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-table-stability-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) {
    throw new Error(build.logs.map(String).join('\n'));
  }

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><button id="outside">outside</button><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const result = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      const editor = harness.createEditor({
        parent: app,
        initialMode: 'live',
        text: [
          '| Colors | Tag | Protected |',
          '| --- | --- | --- |',
          `| #f00 #0f08 #336699 #33669988 rgba(51, 153, 255, 0.55) hsl(210 100% 60%) red linear-gradient(#ffffff, #000000) | #todo #abc/tag | \`#00ff00\` HTTPS://example.com/?color=#aabbcc //example.com/?color=#aabbcc [section]( #aabbcc) ${String.fromCharCode(92)}${String.fromCharCode(96).repeat(2)}#00aa00${String.fromCharCode(96)} #00bb00 |`
        ].join('\n'),
        onApplyChanges() {}
      });
      for (let index = 0; index < 3; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }

      const previews = document.querySelectorAll<HTMLElement>('tbody .meo-md-html-table-cell-preview');
      const swatchTitles = (root: ParentNode) => Array.from(
        root.querySelectorAll<HTMLElement>('.meo-md-color-swatch'),
        (swatch) => swatch.title
      );
      const tagTexts = (root: ParentNode) => Array.from(
        root.querySelectorAll<HTMLElement>('.meo-md-tag'),
        (tag) => tag.textContent
      );
      const initial = {
        colors: swatchTitles(previews[0]),
        colorTags: tagTexts(previews[0]),
        tags: tagTexts(previews[1]),
        protectedColors: previews[2].querySelectorAll('.meo-md-color-swatch').length,
        protectedColorTitles: swatchTitles(previews[2])
      };

      const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      input.focus();
      input.value = '#00ff00 #todo';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('outside')!.focus();
      for (let index = 0; index < 3; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const preview = document.querySelector<HTMLElement>('tbody .meo-md-html-table-cell-preview')!;
      const updated = {
        colors: swatchTitles(preview),
        tags: tagTexts(preview)
      };
      editor.destroy();
      return { initial, updated };
    });

    const expectedInitial = {
      colors: ['#336699', '#33669988'],
      colorTags: [],
      tags: ['#todo', '#abc/tag'],
      protectedColors: 1,
      protectedColorTitles: ['#00bb00']
    };
    if (JSON.stringify(result.initial) !== JSON.stringify(expectedInitial)) {
      throw new Error(`Table colors were not rendered separately from tags: ${JSON.stringify(result.initial)}`);
    }
    if (JSON.stringify(result.updated) !== JSON.stringify({ colors: ['#00ff00'], tags: ['#todo'] })) {
      throw new Error(`Edited table colors were not refreshed: ${JSON.stringify(result.updated)}`);
    }

    const liveResult = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      app.replaceChildren();
      const text = [
        'Live swatches',
        'HEX #abc #abcd #aabbcc #aabbccdd',
        'Plain rgb(1 2 3) rgba(1 2 3 / 40%) hsl(120 50% 40%) hsla(120 50% 40% / .5) red linear-gradient(#fff, #000)',
        'Links https://example.com/#abc HTTPS://example.com/?color=#abc //example.com/?color=#abc [section](#abc) [spaced]( #abc) tag #abc/tag code `#fff`',
        '',
        'Unmatched ` inline marker',
        '',
        'After unmatched #010203',
        `${String.fromCharCode(92)}${String.fromCharCode(96).repeat(2)}#00aa00${String.fromCharCode(96)} #00bb00`
      ].join('\n');
      let applyCount = 0;
      const editor = harness.createEditor({
        parent: app,
        initialMode: 'live',
        text,
        onApplyChanges() { applyCount += 1; }
      });
      for (let index = 0; index < 3; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const swatches = Array.from(app.querySelectorAll<HTMLElement>('.meo-md-color-swatch'));
      const before = editor.getText();
      swatches[0]?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const textUnchangedAfterOpen = editor.getText() === before;
      const firstDialog = app.querySelector<HTMLElement>('.meo-hex-color-adjustment');
      const firstValueInput = firstDialog?.querySelector<HTMLInputElement>('.meo-hex-color-adjustment-value');
      const sixDigitOpacity = firstDialog?.querySelector<HTMLInputElement>('input[aria-label="Opacity"]')?.closest<HTMLElement>('label');
      const sixDigitOpacityVisible = Boolean(sixDigitOpacity && getComputedStyle(sixDigitOpacity).display !== 'none');
      if (firstValueInput) {
        firstValueInput.value = '#11223344';
        firstValueInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const invalidLengthRejected = firstValueInput?.getAttribute('aria-invalid') === 'true' &&
        firstDialog?.querySelector<HTMLButtonElement>('.meo-hex-color-adjustment-apply')?.disabled === true;
      if (firstValueInput) {
        firstValueInput.value = '#112233';
        firstValueInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const draftDoesNotWrite = editor.getText() === before;
      const draftFocusRetained = document.activeElement === firstValueInput;
      firstDialog?.querySelector<HTMLButtonElement>('.meo-hex-color-adjustment-apply')?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const alphaSwatch = app.querySelector<HTMLButtonElement>('[data-color-value="#aabbccdd"]');
      alphaSwatch?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const secondDialog = app.querySelector<HTMLElement>('.meo-hex-color-adjustment');
      const alphaInput = secondDialog?.querySelector<HTMLInputElement>('input[aria-label="Opacity"]');
      if (alphaInput) {
        alphaInput.value = '128';
        alphaInput.dispatchEvent(new Event('input', { bubbles: true }));
        alphaInput.value = '64';
        alphaInput.dispatchEvent(new Event('input', { bubbles: true }));
        alphaInput.value = '128';
        alphaInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const alphaDraftDoesNotWrite = editor.getText().includes('#aabbccdd');
      secondDialog?.querySelector<HTMLButtonElement>('.meo-hex-color-adjustment-apply')?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const adjustedText = editor.getText();
      app.querySelector<HTMLButtonElement>('[data-color-value="#010203"]')?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const thirdValueInput = app.querySelector<HTMLInputElement>('.meo-hex-color-adjustment-value');
      if (thirdValueInput) {
        thirdValueInput.value = '#445566';
        thirdValueInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const canceledSwatch = app.querySelector<HTMLButtonElement>('[data-color-value="#010203"]');
      const cancelRestoredPreview = canceledSwatch?.style.backgroundColor === 'rgb(1, 2, 3)';
      const escapeCanceledDraft = editor.getText() === adjustedText;
      const dialogClosed = !app.querySelector('.meo-hex-color-adjustment');
      const undoAlpha = await editor.undo();
      const textAfterFirstUndo = editor.getText();
      const undoSixDigit = await editor.undo();
      const textAfterSecondUndo = editor.getText();
      const redoSixDigit = await editor.redo();
      const redoAlpha = await editor.redo();
      const result = {
        colors: swatches.map((swatch) => swatch.dataset.colorValue),
        tags: swatches.map((swatch) => swatch.tagName),
        popupKinds: swatches.map((swatch) => swatch.getAttribute('aria-haspopup')),
        interactiveDescendants: swatches.reduce(
          (count, swatch) => count + swatch.querySelectorAll('input, button, select, textarea').length,
          0
        ),
        textUnchangedAfterOpen,
        draftDoesNotWrite,
        draftFocusRetained,
        alphaDraftDoesNotWrite,
        firstDialogVisible: Boolean(firstDialog),
        sixDigitOpacityVisible,
        invalidLengthRejected,
        opacityVisible: Boolean(alphaInput && getComputedStyle(alphaInput.closest<HTMLElement>('label')!).display !== 'none'),
        adjustedSixDigit: adjustedText.includes('#112233'),
        adjustedEightDigit: adjustedText.includes('#aabbcc80'),
        escapeCanceledDraft,
        dialogClosed,
        cancelRestoredPreview,
        undoAlpha: undoAlpha && textAfterFirstUndo.includes('#aabbccdd') && textAfterFirstUndo.includes('#112233'),
        undoSixDigit: undoSixDigit && textAfterSecondUndo === before,
        redoBoth: redoSixDigit && redoAlpha && editor.getText() === adjustedText,
        applyCount
      };
      editor.destroy();
      return result;
    });
    if (JSON.stringify(liveResult.colors) !== JSON.stringify(['#aabbcc', '#aabbccdd', '#010203', '#00bb00'])
      || liveResult.tags.some((tag) => tag !== 'BUTTON')
      || liveResult.popupKinds.some((kind) => kind !== 'dialog')
      || liveResult.interactiveDescendants !== 0
      || !liveResult.textUnchangedAfterOpen
      || !liveResult.draftDoesNotWrite
      || !liveResult.draftFocusRetained
      || !liveResult.alphaDraftDoesNotWrite
      || !liveResult.firstDialogVisible
      || !liveResult.sixDigitOpacityVisible
      || !liveResult.invalidLengthRejected
      || !liveResult.opacityVisible
      || !liveResult.adjustedSixDigit
      || !liveResult.adjustedEightDigit
      || !liveResult.escapeCanceledDraft
      || !liveResult.dialogClosed
      || !liveResult.cancelRestoredPreview
      || !liveResult.undoAlpha
      || !liveResult.undoSixDigit
      || !liveResult.redoBoth
      || liveResult.applyCount < 2) {
      throw new Error(`Live HEX swatches must provide bounded color adjustment: ${JSON.stringify(liveResult)}`);
    }

    await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      app.replaceChildren();
      (window as any).colorShortcutEditor = harness.createEditor({
        parent: app,
        initialMode: 'live',
        text: 'Live swatches\nHEX #123456',
        onApplyChanges() {}
      });
      for (let index = 0; index < 3; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    await page.waitForSelector('.meo-md-color-swatch-interactive');
    await page.focus('.meo-md-color-swatch-interactive');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.meo-hex-color-adjustment');
    await page.keyboard.press('Escape');
    const keyboardResult = await page.evaluate(() => ({
      closed: !document.querySelector('.meo-hex-color-adjustment'),
      unchanged: (window as any).colorShortcutEditor.getText() === 'Live swatches\nHEX #123456'
    }));
    await page.click('.meo-md-color-swatch-interactive');
    await page.waitForSelector('.meo-hex-color-adjustment');
    await page.click('#outside');
    const outsideClosed = await page.evaluate(() => !document.querySelector('.meo-hex-color-adjustment'));
    await page.evaluate(() => (window as any).colorShortcutEditor.destroy());
    if (!keyboardResult.closed || !keyboardResult.unchanged || !outsideClosed) {
      throw new Error(`Swatch keyboard/outside dismissal failed: ${JSON.stringify({ keyboardResult, outsideClosed })}`);
    }

    const opacityResult = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      app.replaceChildren();
      const editor = harness.createEditor({
        parent: app,
        initialMode: 'live',
        text: 'Live swatches\nHEX #112233 and #aabbcc80',
        onApplyChanges() {}
      });
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      for (let index = 0; index < 3; index += 1) await frame();
      const open = (value: string) => app.querySelector<HTMLButtonElement>(`[data-color-value="${value}"]`)?.click();
      const setOpacity = (value: number) => {
        const slider = app.querySelector<HTMLInputElement>('input[aria-label="Opacity"]')!;
        slider.value = String(value);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const draft = () => app.querySelector<HTMLInputElement>('.meo-hex-color-adjustment-value')?.value;
      const apply = () => app.querySelector<HTMLButtonElement>('.meo-hex-color-adjustment-apply')?.click();
      open('#112233');
      await frame();
      setOpacity(128);
      const transparentDraft = draft() === '#11223380' && editor.getText().includes('#112233 and');
      const valueInput = app.querySelector<HTMLInputElement>('.meo-hex-color-adjustment-value')!;
      valueInput.value = '#112233ff';
      valueInput.dispatchEvent(new Event('input', { bubbles: true }));
      const typedFullAlphaNormalizes = draft() === '#112233';
      setOpacity(128);
      setOpacity(255);
      const restoredDraft = draft() === '#112233';
      apply();
      await frame();
      const opaqueRemainsSix = editor.getText().includes('#112233 and');
      open('#112233');
      await frame();
      setOpacity(128);
      apply();
      await frame();
      const convertedToEight = editor.getText().includes('#11223380 and');
      const undone = await editor.undo() && editor.getText().includes('#112233 and');
      const redone = await editor.redo() && editor.getText().includes('#11223380 and');
      open('#aabbcc80');
      await frame();
      setOpacity(255);
      apply();
      await frame();
      const existingEightStaysEight = editor.getText().includes('#aabbccff');
      editor.destroy();
      return { transparentDraft, typedFullAlphaNormalizes, restoredDraft, opaqueRemainsSix, convertedToEight, undone, redone, existingEightStaysEight };
    });
    if (Object.values(opacityResult).some((value) => !value)) {
      throw new Error(`Six/eight-digit opacity semantics failed: ${JSON.stringify(opacityResult)}`);
    }

    const blockBoundaryResult = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      const backtick = String.fromCharCode(96);
      const cases = [
        `# Heading ${backtick}\nParagraph #aabbcc ${backtick}`,
        `open ${backtick}\n# Heading #aabbcc\nclose ${backtick}`
      ];
      const results: string[][] = [];
      for (const text of cases) {
        app.replaceChildren();
        const editor = harness.createEditor({ parent: app, initialMode: 'live', text, onApplyChanges() {} });
        for (let index = 0; index < 3; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        results.push(Array.from(
          app.querySelectorAll<HTMLElement>('.meo-md-color-swatch'),
          (swatch) => swatch.dataset.colorValue ?? swatch.title
        ));
        editor.destroy();
      }
      return results;
    });
    if (JSON.stringify(blockBoundaryResult) !== JSON.stringify([['#aabbcc'], ['#aabbcc']])) {
      throw new Error(`Live Markdown block boundaries diverged from Preview: ${JSON.stringify(blockBoundaryResult)}`);
    }

    const adversarialExclusionResult = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      const count = 2_500;
      const text = Array.from({ length: count }, (_, index) => `[label #aabbcc](target-${index}) #ddeeff`).join('\n\n');
      app.replaceChildren();
      const editor = harness.createEditor({ parent: app, initialMode: 'live', text, onApplyChanges() {} });
      for (let index = 0; index < 3; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const swatches = Array.from(
        app.querySelectorAll<HTMLElement>('.meo-md-color-swatch'),
        (swatch) => swatch.dataset.colorValue ?? swatch.title
      );
      const result = {
        count: swatches.length,
        onlyExternalHex: swatches.every((value) => value === '#ddeeff')
      };
      editor.destroy();
      return result;
    });
    if (adversarialExclusionResult.count < 1 || !adversarialExclusionResult.onlyExternalHex) {
      throw new Error(`Live exclusion stress fixture must render only external HEX values in the virtualized viewport: ${JSON.stringify(adversarialExclusionResult)}`);
    }
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
console.log('table color swatch checks passed');
