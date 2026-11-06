import { installPackagedMermaid } from './mermaid-runtime-test-helpers';
import assert from 'node:assert/strict';
import { launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';
import fs from 'node:fs/promises';
import path from 'node:path';

// Fixed pre-migration Live colors (04a97074), including the computed header
// fill. Compare distinction rather than copying those RGB values into themes.
const legacySurfaces = {
  light: { document: 'rgb(255, 255, 255)', inline: 'rgb(230, 232, 235)', table: 'rgb(248, 249, 250)' },
  dark: { document: 'rgb(31, 31, 31)', inline: 'rgb(68, 72, 77)', table: 'rgb(37, 38, 40)' }
};
const contrastRatio = (first: string, second: string): number => {
  const luminance = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(channel => {
    const c = channel / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

const build = await Bun.build({ entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const bundle = await build.outputs[0]!.text();
const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  let renderRequests = 0;
  page.on('pageerror', error => errors.push(String(error)));
  await page.setViewport({ width: 1200, height: 760 });
  await page.setContent('<!doctype html><style id="host-theme">:root{--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px}html,body,#app{height:100%;margin:0}</style><body class="vscode-dark"><div id="app"></div></body>');
  // Real VS Code injects theme variables inline; stylesheet-only fixtures miss
  // accidental removal of the native background during appearance setup.
  await page.evaluate(() => document.documentElement.style.setProperty('--vscode-editor-background', '#1b2430'));
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.exposeFunction('__renderBackgroundPreview', (message: any) => {
    if (message.type !== 'requestPreviewRender') return null;
    renderRequests++;
    return { type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value: exportRuntime.renderPreviewDocument({
      markdownText: message.text, sourceDocumentPath: 'C:/tmp/background.md', uiLanguage: message.uiLanguage,
      styleEnvironment: message.environment, preset: message.preset, contentWidth: message.contentWidth
    }) } };
  });
  await page.addScriptTag({ content: 'window.acquireVsCodeApi=()=>({getState(){return {}},setState(){},postMessage(message){window.__renderBackgroundPreview(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent("message",{data:response}));});}});' });
  await installPackagedMermaid(page);
  await page.addScriptTag({ content: bundle });
  const text = ['---', 'title: Document surfaces', 'tags: [theme, color]', '---', '',
    '# 文档表面配色', '', '代码、表格与边线从同一文档背景派生。`inline code` 使用独立底色，<kbd>Ctrl</kbd> 保持轮廓。', '',
    '> 引用边线与下方表格网格、分割线共用正文边线。', '',
    '```typescript', 'const background = "document";', 'const shared = ["code", "formula", "frontmatter"];', 'console.log(shared);', '```', '',
    '| 项目 `header code` | 背景来源 |', '| --- | --- |', '| 代码块 | 块表面 |', '| 表头与隔行 `stripe code` | 同一个弱表面 |', '| 分割线 | 文档边线 |', '',
    '---', '', '```mermaid', 'flowchart LR', 'A[文档背景] -->|派生| B[块表面]', '```', '',
    '行内公式 $a^2+b^2=c^2$ 的阅读状态保持透明。', '', '$$', 'E = mc^2', '$$', '',
    '- 列表强调保留内容强调色', '- 脚注淡底也保留内容强调来源[^note]', '', '[^note]: 这是脚注内容。', '',
    ...Array.from({ length: 35 }, () => 'Reading paragraph.\n')].join('\n');
  await page.evaluate(init => window.dispatchEvent(new MessageEvent('message', { data: init })), {
    type: 'init', documentId: 'file:///background.md', text, version: 1, savedRevision: { version: 1, text },
    diagnostics: [], mode: 'preview', uiLanguage: 'en', sourceLineNumbers: 'on', previewAppearance: 'auto',
    previewFontFamily: '', previewSourceColoring: false, previewShowComments: false, editorAppearance: 'auto',
    gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit',
    fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false,
    findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
    vscodeTheme: { name: 'Native dark', type: 'dark', colors: {}, tokenColors: [] }
  });
  const waitBackground = async (expected: string) => {
    await page.waitForFunction(expected => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
      return getComputedStyle(document.body).backgroundColor === expected
        && doc?.body && doc.defaultView!.getComputedStyle(doc.body).backgroundColor === expected;
    }, { timeout: 4000 }, expected);
  };
  const readChrome = async () => {
    const indicator = await page.$eval('.segmented-control-button.is-active .segmented-control-button-indicator', element => {
      const context = document.createElement('canvas').getContext('2d')!;
      context.fillStyle = getComputedStyle(element).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
    });
    return {indicator, toolbar: await page.$eval('.mode-toolbar', element => getComputedStyle(element).backgroundColor)};
  };
  const checkModes = async (expected: string, chrome: Awaited<ReturnType<typeof readChrome>>) => {
    await waitBackground(expected);
    for (const mode of ['live', 'source', 'preview']) {
      await page.click(`button[data-mode="${mode}"]`);
      await page.waitForFunction(mode => document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === mode, {}, mode);
      assert.equal(await page.$eval('body', element => getComputedStyle(element).backgroundColor), expected);
      if (mode !== 'preview') assert.equal(await page.$eval('.cm-editor', element => getComputedStyle(element).backgroundColor), expected);
      if (mode === 'live') {
        await page.waitForSelector('.meo-md-html-table th code');
        assert.equal(await page.$eval('.cm-content kbd', element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)', 'Live keyboard labels have no fill');
        const table = await page.evaluate(() => {
          const header = document.querySelector('.meo-md-html-table th')!;
          const stripe = document.querySelector('.meo-md-html-table tbody tr:nth-child(2) td')!;
          const value = (element: Element) => getComputedStyle(element).backgroundColor;
          const probe = document.createElement('span'); probe.style.color = 'var(--meo-document-inline)'; document.body.append(probe);
          const inline = getComputedStyle(probe).color; probe.remove();
          return { header: value(header), stripe: value(stripe), headerCode: value(header.querySelector('code')!), stripeCode: value(stripe.querySelector('code')!), inline,
            appearance: document.documentElement.dataset.editorAppearance, document: value(document.body) };
        });
        assert.equal(table.header, table.stripe, 'Live table headers and alternate rows share one fill');
        assert.equal(table.headerCode, table.inline, 'inline code keeps its own surface inside a filled header');
        assert.equal(table.stripeCode, table.inline, 'inline code keeps its own surface inside a filled alternate row');
        assert.notEqual(table.inline, table.header, 'a subtle table fill must not erase inline code');
        const previous = legacySurfaces[table.appearance as 'light' | 'dark'];
        for (const [label, current, reference, tolerance] of [
          ['inline/document', contrastRatio(table.inline, table.document), contrastRatio(previous.inline, previous.document), 0.04],
          ['table/document', contrastRatio(table.header, table.document), contrastRatio(previous.table, previous.document), 0.02],
          ['inline/filled row', contrastRatio(table.inline, table.header), contrastRatio(previous.inline, previous.table), 0.05]
        ] as const) {
          assert.ok(Math.abs(current - reference) < tolerance, `${table.appearance} ${label} distinction changed from ${reference.toFixed(3)} to ${current.toFixed(3)}`);
        }
      }
    }
    await waitBackground(expected);
    try {
      await page.waitForFunction(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
        const label = doc?.querySelector('.meo-export-mermaid svg .edgeLabel');
        const code = doc?.querySelector('pre');
        return label && code && doc!.defaultView!.getComputedStyle(label).backgroundColor === doc!.defaultView!.getComputedStyle(code).backgroundColor;
      }, { timeout: 8000 });
    } catch (error) {
      const actual = await page.evaluate(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
        const background = (selector: string) => {
          const element = doc?.querySelector(selector);
          return element ? doc!.defaultView!.getComputedStyle(element).backgroundColor : 'missing';
        };
        return { code: background('pre'), label: background('.meo-export-mermaid svg .edgeLabel'),
          block: doc?.querySelector('.meo-export-mermaid')?.outerHTML.slice(0, 400) };
      });
      throw new Error(`Mermaid surfaces for ${expected}: ${JSON.stringify(actual)}`, { cause: error });
    }
    assert.deepEqual(await readChrome(), chrome, 'Toolbar and selected segment colors remain independent of the document background');
    const previewSurfaces = await page.evaluate(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const role = (name: string) => {
        const probe = document.createElement('span'); probe.style.color = `var(--meo-document-${name})`; document.body.append(probe);
        const value = getComputedStyle(probe).color; probe.remove(); return value;
      };
      const read = (selector: string, property: 'backgroundColor' | 'borderLeftColor' | 'borderTopColor' | 'borderRightColor') => doc.defaultView!.getComputedStyle(doc.querySelector(selector)!)[property];
      return { block: read('pre', 'backgroundColor'), code: role('block'),
        header: read('th', 'backgroundColor'), stripe: read('tbody tr:nth-child(2) td', 'backgroundColor'),
        table: role('table'), border: read('td', 'borderLeftColor'), line: role('separator'),
        inline: role('inline'), inlineCode: read('th code', 'backgroundColor'),
        kbd: read('kbd', 'backgroundColor'), frontmatter: read('.meo-export-frontmatter', 'backgroundColor'),
        frontmatterBorder: read('.meo-export-frontmatter', 'borderLeftColor'),
        frontmatterRowBorder: read('.meo-export-frontmatter-line', 'borderTopColor'),
        frontmatterKeyBorder: read('.meo-export-frontmatter-key-cell', 'borderRightColor'), blockBorder: role('block-border') };
    });
    assert.equal(previewSurfaces.block, previewSurfaces.code, 'Default Preview shares Live block surfaces');
    assert.equal(previewSurfaces.header, previewSurfaces.table);
    assert.equal(previewSurfaces.stripe, previewSurfaces.header, 'header and alternate rows share one final color');
    assert.equal(previewSurfaces.border, previewSurfaces.line, 'table grid uses the opaque document separator');
    assert.equal(previewSurfaces.inlineCode, previewSurfaces.inline, 'Preview header code shares the independent inline surface');
    assert.equal(previewSurfaces.frontmatter, previewSurfaces.code, 'frontmatter shares the block fill');
    assert.equal(previewSurfaces.kbd, 'rgba(0, 0, 0, 0)', 'Preview keyboard labels have no fill');
    for (const border of [previewSurfaces.frontmatterBorder, previewSurfaces.frontmatterRowBorder, previewSurfaces.frontmatterKeyBorder]) {
      assert.equal(border, previewSurfaces.blockBorder, 'frontmatter outer and inner boundaries share their separate role');
      assert.notEqual(border, previewSurfaces.line, 'strengthening frontmatter must not strengthen table grid lines');
    }
  };
  const changeHost = async (appearance: 'light' | 'dark', background: string) => {
    await page.evaluate(({ appearance, background }) => {
      document.body.className = `vscode-${appearance}`;
      document.documentElement.style.setProperty('--vscode-editor-background', background);
      document.getElementById('host-theme')!.textContent = `:root{--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px}html,body,#app{height:100%;margin:0}`;
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'vscodeCodeThemeChanged', appearance, vscodeTheme: { name: 'Native ' + background, type: appearance, colors: {}, tokenColors: [] } } }));
    }, { appearance, background });
  };
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--vscode-editor-background')), '#1b2430', 'Theme initialization must preserve the native inline background variable');
  await waitBackground('rgb(27, 36, 48)');
  const darkChrome = await readChrome();
  await checkModes('rgb(27, 36, 48)', darkChrome);
  const requestsBeforeColor = renderRequests;
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {data: {type: 'uiColorsChanged', colors: {light: {}, dark: {documentBackground: '#182C38'}}}})));
  await checkModes('rgb(24, 44, 56)', darkChrome);
  assert.equal(renderRequests, requestsBeforeColor, 'changing the document carrier updates Default Preview without rendering Markdown');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {data: {type: 'uiColorsChanged', colors: {light: {}, dark: {}}}})));
  await waitBackground('rgb(27, 36, 48)');
  await changeHost('dark', '#242138');
  await checkModes('rgb(36, 33, 56)', darkChrome);
  await changeHost('light', '#f8f1e5');
  await waitBackground('rgb(248, 241, 229)');
  const lightChrome = await readChrome();
  await checkModes('rgb(248, 241, 229)', lightChrome);
  await page.click('.more-tools-wrapper > .format-button');
  await page.click('.editor-appearance-button[data-editor-appearance="dark"]');
  await waitBackground('rgb(18, 19, 20)');
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--vscode-editor-background')), '#f8f1e5', 'Manual appearance must leave the native root color intact');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--meo-content-editor-background').trim()), '#24292e', 'Manual appearance retains its own fallback without overwriting native variables');
  await page.click('.editor-appearance-button[data-editor-appearance="auto"]');
  await waitBackground('rgb(248, 241, 229)');
  await page.click('.more-tools-wrapper > .format-button');
  await page.click('.preview-preset-dropdown');
  await page.click('.preview-preset-dropdown-panel [data-value="github-readme"]');
  await page.waitForFunction(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    return doc?.documentElement.dataset.meoPreviewPreset === 'github-readme'
      && doc.defaultView!.getComputedStyle(doc.body).backgroundColor === 'rgb(255, 255, 255)';
  });
  assert.equal(await page.$eval('body', element => getComputedStyle(element).backgroundColor), 'rgb(248, 241, 229)');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {data: {type: 'uiColorsChanged', colors: {light: {documentBackground: '#FFFAEE'}, dark: {}}}})));
  assert.equal(await page.$eval('body', element => getComputedStyle(element).backgroundColor), 'rgb(255, 250, 238)');
  assert.equal(await page.$eval('.preview-frame', element => {
    const doc = (element as HTMLIFrameElement).contentDocument!;
    return doc.defaultView!.getComputedStyle(doc.body).backgroundColor;
  }), 'rgb(255, 255, 255)', 'independent Preview presets retain their paired background');
  if (process.env.MEO_DOCUMENT_SURFACE_SCREENSHOT_DIR) {
    const directory = path.resolve(process.env.MEO_DOCUMENT_SURFACE_SCREENSHOT_DIR);
    await fs.mkdir(directory, { recursive: true });
    await page.click('.preview-preset-dropdown');
    await page.click('.preview-preset-dropdown-panel [data-value="default"]');
    await page.setViewport({ width: 1280, height: 1180 });
    let number = 1;
    for (const [scheme, color, label] of [['light', '#FFFFFF', 'light'], ['dark', '#121314', 'dark'],
      ['light', '#F8F1E5', 'warm'], ['dark', '#182C38', 'cool']] as const) {
      await changeHost(scheme, color);
      await page.evaluate(({ scheme, color }) => window.dispatchEvent(new MessageEvent('message', {data: {type: 'uiColorsChanged', colors: {light: {}, dark: {}, [scheme]: {documentBackground: color}}}})), {scheme, color});
      for (const mode of ['live', 'preview']) {
        await page.click(`button[data-mode="${mode}"]`);
        await page.waitForFunction(mode => document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === mode, {}, mode);
        await page.waitForFunction(mode => {
          const editor = document.querySelector<HTMLElement>('.editor-host');
          const preview = document.querySelector<HTMLElement>('.preview-host');
          return mode === 'live' ? editor && !editor.hidden && !editor.inert && preview?.hidden
            : editor?.hidden && preview && !preview.hidden;
        }, {}, mode);
        if (mode === 'live') await page.waitForSelector('.cm-editor.meo-mode-live', { visible: true });
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        if (mode === 'live') {
          await page.$eval('.cm-scroller', element => { element.scrollTop = 0; });
          await page.waitForSelector('.meo-mermaid-block svg');
        }
        else await page.waitForFunction(() => {
          const frame = document.querySelector<HTMLIFrameElement>('.preview-frame');
          const doc = frame?.contentDocument;
          const label = doc?.querySelector('.meo-export-mermaid svg .edgeLabel');
          const code = doc?.querySelector('pre');
          return frame && frame.getBoundingClientRect().height > 500 && doc?.querySelector('th')
            && label && code && doc.defaultView!.getComputedStyle(label).backgroundColor === doc.defaultView!.getComputedStyle(code).backgroundColor;
        });
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await page.screenshot({ path: path.join(directory, `${String(number++).padStart(3, '0')}-${label}-${mode}.png`) });
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log('Editor background theme checks passed: native inline variables, selected segments, Live/Source/Default Preview, theme transitions and manual appearance.');
} finally {
  await browser.close();
}
