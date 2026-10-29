import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const build = await Bun.build({ entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'], target: 'browser', format: 'iife',
  plugins: [{ name: 'outline-transition-fixture', setup(builder) {
    builder.onLoad({ filter: /webview[\\/]src[\\/]index\.ts$/ }, async args => {
      const contents = await Bun.file(args.path).text();
      const entry = '  async applyEditorMode(mode, viewport) {';
      assert.ok(contents.includes(entry), 'fixture reaches the real mode application boundary');
      return { loader: 'ts', contents: contents.replace(entry, entry + '\n    const gate = (window as any).__outlineTransitionGate;\n    if (gate) await gate(mode);') };
    });
  } }]
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const bundle = await build.outputs[0]!.text();
const text = Array.from({ length: 35 }, (_, index) => `## Section ${index}\n\n${'Reading paragraph. '.repeat(20)}\n`).join('\n');
const browser = await launchTestBrowser();
const screenshots = process.env.MEO_TEST_SCREENSHOTS;
if (screenshots) mkdirSync(screenshots, { recursive: true });
const errors: string[] = [];
let cases = 0;
let transitions = 0;
try {
  for (const editorAppearance of ['dark', 'light'] as const) {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    await page.setViewport({ width: 1400, height: 760 });
    await page.setContent(`<!doctype html><style>html,body,#app{height:100%;margin:0}</style><body class="vscode-${editorAppearance}"><div id="app"></div></body>`);
    await page.addStyleTag({ path: 'webview/src/styles.css' });
    await page.addStyleTag({ content: `:root{--vscode-editor-background:${editorAppearance === 'dark' ? '#22272e' : '#ffffff'};--vscode-editor-foreground:${editorAppearance === 'dark' ? '#dddddd' : '#222222'};--vscode-editorWidget-background:${editorAppearance === 'dark' ? '#22272e' : '#ffffff'};--vscode-foreground:${editorAppearance === 'dark' ? '#e5e5e5' : '#222222'};--vscode-textLink-foreground:#2472c8;--vscode-button-background:#2472c8;--vscode-font-family:Arial;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px}` });
    await page.exposeFunction('__renderOutline', (message: any) => message.type === 'requestPreviewRender' ? {
      type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value: exportRuntime.renderPreviewDocument({
        markdownText: message.text, sourceDocumentPath: 'C:/tmp/outline-colors.md', uiLanguage: 'en',
        styleEnvironment: message.environment, preset: message.preset, contentWidth: message.contentWidth
      }) }
    } : null);
    await page.addScriptTag({ content: `window.__outlineMessages=[];window.acquireVsCodeApi=()=>({getState(){return {sourcePreviewScrollSyncEnabled:false}},setState(){},postMessage(message){window.__outlineMessages.push(message);window.__renderOutline(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
    await page.addScriptTag({ content: bundle });
    await page.evaluate(({ text, editorAppearance }) => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', documentId: 'file:///outline-colors.md', text, version: 1, savedRevision: { version: 1, text },
      diagnostics: [], mode: 'live', uiLanguage: editorAppearance === 'dark' ? 'zh-CN' : 'en', sourceLineNumbers: 'on',
      previewAppearance: editorAppearance === 'dark' ? 'light' : 'dark', previewFontFamily: '', previewSourceColoring: false,
      previewShowComments: false, editorAppearance, gitChangesGutter: false, gitDiffLineHighlights: false,
      gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit', fixedBaselinePinned: false,
      fixedBaselineActive: false, contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
      outlinePosition: 'right', outlineVisible: true, outlineWidth: 260,
      vscodeTheme: { name: 'fixture', type: editorAppearance, colors: {}, tokenColors: [] }
    } })), { text, editorAppearance });
    await page.waitForFunction(() => document.querySelectorAll('.outline-item').length === 35
      && !!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('.meo-export-doc'));
    const snapshot = () => page.evaluate(() => {
      const sidebar = document.querySelector<HTMLElement>('.outline-sidebar')!;
      const styles = getComputedStyle(sidebar);
      // Presets can return color(srgb ...) while derived roles use rgb(...).
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d')!;
      const normalize = (value: string) => {
        context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1);
        return `rgb(${Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).join(', ')})`;
      };
      const resolve = (role: string) => {
        const probe = document.createElement('span'); probe.style.color = `var(--meo-outline-${role})`;
        sidebar.append(probe); const result = getComputedStyle(probe).color; probe.remove(); return result;
      };
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      return {
        background: normalize(styles.backgroundColor),
        foreground: getComputedStyle(sidebar.querySelector('.outline-item:not(.is-visible-first)')!).color,
        header: getComputedStyle(sidebar.querySelector('.outline-header-label')!).color,
        muted: resolve('muted-foreground'), emphasis: resolve('emphasis'), hover: resolve('hover-background'),
        visible: resolve('visible-background'), border: resolve('border'), focus: resolve('focus'),
        scrollbar: resolve('scrollbar-thumb'), scheme: styles.colorScheme,
        editorBackground: normalize(getComputedStyle(document.querySelector('.editor-host')!).backgroundColor),
        editorForeground: normalize(getComputedStyle(document.querySelector('.cm-content')!).color),
        previewBackground: normalize(doc.defaultView!.getComputedStyle(doc.body).backgroundColor),
        previewForeground: normalize(doc.defaultView!.getComputedStyle(doc.querySelector('.meo-export-doc')!).color),
        uiSurface: getComputedStyle(document.documentElement).getPropertyValue('--meo-ui-surface')
      };
    });
    const luminance = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {
      const channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    const contrast = (ink: string, background: string) => (Math.max(luminance(ink), luminance(background)) + 0.05)
      / (Math.min(luminance(ink), luminance(background)) + 0.05);
    const check = async (usePreview: boolean, label: string) => {
      const colors = await snapshot();
      assert.equal(colors.background, usePreview ? colors.previewBackground : colors.editorBackground, label + ': adjacent background');
      assert.equal(colors.header, colors.foreground, label + ': header uses document ink');
      const expectedInk = usePreview ? colors.previewForeground : colors.editorForeground;
      if ([colors.background, colors.hover, colors.visible].every(background => contrast(expectedInk, background) >= 4.55)) {
        assert.equal(colors.foreground, expectedInk, label + ': readable adjacent foreground is preserved');
      }
      for (const ink of [colors.foreground, colors.muted, colors.emphasis]) {
        for (const background of [colors.background, colors.hover, colors.visible]) {
          assert.ok(contrast(ink, background) >= 4.5, `${label}: unreadable ${ink} on ${background}`);
        }
      }
      assert.ok(contrast(colors.focus, colors.background) >= 3, label + ': focus remains visible');
      assert.equal(colors.scheme, luminance(colors.background) < 0.18 ? 'dark' : 'light', label + ': actual color scheme');
      cases += 1;
      return colors;
    };
    const setOutline = async (position: 'left' | 'right', mode: 'fixed' | 'floating') => {
      await page.evaluate(position => {
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'outlinePositionChanged', position } }));
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'outlineVisibilityChanged', visible: true } }));
      }, position);
      const current = await page.$eval('.editor-wrapper', element => (element as HTMLElement).dataset.outlineMode);
      if (current !== mode) await page.click('.outline-header-button[data-action="toggle-mode"]');
    };
    const uiSurface = (await snapshot()).uiSurface;
    for (const view of ['live', 'source', 'source+preview', 'preview'] as const) {
      const mode = view === 'source+preview' ? 'source' : view;
      await page.click(`button[data-mode="${mode}"]`);
      await page.waitForFunction(mode => document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === mode, {}, mode);
      if (mode === 'source') {
        const split = await page.$eval('.source-preview-button', element => element.getAttribute('aria-pressed') === 'true');
        if (split !== (view === 'source+preview')) await page.click('.source-preview-button');
      }
      if (view === 'preview' || view === 'source+preview') {
        await page.waitForFunction(() => !document.querySelector<HTMLElement>('.preview-host')!.inert
          && getComputedStyle(document.querySelector('.preview-host')!).visibility !== 'hidden'
          && document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement.inert === false
          && !document.querySelector('.editor-surface')!.hasAttribute('data-source-preview-preparing')
          && (document.querySelector<HTMLElement>('.editor-root')!.dataset.mode !== 'preview'
            || document.querySelector<HTMLElement>('.editor-host')!.hidden
              && !document.querySelector('.editor-host')!.hasAttribute('data-preview-cover')));
      }
      for (const position of ['left', 'right'] as const) {
        for (const outlineMode of ['fixed', 'floating'] as const) {
          await setOutline(position, outlineMode);
          const colors = await check(view === 'preview' || (view === 'source+preview' && position === 'right'), `${editorAppearance}/${view}/${position}/${outlineMode}`);
          assert.equal(colors.uiSurface, uiSurface, 'outline palette stays local');
          if (screenshots && view === 'source+preview' && outlineMode === 'fixed') {
            await page.screenshot({ path: path.join(screenshots, `${editorAppearance}-split-${position}.png`) });
          }
        }
      }
    }

    type PaletteSample = { color: string; preparing: boolean; cover: boolean; splitCover: boolean; previewVisible: boolean; editorInert: boolean };
    // Observe intermediate states so an incorrect palette cannot hide behind a correct final frame.
    const beginTransition = () => page.evaluate(() => {
      const w = window as any;
      const samples: unknown[] = []; let previous = '';
      const capture = () => {
        const surface = document.querySelector('.editor-surface')!;
        const editor = document.querySelector<HTMLElement>('.editor-host')!;
        const preview = document.querySelector<HTMLElement>('.preview-host')!;
        const sample = { color: getComputedStyle(document.querySelector('.outline-sidebar')!).backgroundColor,
          preparing: surface.hasAttribute('data-source-preview-preparing'), cover: editor.hasAttribute('data-preview-cover'),
          splitCover: surface.hasAttribute('data-source-preview-exit-cover'),
          previewVisible: !preview.hidden && preview.style.visibility !== 'hidden', editorInert: editor.inert };
        const key = JSON.stringify(sample);
        if (key !== previous) { previous = key; samples.push(sample); }
      };
      const observer = new MutationObserver(capture);
      for (const selector of ['.editor-root', '.editor-surface', '.editor-host', '.preview-host', '.outline-sidebar']) {
        observer.observe(document.querySelector(selector)!, { attributes: true });
      }
      capture(); w.__outlinePaletteTrace = { observer, samples };
    });
    const endTransition = async (): Promise<PaletteSample[]> => {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      return page.evaluate(() => {
        const trace = (window as any).__outlinePaletteTrace; trace.observer.disconnect(); return trace.samples;
      });
    };
    const ready = (mode: 'source' | 'preview') => page.waitForFunction(mode => {
      const root = document.querySelector<HTMLElement>('.editor-root')!;
      const editor = document.querySelector<HTMLElement>('.editor-host')!;
      return root.dataset.mode === mode && (mode === 'preview'
        ? editor.hidden && !editor.hasAttribute('data-preview-cover')
          && document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement.inert === false
        : !editor.hidden && !editor.inert && !document.querySelector('.editor-surface')!.hasAttribute('data-source-preview-preparing'));
    }, {}, mode);
    const switchMode = async (mode: 'source' | 'preview') => {
      await beginTransition(); await page.click(`button[data-mode="${mode}"]`); await ready(mode);
      transitions += 1; return endTransition();
    };
    const expectPalette = (samples: PaletteSample[], expected: string[], position: 'left' | 'right', source: string, preview: string) => {
      const colors = samples.map(sample => sample.color).filter((color, index, all) => index === 0 || color !== all[index - 1]);
      assert.deepEqual(colors, expected, `${editorAppearance}/${position}: palette changes once with its visible viewport`);
      for (const sample of samples) {
        if (sample.preparing) assert.equal(sample.color, preview, 'full Preview remains the carrier while Source prepares');
        if (sample.cover && (!sample.splitCover || position === 'left')) {
          assert.equal(sample.color, source, 'visible editor cover keeps its palette until Preview is painted');
        }
      }
    };
    const palette = await snapshot();
    for (const split of [true, false]) {
      await page.click('button[data-mode="source"]'); await ready('source');
      if (await page.$eval('.source-preview-button', element => element.getAttribute('aria-pressed') === 'true') !== split) {
        await page.click('.source-preview-button');
      }
      for (const position of ['left', 'right'] as const) {
        await setOutline(position, 'fixed');
        const adjacent = split && position === 'right' ? palette.previewBackground : palette.editorBackground;
        const forward = await switchMode('preview');
        expectPalette(forward, adjacent === palette.previewBackground ? [adjacent] : [adjacent, palette.previewBackground], position, palette.editorBackground, palette.previewBackground);
        const backward = await switchMode('source');
        expectPalette(backward, adjacent === palette.previewBackground ? [adjacent] : [palette.previewBackground, adjacent], position, palette.editorBackground, palette.previewBackground);
      }
    }
    // Cancelled and failed preparations must keep the still-visible Preview and ignore stale completion.
    await page.click('.source-preview-button');
    await switchMode('preview');
    for (const position of ['left', 'right'] as const) {
      await setOutline(position, 'fixed');
      await page.evaluate(() => {
        const w = window as any;
        w.__outlineTransitionGate = (mode: string) => mode === 'source' ? new Promise(resolve => { w.__releaseOutlineSource = resolve; }) : undefined;
      });
      await beginTransition(); await page.click('button[data-mode="source"]');
      await page.waitForFunction(() => typeof (window as any).__releaseOutlineSource === 'function');
      assert.equal((await snapshot()).background, palette.previewBackground, 'waiting Source stays behind the Preview palette');
      await page.click('button[data-mode="preview"]'); await ready('preview');
      await page.evaluate(() => {
        const w = window as any; w.__outlineTransitionGate = undefined; w.__releaseOutlineSource(); delete w.__releaseOutlineSource;
      });
      expectPalette(await endTransition(), [palette.previewBackground], position, palette.editorBackground, palette.previewBackground);
      await ready('preview'); transitions += 1;

      await page.evaluate(() => {
        (window as any).__outlineTransitionGate = (mode: string) => {
          if (mode === 'source') {
            (window as any).__outlineTransitionGate = undefined;
            throw new Error('Expected outline fixture transition failure');
          }
        };
      });
      await beginTransition(); await page.click('button[data-mode="source"]'); await ready('preview');
      expectPalette(await endTransition(), [palette.previewBackground], position, palette.editorBackground, palette.previewBackground);
      transitions += 1;
    }

    // A successful retry clears the expected failure notice and restores normal interaction.
    expectPalette(await switchMode('source'), [palette.previewBackground], 'right', palette.editorBackground, palette.previewBackground);
    expectPalette(await switchMode('preview'), [palette.previewBackground], 'right', palette.editorBackground, palette.previewBackground);

    await setOutline('right', 'fixed');
    await page.hover('.outline-header');
    assert.equal(await page.$eval('.outline-content', element => getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor),
      (await snapshot()).scrollbar, 'the actual scrollbar consumes the adjacent palette');
    const beforeFocus = await snapshot();
    await page.focus('.outline-item');
    await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentWindow!.focus());
    assert.deepEqual(await snapshot(), beforeFocus, 'focus does not change outline color ownership');
    for (const preset of ['github-readme', 'newsprint', 'whitey', 'obsidian-minimal', 'default']) {
      await page.select('.preview-preset-control select', preset);
      await page.waitForFunction(preset => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement.dataset.meoPreviewPreset === preset, {}, preset);
      await check(true, `${editorAppearance}/${preset}`);
    }
    // CSS-only changes must publish actual colors without a Markdown render.
    const renders = await page.evaluate(() => (window as any).__outlineMessages.filter((message: any) => message.type === 'requestPreviewRender').length);
    await page.evaluate(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      doc.body.style.backgroundColor = '#e4ecd9';
      doc.querySelector<HTMLElement>('.meo-export-doc')!.style.color = '#24301d';
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'uiColorsChanged', colors: { dark: { documentBackground: '#19302c' }, light: { documentBackground: '#edf4f0' } } } }));
    });
    assert.equal((await check(true, `${editorAppearance}/custom CSS`)).background, 'rgb(228, 236, 217)');
    assert.equal(await page.evaluate(() => (window as any).__outlineMessages.filter((message: any) => message.type === 'requestPreviewRender').length), renders, 'color projection does not render Markdown');
    await page.select('.preview-appearance-select', 'auto');
    await page.waitForFunction(appearance => document.querySelector<HTMLElement>('.preview-host')?.style.colorScheme === appearance, {}, editorAppearance);
    await check(true, `${editorAppearance}/auto`);
    await page.evaluate(({ editorAppearance }) => {
      document.body.className = editorAppearance === 'dark' ? 'vscode-high-contrast' : 'vscode-high-contrast-light';
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'vscodeCodeThemeChanged', appearance: editorAppearance,
        vscodeTheme: { name: 'fixture-high-contrast', type: editorAppearance, colors: {}, tokenColors: [] } } }));
    }, { editorAppearance });
    const highContrast = await check(true, `${editorAppearance}/high contrast`);
    assert.ok(contrast(highContrast.border, highContrast.background) >= 3, 'high contrast boundary remains visible');
    assert.equal(await page.$eval('.outline-sidebar', element => (element as HTMLElement).dataset.outlineContrast), 'high');
    await page.close();
  }
  assert.deepEqual(errors, [], 'production Webview errors');
  console.log(`Outline adjacent document palettes passed (${cases} mode/position/preset/contrast cases, ${transitions} transitions including cancellation and rollback).`);
} finally {
  await closeTestBrowser(browser);
}
