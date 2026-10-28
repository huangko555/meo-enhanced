import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPreviewPresetLibrary, type StoredPreviewPreset } from '../src/host/customPreviewPresets';
import exportRuntime from '../src/export/runtime';
import { launchTestBrowser } from './browser-test-helpers';

mkdirSync('tmp/custom-presets', { recursive: true });
const fixturePath = path.resolve('tmp/custom-presets/preview-fixture.html');
writeFileSync(fixturePath, '<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
const katexHref = pathToFileURL(path.resolve('webview/dist/katex/katex.min.css')).href;
const store = new Map<string, StoredPreviewPreset>();
const library = createPreviewPresetLibrary({ list: async () => [...store.keys()], read: async id => store.get(id)!, write: async (id, value) => { store.set(id, value); }, remove: async id => { store.delete(id); } });
const importExample = async (name: string) => {
  const directory = path.resolve('preview-presets/examples', name);
  return library.import(readFileSync(path.join(directory, 'preset.jsonc'), 'utf8'), async file => readFileSync(path.join(directory, file), 'utf8'));
};
const dual = await importExample('paper-notes');
const single = await importExample('github-paper');
const cssTextProbe = await library.import(JSON.stringify({ schemaVersion: 1, id: 'css-text-probe', name: 'CSS text probe', description: 'Style raw-text regression', themes: { light: { css: 'light.css' } } }), async () => `/* </StYlE><style data-meo-css-escape>body{background-image:url(https://example.invalid/css-probe)}</style><style> */
.meo-export-doc { --meo-css-text: "</style><img data-meo-css-escape src='https://example.invalid/css-probe'><style>"; }`);
const fixedOn = await library.import(JSON.stringify({ schemaVersion: 1, id: 'fixed-on', name: 'Fixed comments', description: 'Policy checks', base: 'github-readme',
  controls: { htmlComments: { mode: 'fixed', value: true }, codeColoring: { mode: 'fixed', value: false } }, themes: { light: { css: 'light.css', codeTheme: 'light-plus' } } }), async () => ':root { --meo-mermaid-node-background: #445566; }');
const fixedOff = await library.import(JSON.stringify({ schemaVersion: 1, id: 'fixed-off', name: 'Fixed coloring', description: 'Policy checks', base: 'default',
  controls: { htmlComments: { mode: 'fixed', value: false }, codeColoring: { mode: 'fixed', value: true } }, themes: { dark: { css: 'dark.css' } } }), async () => ':root { --meo-bg: #24282c; }');
const copyOverride = await library.import(JSON.stringify({ schemaVersion: 1, id: 'copy-controls', name: 'Copy controls', description: 'Copy palette overrides', themes: { light: { css: 'light.css' } } }), async () => ':root { --meo-preview-code-copy-fg:#112233; --meo-preview-code-copy-bg:#ddeeff; --meo-preview-code-copy-hover-fg:#223344; --meo-preview-code-copy-hover-bg:#ccddee; }');
const text = ['# 自定义预设测试', '', '中文正文与 **粗体**，以及 [示例链接](https://example.com)。', '', '<!-- custom preset comment -->', '', '## 标题与代码', '', '> [!NOTE]', '> 检查基础渲染行为。', '', '```typescript', 'const value = { answer: 42 };', `const longLine = "${'wide content '.repeat(35)}";`, '```', '', '| 名称 | 说明 |', '| --- | --- |', '| Example | 表格内容 |', '', '$$\nx^2 + y^2 = z^2\n$$', '', '```mermaid', 'flowchart LR', '  A[Markdown] --> B[Preview]', '```', '', ...Array.from({ length: 45 }, (_, index) => `## Section ${index}\n\n正文段落 ${index}，用于验证多页导出与阅读位置。\n`)].join('\n');
const init = { type: 'init', documentId: 'file:///custom-presets.md', text, version: 1, savedRevision: { version: 1, text }, diagnostics: [], mode: 'preview', uiLanguage: 'zh-CN', sourceLineNumbers: 'on', previewAppearance: 'auto', previewFontFamily: 'Georgia', previewSourceColoring: true, previewShowComments: false, editorAppearance: 'dark', gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, vscodeTheme: null, customPreviewPresets: library.list() };
const build = await Bun.build({ entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const bundle = await build.outputs[0]!.text();
const browser = await launchTestBrowser();
const errors: string[] = [];
let failRenderPreset: string | undefined;
try {
  const open = async (state?: unknown, uiLanguage = 'zh-CN', markdownText = text) => {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    await page.setViewport({ width: 1400, height: 850 });
    await page.goto(pathToFileURL(fixturePath).href);
    await page.addStyleTag({ path: 'webview/src/styles.css' });
    await page.addStyleTag({ url: katexHref });
    await page.evaluate(href => { document.body.dataset.meoKatexSrc = href; }, katexHref);
    await page.exposeFunction('__renderCustomPreset', async (message: any) => {
      if (message.type !== 'requestPreviewRender') return null;
      try {
        if (message.preset === failRenderPreset) throw new Error('Preset renderer failed');
        const definition = message.preset?.startsWith('user:') ? library.get(message.preset) : undefined;
        return { type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value: exportRuntime.renderPreviewDocument({ markdownText: message.text, sourceDocumentPath: 'C:/tmp/custom-presets.md', uiLanguage: message.uiLanguage, styleEnvironment: message.environment, preset: message.preset, presetDefinition: definition }) } };
      } catch (error) { return { type: 'previewRenderResult', requestId: message.requestId, result: { ok: false, error: { code: 'operation-failed', message: String(error) } } }; }
    });
    await page.addScriptTag({ content: `window.__presetState=${JSON.stringify(state ?? {})};window.__presetMessages=[];window.acquireVsCodeApi=()=>({getState(){return window.__presetState},setState(state){window.__presetState=state},postMessage(message){window.__presetMessages.push(message);window.__renderCustomPreset(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
    await page.addScriptTag({ path: 'webview/dist/mermaid.min.js' });
    await page.addScriptTag({ content: bundle });
    await page.evaluate(init => window.dispatchEvent(new MessageEvent('message', { data: init })), { ...init, text: markdownText, savedRevision: { version: 1, text: markdownText }, uiLanguage, customPreviewPresets: library.list(), previewPresetDiagnostics: library.diagnostics() });
    await page.waitForFunction(title => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('h1')?.textContent === title, {}, markdownText.split('\n')[0]!.slice(2));
    return page;
  };
  const whiteyExample = await importExample('whitey');
  const whiteyText = '# Whitey 行内代码\n\n正文 / Body `SAMPLE-034-01` 与 `03400`。\n\n| `Header` | Example |\n| --- | --- |\n| 参数 | `--preview` |\n\n```typescript\nconst sample = 42;\n```';
  for (const language of ['zh-CN', 'en']) {
    const whiteyPage = await open(undefined, language, whiteyText);
    const inlinePalette = () => whiteyPage.$eval('.preview-frame', frame => {
      const doc = (frame as HTMLIFrameElement).contentDocument!;
      const style = (element: Element) => doc.defaultView!.getComputedStyle(element);
      return {
        background: style(doc.querySelector('.meo-export-doc')!).backgroundColor,
        block: style(doc.querySelector('pre.meo-export-code-block')!).backgroundColor,
        inline: [...doc.querySelectorAll('p code, th code, td code')].map(element => ({
          background: style(element).backgroundColor, color: style(element).color,
          border: style(element).boxShadow, padding: style(element).padding
        }))
      };
    });
    for (const appearance of ['light', 'dark', 'light'] as const) {
      let builtIn: Awaited<ReturnType<typeof inlinePalette>> | undefined;
      for (const preset of ['whitey', whiteyExample.id]) {
        await whiteyPage.select('.preview-preset-control select', preset);
        await whiteyPage.click(`[data-preview-appearance-choice="${appearance}"]`);
        await whiteyPage.waitForFunction(({ preset, appearance }) => {
          const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
          const root = doc?.querySelector('.meo-export-doc');
          return doc?.documentElement.dataset.meoPreviewPreset === preset && root
            && doc.defaultView!.getComputedStyle(root).backgroundColor === (appearance === 'light' ? 'rgb(254, 254, 254)' : 'rgb(30, 34, 42)');
        }, {}, { preset, appearance });
        const palette = await inlinePalette();
        assert.equal(palette.inline.length, 4, 'Whitey covers body, table header and table cell inline code');
        if (preset === 'whitey') builtIn = palette;
        else assert.deepEqual(palette, builtIn, `${language}/${appearance}: importing the Whitey example preserves the built-in inline code palette`);
      }
      await whiteyPage.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
      await whiteyPage.screenshot({ path: `tmp/custom-presets/whitey-${language}-${appearance}.png` });
    }
    await whiteyPage.close();
  }
  await library.remove(whiteyExample.id);
  const copyPalettePage = await open();
  await copyPalettePage.evaluate(() => {
    const style = document.documentElement.style;
    // Deliberately conflicting host colors expose leakage into independent palettes.
    for (const name of ['--meo-document-action-text', '--meo-document-action-hover-text', '--meo-code-action-foreground', '--meo-code-action-hover-foreground']) style.setProperty(name, '#ff00ff');
    for (const name of ['--meo-document-block-hover', '--meo-semantic-codeCopyBackground', '--meo-semantic-codeCopyHoverBackground']) style.setProperty(name, '#00ff00');
  });
  for (const [preset, appearance] of [['default', 'light'], ['default', 'dark'], ['github-readme', 'light'], ['github-readme', 'dark'], [dual.id, 'light'], [dual.id, 'dark'], [copyOverride.id, 'light'], ['default', 'dark']] as const) {
    await copyPalettePage.select('.preview-preset-control select', preset);
    await copyPalettePage.click(`[data-preview-appearance-choice="${appearance}"]`);
    await copyPalettePage.waitForFunction(({preset, appearance}) => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
      return doc?.documentElement.dataset.meoPreviewPreset === preset && document.querySelector(`[data-preview-appearance-choice="${appearance}"]`)?.getAttribute('aria-pressed') === 'true' && !!doc.querySelector('.meo-preview-code-actions > .meo-copy-code-btn');
    }, {}, {preset, appearance});
    const frame = copyPalettePage.frames().find(frame => frame.parentFrame() === copyPalettePage.mainFrame())!;
    const selector = '.meo-preview-code-actions > .meo-copy-code-btn';
    const assertReadableCopy = async () => {
      const ratio = await frame.$eval(selector, button => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d')!;
        const paint = (color: string) => { context.fillStyle = color; context.fillRect(0, 0, 1, 1); };
        const luminance = () => [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
          const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
        }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0);
        const probe = button.ownerDocument.createElement('span'); probe.style.color = 'var(--meo-code-bg, var(--meo-bg))'; button.ownerDocument.body.append(probe);
        paint(getComputedStyle(probe).color); probe.remove();
        paint(getComputedStyle(button).backgroundColor); const background = luminance();
        paint(getComputedStyle(button).color); const foreground = luminance();
        return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
      });
      assert.ok(ratio >= 4.5, `${preset}/${appearance}: independent copy foreground is readable (${ratio})`);
    };
    await copyPalettePage.mouse.move(0, 0);
    const resting = await frame.$eval(selector, button => ({color: getComputedStyle(button).color, bg: getComputedStyle(button).backgroundColor}));
    const independent = preset !== 'default' || appearance !== 'dark';
    if (independent) {
      assert.notEqual(resting.color, 'rgb(255, 0, 255)', `${preset}/${appearance}: rest foreground belongs to the preview`);
      assert.notEqual(resting.bg, 'rgb(0, 255, 0)', `${preset}/${appearance}: rest background belongs to the preview`);
      await assertReadableCopy();
    } else assert.equal(resting.color, 'rgb(255, 0, 255)', 'Matching default preview follows the host document action role');
    if (preset === copyOverride.id) assert.deepEqual(resting, { color: 'rgb(17, 34, 51)', bg: 'rgb(221, 238, 255)' }, 'Custom CSS retains its own copy control overrides');
    await frame.hover('.meo-export-code-block-wrap');
    await frame.hover(selector);
    const hover = await frame.$eval(selector, button => ({color: getComputedStyle(button).color, bg: getComputedStyle(button).backgroundColor}));
    assert.notEqual(hover.bg, 'rgba(0, 0, 0, 0)', `${preset}/${appearance}: hover has a visible carrier`);
    if (independent) {
      assert.notEqual(hover.color, 'rgb(255, 0, 255)');
      assert.notEqual(hover.bg, 'rgb(0, 255, 0)');
      await assertReadableCopy();
    }
    if (preset === copyOverride.id) assert.deepEqual(hover, { color: 'rgb(34, 51, 68)', bg: 'rgb(204, 221, 238)' });
    await copyPalettePage.keyboard.press('Tab');
    await frame.$eval(selector, button => (button as HTMLElement).focus({preventScroll: true}));
    const focus = await frame.$eval(selector, button => ({visible: button.matches(':focus-visible'), width: getComputedStyle(button).outlineWidth, style: getComputedStyle(button).outlineStyle, color: getComputedStyle(button).outlineColor}));
    assert.equal(focus.visible, true);
    assert.equal(focus.width, '1px'); assert.equal(focus.style, 'solid');
    if (independent) assert.notEqual(focus.color, 'rgb(255, 0, 255)');
  }
  await copyPalettePage.close();
  const narrowTablePage = await open(undefined, 'en', '# Narrow table\n\n| Alpha | Beta | Gamma | Delta | Epsilon |\n| --- | --- | --- | --- | --- |\n| 一段较长的中文内容 | long-unbroken-english-content | Value | 7 | Tail |');
  for (const preset of ['default', dual.id, single.id]) {
    await narrowTablePage.setViewport({ width: 1400, height: 850 });
    if (preset !== 'default') {
      await narrowTablePage.click('.preview-preset-dropdown');
      await narrowTablePage.click(`.preview-preset-dropdown-panel [data-value="${preset}"]`);
    }
    await narrowTablePage.setViewport({ width: 360, height: 850 });
    await narrowTablePage.waitForFunction(preset => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
      const table = doc?.querySelector('table'), wrap = table?.parentElement;
      return doc?.documentElement.dataset.meoPreviewPreset === preset && table?.querySelector('colgroup[data-meo-preview-columns]') && wrap
        && table.getBoundingClientRect().right <= wrap.getBoundingClientRect().left + wrap.clientLeft + wrap.clientWidth + .1
        && table.classList.contains('meo-preview-table-compressed');
    }, { timeout: 5000 }, preset);
    const layout = await narrowTablePage.$eval('.preview-frame', element => {
      const doc = (element as HTMLIFrameElement).contentDocument!, table = doc.querySelector<HTMLTableElement>('table')!, wrap = table.parentElement!;
      return { renderer: doc.documentElement.dataset.meoPreviewRenderer, columns: [...table.querySelectorAll<HTMLTableColElement>('colgroup[data-meo-preview-columns] > col')].map(col => col.style.width), fixed: doc.defaultView!.getComputedStyle(table).tableLayout,
        cellsVisible: [...table.querySelectorAll('th,td')].every(cell => cell.getBoundingClientRect().width > 0), compressed: table.classList.contains('meo-preview-table-compressed'), padding: table.style.getPropertyValue('--meo-preview-table-cell-inline-padding'),
        contained: table.getBoundingClientRect().right <= wrap.getBoundingClientRect().left + wrap.clientLeft + wrap.clientWidth + .1, overflowing: wrap.classList.contains('is-table-overflowing'), width: wrap.clientWidth };
    });
    assert.equal(layout.renderer, 'meo');
    assert.equal(layout.columns.length, 5);
    assert.ok(layout.columns.every(width => parseFloat(width) > 0));
    assert.equal(layout.fixed, 'fixed');
    assert.equal(layout.cellsVisible, true);
    assert.equal(layout.contained, true, `${preset}: narrow tables stay within their visible wrapper`);
    assert.equal(layout.overflowing, false);
    assert.ok(layout.width < 450, `${preset}: fixture exercises a narrow wrapper`);
    assert.equal(layout.compressed, true);
    assert.ok(layout.padding);
    console.log(`Narrow Preview table layout: ${preset} passed`);
  }
  await narrowTablePage.close();
  const page = await open();
  const choose = async (id: string) => {
    await page.click('.preview-preset-dropdown');
    await page.click(`.preview-preset-dropdown-panel [data-value="${id}"]`);
    await page.waitForFunction(id => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement.dataset.meoPreviewPreset === id, {}, id);
  };
  const visual = () => page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const style = doc.defaultView!.getComputedStyle(doc.querySelector('.meo-export-doc')!);
    return { background: style.backgroundColor, canvas: doc.defaultView!.getComputedStyle(doc.body).backgroundColor, color: style.color, font: style.fontFamily, h1: doc.defaultView!.getComputedStyle(doc.querySelector('h1')!).fontSize, preset: doc.documentElement.dataset.meoPreviewPreset, revision: doc.documentElement.dataset.meoPreviewPresetRevision };
  });
  const uiBefore = await page.$eval('.mode-toolbar', el => getComputedStyle(el).backgroundColor);
  const showInfo = async (target = page) => {
    await target.hover('.preview-preset-info');
    await target.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('.meo-tooltip.is-visible')].some(el => getComputedStyle(el).opacity === '1' && getComputedStyle(el).visibility === 'visible'));
    return target.$eval('.meo-tooltip.is-visible', el => el.textContent!);
  };
  assert.equal(await page.$eval('.preview-preset-info', el => (el as HTMLElement).hidden), false, 'Default also exposes preset information');
  assert.equal(await showInfo(), '使用编辑器的阅读样式与预览设置。');
  await page.screenshot({ path: 'tmp/custom-presets/info-default.png' });
  await page.mouse.move(1300, 500);
  await choose(dual.id);
  assert.deepEqual((await visual()).background, 'rgb(36, 40, 44)');
  assert.equal((await visual()).canvas, 'rgb(36, 40, 44)');
  assert.equal((await visual()).h1, '30px');
  assert.equal((await visual()).color, 'rgb(226, 229, 231)');
  assert.equal(await page.$eval('.mode-toolbar', el => getComputedStyle(el).backgroundColor), uiBefore, 'Document CSS does not recolor the toolbar');
  assert.equal(await page.$eval('.preview-font-family-control', el => (el as HTMLElement).hidden), false);
  assert.equal(await page.$eval('.preview-code-font-family-control', el => (el as HTMLElement).hidden), false, 'Fixed custom presets show both font overrides');
  assert.equal(await page.$eval('.preview-code-font-family-dropdown', el => (el as HTMLButtonElement).disabled), true);
  assert.equal(await page.$eval('.preview-font-family-dropdown', el => (el as HTMLButtonElement).disabled), true);
  await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('.meo-export-mermaid.is-rendered'));
  await page.evaluate(async () => { await document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.fonts.ready; });
  assert.ok(await page.$eval('.preview-frame', frame => {
    const doc = (frame as HTMLIFrameElement).contentDocument!;
    return doc.defaultView!.getComputedStyle(doc.querySelector('.katex')!).fontFamily.includes('KaTeX_Main');
  }), 'Preview includes the production formula stylesheet and fonts');
  await page.screenshot({ path: 'tmp/custom-presets/preview-dark.png' });
  await page.click('[data-preview-appearance-choice="light"]');
  await page.waitForFunction(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    return doc.defaultView!.getComputedStyle(doc.body).backgroundColor === 'rgb(250, 250, 248)';
  });
  await page.screenshot({ path: 'tmp/custom-presets/preview-light.png' });
  const state = await page.evaluate(() => (window as any).__presetState);
  const restored = await open(state);
  await restored.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement.dataset.meoPreviewPreset === 'user:paper-notes');
  assert.equal(await restored.$eval('[data-preview-appearance-choice="light"]', el => el.getAttribute('aria-pressed')), 'true');
  await restored.close();
  await choose(single.id);
  const fixed = await page.$eval('.preview-appearance-control', el => ({ hidden: (el as HTMLElement).hidden, reason: el.querySelector<HTMLElement>('.segmented-control')!.dataset.tooltip, buttons: [...el.querySelectorAll<HTMLButtonElement>('button')].map(button => ({ disabled: button.disabled, hidden: button.hidden, selected: button.getAttribute('aria-pressed') })) }));
  assert.equal(fixed.hidden, false);
  assert.equal(fixed.reason, '此预设仅支持浅色主题');
  assert.equal(fixed.buttons.length, 3);
  assert.ok(fixed.buttons.every(button => button.disabled && !button.hidden));
  const themeBounds = await page.$eval('.preview-appearance-control .segmented-control', el => ({ left: el.getBoundingClientRect().left, top: el.getBoundingClientRect().top, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }));
  const hoverTheme = async (x: number) => {
    await page.mouse.move(x, themeBounds.top + themeBounds.height / 2);
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('.meo-tooltip')].some(el => el.textContent === '此预设仅支持浅色主题' && getComputedStyle(el).opacity === '1'));
    return page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.meo-tooltip')].find(el => el.textContent === '此预设仅支持浅色主题')!.getBoundingClientRect().left);
  };
  const tooltipLeft = await hoverTheme(themeBounds.left + 6);
  assert.ok(await hoverTheme(themeBounds.left + themeBounds.width - 6) > tooltipLeft + 50, 'Disabled theme tooltips follow the pointer across the whole segmented control');
  await page.mouse.move(1300, 500);
  assert.equal((await visual()).background, 'rgb(255, 255, 255)');
  await page.click('.preview-preset-dropdown');
  await page.click('.preview-preset-dropdown-panel .preview-dropdown-footer');
  assert.equal(await page.$eval('.settings-tab[data-tab="presets"]', el => el.getAttribute('aria-selected')), 'true');
  assert.equal(await page.$eval('.preview-preset-dropdown-panel', el => (el as HTMLElement).hidden), true);
  assert.equal((await visual()).preset, single.id, 'The management action does not become the selected preset');
  await page.click('.settings-close');
  assert.equal(await page.$eval('.preview-export-note', el => el.textContent), 'HTML、PDF 沿用当前预览样式。\nWord 使用固定导出样式。');
  const controlState = (selector: string) => page.$eval(selector, el => ({ hidden: (el as HTMLElement).hidden, reason: (el as HTMLElement).dataset.tooltip,
    buttons: [...el.querySelectorAll<HTMLButtonElement>('button')].map(button => ({ disabled: button.disabled, selected: button.getAttribute('aria-pressed') })) }));
  const waitBehavior = async (comments: boolean, coloring: boolean) => {
    try { await page.waitForFunction((comments, coloring) => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    const code = doc?.querySelector<HTMLElement>('.meo-export-code-line-source');
    const colors = new Set([...code?.querySelectorAll('span') ?? []].map(span => doc!.defaultView!.getComputedStyle(span).color));
    return Boolean(doc?.body.textContent?.includes('custom preset comment')) === comments
      && doc?.documentElement.dataset.meoPreviewSourceColoring === String(coloring)
      && (coloring ? Boolean(code?.dataset.meoShiki) && colors.size > 1 : colors.size <= 1);
    }, {}, comments, coloring); }
    catch (error) {
      await page.screenshot({ path: 'tmp/custom-presets/controls-failure.png' });
      const actual = await page.$eval('.preview-frame', frame => {
        const doc = (frame as HTMLIFrameElement).contentDocument!;
        return { preset: doc.documentElement.dataset.meoPreviewPreset, coloring: doc.documentElement.dataset.meoPreviewSourceColoring,
          comments: doc.body.textContent!.includes('custom preset comment'), code: doc.querySelector('.meo-export-code-line-source')?.outerHTML };
      });
      throw new Error(`Expected comments=${comments}, coloring=${coloring}; actual=${JSON.stringify(actual)}`, { cause: error });
    }
  };
  assert.equal((await controlState('.preview-show-comments')).hidden, false);
  assert.ok((await controlState('.preview-show-comments')).buttons.every(button => !button.disabled));
  assert.equal((await controlState('.preview-source-coloring')).hidden, false);
  assert.ok((await controlState('.preview-source-coloring')).buttons.every(button => button.disabled));
  assert.ok((await controlState('.preview-source-coloring')).reason?.includes('固定开启代码着色'));
  assert.equal(await showInfo(), single.description['zh-CN']);
  await page.mouse.move(1300, 500);
  await page.click('.preview-options-trigger');
  await page.click('[data-preview-comments="true"]');
  await waitBehavior(true, true);
  await choose(dual.id);
  await page.click('.preview-options-trigger');
  await page.click('[data-preview-comments="true"]');
  await page.click('[data-preview-source-coloring="false"]');
  await waitBehavior(true, false);
  assert.ok((await controlState('.preview-source-coloring')).buttons.every(button => !button.disabled), 'Named palettes remain editable');
  for (const [preset, comments, coloring] of [[fixedOn, true, false], [fixedOff, false, true]] as const) {
    await choose(preset.id);
    await waitBehavior(comments, coloring);
    for (const kind of ['font', 'code-font']) {
      const control = await controlState(`.preview-${kind}-family-control`);
      assert.equal(control.hidden, false, 'Custom presets show the same font settings');
      assert.ok(control.buttons.every(button => button.disabled));
      assert.equal(control.reason, '字体由此预设的样式决定');
    }
    for (const [selector, enabled] of [['.preview-show-comments', comments], ['.preview-source-coloring', coloring]] as const) {
      const control = await controlState(selector);
      assert.equal(control.hidden, false);
      assert.ok(control.buttons.every(button => button.disabled));
      assert.deepEqual(control.buttons.map(button => button.selected), enabled ? ['true', 'false'] : ['false', 'true']);
      assert.ok(control.reason?.includes('固定'));
    }
    const messageCount = await page.evaluate(() => (window as any).__presetMessages.length);
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('.preview-font-family-dropdown')!.click();
      document.querySelector<HTMLButtonElement>('.preview-code-font-family-dropdown')!.click();
      document.querySelector<HTMLButtonElement>('[data-preview-comments="false"]')!.click();
      document.querySelector<HTMLButtonElement>('[data-preview-source-coloring="true"]')!.click();
    });
    assert.equal(await page.evaluate(() => (window as any).__presetMessages.length), messageCount, 'Disabled controls do not change preferences or render');
  }
  await choose(fixedOn.id);
  assert.equal(await showInfo(), fixedOn.description['zh-CN']);
  await page.mouse.move(1300, 500);
  await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('.meo-export-mermaid.is-rendered'));
  assert.equal(await page.$eval('.preview-frame', frame => {
    const doc = (frame as HTMLIFrameElement).contentDocument!;
    return doc.defaultView!.getComputedStyle(doc.querySelector('.meo-export-mermaid .node rect')!).fill;
  }), 'rgb(68, 85, 102)', 'GitHub-based custom styles use their own Mermaid palette');
  await page.screenshot({ path: 'tmp/custom-presets/fixed-controls.png' });
  for (const target of ['html', 'pdf'] as const) {
    const result = await exportRuntime.renderExportHtmlDocument({ readingSnapshot: { snapshotId: 'fixed', text, appearance: 'light', uiLanguage: 'zh-CN', environment: { previewFontFamily: '', previewSourceColoring: true, previewShowComments: false }, preset: fixedOn.id, presetRevision: fixedOn.custom!.revision },
      presetDefinition: fixedOn, sourceDocumentPath: path.resolve('tmp/custom-presets/document.md'), outputFilePath: path.resolve(`tmp/custom-presets/fixed.${target}`), target,
      mermaidRuntimeSrc: pathToFileURL(path.resolve('webview/dist/mermaid.min.js')).href, katexStylesHref: katexHref, baseHref: pathToFileURL(path.resolve('tmp/custom-presets') + path.sep).href,
      title: 'Fixed controls', shikiLanguageAssetsRoot: path.resolve('webview/dist') });
    const exported = await browser.newPage();
    const exportPath = path.resolve(`tmp/custom-presets/fixed-${target}.html`);
    writeFileSync(exportPath, result.htmlDocument);
    await exported.goto(pathToFileURL(exportPath).href);
    await exported.waitForFunction(() => (window as any).__MEO_EXPORT_READY__ === true && Boolean(document.querySelector('.meo-export-mermaid.is-rendered')));
    assert.ok(await exported.$('.meo-export-doc.markdown-body'));
    assert.equal(await exported.$eval('.meo-export-doc', el => el.textContent!.includes('custom preset comment')), true);
    assert.equal(await exported.$$eval('.meo-export-code-line-source span[style]', spans => spans.length), 0);
    assert.equal(await exported.$eval('.meo-export-mermaid .node rect', el => getComputedStyle(el).fill), 'rgb(68, 85, 102)', `${target} retains the custom diagram palette`);
    await exported.close();
  }
  const english = await open(await page.evaluate(() => (window as any).__presetState), 'en');
  await english.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement.dataset.meoPreviewPreset === 'user:fixed-on');
  assert.equal(await showInfo(english), fixedOn.description.en);
  await english.close();
  await choose('default');
  await waitBehavior(false, true);
  assert.equal((await controlState('.preview-show-comments')).reason, '');
  assert.ok((await controlState('.preview-source-coloring')).buttons.every(button => !button.disabled), 'Switching back restores user settings');
  await choose(single.id);
  await assert.rejects(library.import(JSON.stringify(library.files(single.id)!.manifest), async () => '.toolbar { color: red; }'), /Prefix each document selector/);
  await page.evaluate(event => window.dispatchEvent(new MessageEvent('message', { data: event })), { type: 'previewPresetsChanged', presets: library.list(), diagnostics: library.diagnostics() });
  await page.waitForSelector('.preview-preset-info.has-error');
  const errorColor = await page.evaluate(() => {
    const probe = document.createElement('span'); probe.style.color = 'var(--meo-ui-danger)'; document.body.append(probe);
    const color = getComputedStyle(probe).color; probe.remove(); return color;
  });
  assert.equal(await page.$eval('.preview-preset-info', el => getComputedStyle(el).color), errorColor, 'Preset errors use the shared UI error color');
  const errorInfo = await showInfo();
  assert.ok(await page.$('.meo-tooltip-error strong .meo-tooltip-error-icon'));
  assert.ok(errorInfo.includes(single.description['zh-CN']) && errorInfo.includes('预设错误') && errorInfo.includes('light.css') && errorInfo.includes('Prefix each document selector'));
  assert.equal((await visual()).background, 'rgb(255, 255, 255)', 'An invalid update keeps the last usable preset');
  await page.screenshot({ path: 'tmp/custom-presets/info-error.png' });
  await page.mouse.move(1300, 500);
  const englishManifest = { ...library.files(single.id)!.manifest, id: 'github-paper-en', name: 'GitHub Paper', description: { en: 'A light reading style based on GitHub.', 'zh-CN': '采用 GitHub 外观的浅色阅读样式。' } };
  const englishPreset = await library.import(JSON.stringify(englishManifest), async file => library.files(single.id)!.files[file]!);
  await assert.rejects(library.import(JSON.stringify(englishManifest), async () => '.toolbar { color: red; }'));
  const englishText = '# Custom preset preview\n\nBody text with **bold**, *italic*, and a [sample link](https://example.com).\n\n<!-- custom preset comment -->\n\n## Headings and code\n\n> [!NOTE]\n> The previous working style stays available after an invalid update.\n\n```typescript\nconst value = { answer: 42 };\n```\n\n| Name | Description |\n| --- | --- |\n| Example | Table content |\n\n$$\nx^2 + y^2 = z^2\n$$\n\n```mermaid\nflowchart LR\n  A[Markdown] --> B[Preview]\n```';
  const englishError = await open({ previewPresetState: { preset: englishPreset.id, preferences: {} } }, 'en', englishText);
  await englishError.waitForSelector('.preview-preset-info.has-error');
  const englishErrorInfo = await showInfo(englishError);
  assert.ok(englishErrorInfo.includes(englishManifest.description.en) && englishErrorInfo.includes('Preset error'));
  assert.ok(!englishErrorInfo.includes(englishManifest.description['zh-CN']));
  await englishError.screenshot({ path: 'tmp/custom-presets/info-error-en.png' });
  await englishError.close();
  await library.remove(englishPreset.id);
  await importExample('github-paper');
  await page.evaluate(event => window.dispatchEvent(new MessageEvent('message', { data: event })), { type: 'previewPresetsChanged', presets: library.list(), diagnostics: library.diagnostics() });
  await page.waitForFunction(() => !document.querySelector('.preview-preset-info.has-error'));
  assert.ok(!(await showInfo()).includes('预设错误'), 'Correcting the package clears the error details');
  await page.mouse.move(1300, 500);
  await choose(dual.id);
  await page.click('.preview-options-trigger');
  await page.click('[data-preview-source-coloring="true"]');
  await page.click('[data-preview-comments="false"]');
  await waitBehavior(false, true);
  await choose(dual.id);
  await page.click('[data-preview-appearance-choice="dark"]');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'requestExportSnapshot', requestId: 'custom-export' } })));
  await page.waitForFunction(() => (window as any).__presetMessages.some((message: any) => message.type === 'exportSnapshotResult' && message.requestId === 'custom-export'));
  const snapshot = await page.evaluate(() => (window as any).__presetMessages.find((message: any) => message.type === 'exportSnapshotResult' && message.requestId === 'custom-export').result.value);
  assert.equal(snapshot.appearance, 'dark');
  assert.equal(snapshot.preset, dual.id);
  assert.equal(snapshot.presetRevision, dual.custom!.revision);
  const options = { readingSnapshot: snapshot, presetDefinition: dual, sourceDocumentPath: path.resolve('tmp/custom-presets/document.md'), outputFilePath: path.resolve('tmp/custom-presets/export.html'), target: 'html' as const, mermaidRuntimeSrc: pathToFileURL(path.resolve('webview/dist/mermaid.min.js')).href, katexStylesHref: pathToFileURL(path.resolve('webview/dist/katex/katex.min.css')).href, baseHref: pathToFileURL(path.resolve('tmp/custom-presets') + path.sep).href, title: 'Custom preset export', includeTableOfContents: true, shikiLanguageAssetsRoot: path.resolve('webview/dist') };
  const html = await exportRuntime.renderExportHtmlDocument(options);
  writeFileSync(options.outputFilePath, html.htmlDocument);
  const exported = await browser.newPage();
  await exported.setViewport({ width: 1400, height: 850 });
  await exported.goto(pathToFileURL(options.outputFilePath).href);
  await exported.waitForFunction(() => (window as any).__MEO_EXPORT_READY__ === true);
  assert.equal(await exported.$eval('.meo-export-doc', el => getComputedStyle(el).backgroundColor), 'rgb(36, 40, 44)');
  assert.equal(await exported.$eval('h1', el => getComputedStyle(el).fontSize), '30px');
  assert.equal(await exported.$eval('.meo-export-toc-link', el => getComputedStyle(el).color), 'rgb(131, 189, 178)');
  assert.ok(await exported.$('.meo-export-mermaid.is-rendered'));
  await exported.screenshot({ path: 'tmp/custom-presets/export-html-dark.png' });
  const pdf = await exportRuntime.renderExportHtmlDocument({ ...options, target: 'pdf', outputFilePath: path.resolve('tmp/custom-presets/export.pdf') });
  await exported.setContent(pdf.htmlDocument);
  await exported.waitForFunction(() => (window as any).__MEO_EXPORT_READY__ === true);
  const overflow = await exported.evaluate(() => {
    const root = document.querySelector('.meo-export-doc')!.getBoundingClientRect();
    return Array.from(document.querySelectorAll('.meo-export-code-line-source, table')).some(el => el.getBoundingClientRect().right > root.right + 1);
  });
  assert.equal(overflow, false, 'PDF code and tables fit the page');
  await exported.close();
  await exportRuntime.renderPdfFromHtmlExport({ htmlDocument: pdf.htmlDocument, outputPdfPath: path.resolve('tmp/custom-presets/export.pdf'), puppeteerRuntimeModulePath: path.resolve('dist/puppeteer-runtime.js') });
  const pdfBytes = readFileSync('tmp/custom-presets/export.pdf');
  assert.ok(pdfBytes.subarray(0, 5).toString() === '%PDF-');
  assert.ok((pdfBytes.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length > 2, 'A real multipage PDF is generated');
  const replacement = { schemaVersion: 1, id: 'paper-notes', name: 'Updated notes', description: 'Dark only', base: 'default', themes: { dark: { css: 'dark.css' } } };
  const updated = await library.import(JSON.stringify(replacement), async () => ':root { --meo-bg: #303438; --meo-mermaid-node-background: #445566; }');
  await page.evaluate(event => window.dispatchEvent(new MessageEvent('message', { data: event })), { type: 'previewPresetsChanged', presets: library.list() });
  await page.waitForFunction(revision => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement.dataset.meoPreviewPresetRevision === revision, {}, updated.custom!.revision);
  assert.equal((await visual()).background, 'rgb(48, 52, 56)');
  await page.waitForFunction(revision => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector<HTMLElement>('.meo-export-mermaid')?.dataset.meoPreviewMermaidPresetRevision === revision, {}, updated.custom!.revision);
  assert.equal(await page.$eval('.preview-frame', frame => {
    const doc = (frame as HTMLIFrameElement).contentDocument!;
    return doc.defaultView!.getComputedStyle(doc.querySelector('.meo-export-mermaid .node rect')!).fill;
  }), 'rgb(68, 85, 102)', 'Updating a preset refreshes retained Mermaid SVG colors');
  await library.remove(dual.id);
  await page.evaluate(event => window.dispatchEvent(new MessageEvent('message', { data: event })), { type: 'previewPresetsChanged', presets: library.list() });
  await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement.dataset.meoPreviewPreset === 'default');
  assert.equal(await page.$eval('.preview-font-family-control', el => (el as HTMLElement).hidden), false);
  await choose('github-readme');
  assert.equal((await visual()).background, 'rgb(13, 17, 23)');
  assert.ok((await showInfo()).includes('与真实 GitHub README 的差异'), 'Built-in differences remain part of the description');
  await page.mouse.move(1300, 500);
  failRenderPreset = 'github-readme';
  await page.evaluate(event => window.dispatchEvent(new MessageEvent('message', { data: event })), { type: 'previewPresetsChanged', presets: library.list(), diagnostics: [] });
  await page.waitForSelector('.preview-preset-info.has-error');
  assert.ok((await showInfo()).includes('Preset renderer failed'), 'Built-in render failures use the same error presentation');
  await page.mouse.move(1300, 500);
  failRenderPreset = undefined;
  await page.evaluate(event => window.dispatchEvent(new MessageEvent('message', { data: event })), { type: 'previewPresetsChanged', presets: library.list(), diagnostics: [] });
  await page.waitForFunction(() => !document.querySelector('.preview-preset-info.has-error'));
  library.reportError('user:missing', 'missing/preset.jsonc: themes: provide at least one theme');
  const fallback = await open({ previewPresetState: { preset: 'user:missing', preferences: {} } });
  await fallback.waitForSelector('.preview-preset-info.has-error');
  assert.ok((await showInfo(fallback)).includes('missing/preset.jsonc'), 'Unusable saved presets report their loading errors after fallback');
  assert.equal(await fallback.$eval('.preview-frame', frame => (frame as HTMLIFrameElement).contentDocument!.documentElement.dataset.meoPreviewPreset), 'default');
  await fallback.close();
  const cssProbePage = await open(undefined, 'en', '# CSS remains text');
  const initialStyleCount = await cssProbePage.$eval('.preview-frame', element => (element as HTMLIFrameElement).contentDocument!.querySelectorAll('style').length);
  const escapedResourceRequests: string[] = [];
  await cssProbePage.setRequestInterception(true);
  cssProbePage.on('request', request => {
    if (request.url().startsWith('https://example.invalid/')) {
      escapedResourceRequests.push(request.url()); void request.abort();
    } else { void request.continue(); }
  });
  await cssProbePage.click('.preview-preset-dropdown');
  await cssProbePage.click(`.preview-preset-dropdown-panel [data-value="${cssTextProbe.id}"]`);
  await cssProbePage.waitForFunction(preset => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement.dataset.meoPreviewPreset === preset, {}, cssTextProbe.id);
  const cssProbe = await cssProbePage.$eval('.preview-frame', element => {
    const doc = (element as HTMLIFrameElement).contentDocument!;
    return { escaped: doc.querySelectorAll('[data-meo-css-escape]').length, styleCount: doc.querySelectorAll('style').length, heading: doc.querySelector('h1')?.textContent };
  });
  assert.deepEqual(cssProbe, { escaped: 0, styleCount: initialStyleCount, heading: 'CSS remains text' }, 'CSS comments and strings cannot terminate the Preview style element');
  assert.deepEqual(escapedResourceRequests, [], 'CSS raw-text cannot inject external resource requests');
  await cssProbePage.close();
  assert.deepEqual(errors, []);
  await page.close();
  console.log('Custom presets: production Preview, themes, restoration, updates/removal, UI isolation, HTML and real multipage PDF passed.');
} finally { await browser.close(); }
