import { installPackagedMermaid, isMermaidTestRequest } from './mermaid-runtime-test-helpers';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';
import { getMermaidPalette } from '../src/shared/mermaidPalette';

const build = await Bun.build({
  entrypoints: ['scripts/test-source-preview-mermaid-updates-entry.ts'],
  target: 'browser', format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const pageErrors: string[] = [];
  const externalRequests: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (isMermaidTestRequest(request.url())) return void request.continue();
    if (/^https?:/.test(request.url())) {
      externalRequests.push(request.url());
      void request.abort();
    } else void request.continue();
  });
  await page.exposeFunction('__renderSourceMermaidPreview', async (message: any) => {
    if (message.type !== 'requestPreviewRender') return null;
    return {
      type: 'previewRenderResult', requestId: message.requestId,
      result: { ok: true, value: exportRuntime.renderPreviewDocument({
        layout: message.layout, markdownText: message.text, sourceDocumentPath: 'C:/tmp/source-mermaid-updates.md',
        uiLanguage: message.uiLanguage, styleEnvironment: message.environment
      }) }
    };
  });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  const katexCss = fs.readFileSync('node_modules/katex/dist/katex.min.css', 'utf8').replace(/url\((fonts\/[^)]+)\)/g,
    (_match, file) => `url(data:font/${path.extname(file).slice(1)};base64,${fs.readFileSync(path.join('node_modules/katex/dist', file)).toString('base64')})`);
  const katexHref = `data:text/css;base64,${Buffer.from(katexCss).toString('base64')}`;
  await page.addStyleTag({ url: katexHref });
  await page.evaluate(href => { document.body.dataset.meoKatexSrc = href;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).__copiedFormula = text; } } });
  }, katexHref);
  await installPackagedMermaid(page);
  await page.addScriptTag({ content: `
    window.__invalidMermaidRenders=0;window.__heldMermaidRender=false;
    const realRender=window.mermaid.render.bind(window.mermaid);
    let releaseHeld;
    const gate=new Promise(resolve=>{releaseHeld=resolve});
    window.__releaseHeldMermaidRender=()=>releaseHeld();
    window.mermaid.render=async(id,source,container)=>{
      if(source.includes('延迟旧图')){window.__heldMermaidRender=true;await gate;}
      try{return await realRender(id,source,container);}
      catch(error){window.__invalidMermaidRenders++;throw error;}
    };
    window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){
      window.__renderSourceMermaidPreview(message).then(response=>{
        if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));
      });
    }});
  ` });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const text = [
    '# 双栏编辑回归',
    ...Array.from({ length: 12 }, (_, index) => `前置段落 ${index + 1}。`),
    '```mermaid\nflowchart TD\n  A[开始步骤] --> B{复核通过}\n  B -->|通过| C[完成步骤]\n  B -->|退回| A\n```',
    '右侧阅读锚点：编辑图表时这段正文应该停留在原来的阅读位置。',
    ...Array.from({ length: 45 }, (_, index) => `后续正文 ${index + 1}。`),
    '$$\nx_{0} = 1\n$$'
  ].join('\n\n');
  await page.evaluate(text => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'init', documentId: 'file:///source-mermaid-updates.md', text, version: 1,
    savedRevision: { version: 1, text }, diagnostics: [], mode: 'source', uiLanguage: 'en',
    uiLanguagePreference: 'auto', automaticUiLanguage: 'en', sourceLineNumbers: 'on',
    previewAppearance: 'light', previewFontFamily: '', previewSourceColoring: true,
    editorAppearance: 'light', editorFontSizeMode: 'auto', editorFontSize: 14,
    gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
    diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
    contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
    outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
    restoreReadingPositionOnOpen: false, vscodeTheme: null
  } })), text);
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>('.source-preview-button');
    return button && !button.closest('.meo-preload-toolbar') && !button.disabled
      && button.offsetParent !== null && getComputedStyle(button).visibility !== 'hidden';
  });
  await page.click('.source-preview-button');
  const waitForDiagram = (label: string) => page.waitForFunction(label => {
    const host = document.querySelector<HTMLElement>('.preview-host');
    const block = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
      ?.querySelector<HTMLElement>('.meo-export-mermaid');
    return document.querySelector('.editor-surface')?.hasAttribute('data-source-preview')
      && host && getComputedStyle(host).visibility !== 'hidden'
      && block?.querySelector('svg')?.textContent?.includes(label)
      && !block.dataset.meoPreviewMermaidPending;
  }, {}, label).catch(async error => {
    const state = await page.evaluate(() => ({
      frame: document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.body.innerHTML.slice(0, 1800),
      invalid: (window as any).__invalidMermaidRenders,
      source: (window as any).__sourceMermaidEditor().state.doc.toString()
    }));
    throw new Error(`Diagram did not update to ${label}: ${JSON.stringify({ state, pageErrors })}`, { cause: error });
  });
  await waitForDiagram('完成步骤');
  await page.evaluate(async () => { const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    await doc.fonts.ready;
    for (let frame = 0; frame < 20; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
  console.log('Initial Source split diagram rendered');
  // Reading in the right pane independently must survive a change in diagram height.
  await page.click('.source-preview-scroll-sync-button');
  assert.equal(await page.$eval('.source-preview-scroll-sync-button', element => element.getAttribute('aria-pressed')), 'false');
  const selectText = async (needle: string, last = false) => page.evaluate(({ needle, last }) => {
    const view = (window as any).__sourceMermaidEditor();
    const source = view.state.doc.toString();
    const from = last ? source.lastIndexOf(needle) : source.indexOf(needle);
    if (from < 0) throw new Error(`Missing edit target ${needle}`);
    view.dispatch({ selection: { anchor: from, head: from + needle.length }, scrollIntoView: true });
    view.focus();
  }, { needle, last });
  await selectText('开始步骤');
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const doc = frame.contentDocument!;
    const anchor = Array.from(doc.querySelectorAll('p')).find(p => p.textContent?.startsWith('右侧阅读锚点'))!;
    doc.scrollingElement!.scrollTop += anchor.getBoundingClientRect().top;
  });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const doc = frame.contentDocument!;
    const anchor = Array.from(doc.querySelectorAll('p')).find(p => p.textContent?.startsWith('右侧阅读锚点'))!;
    const samples: Array<{ y: number; hasSvg: boolean; oldResult: boolean; focused: boolean; sourceLine?: string; top: number; label: string }> = [];
    let active = true;
    const sample = () => {
      if (!active) return;
      const current = frame.contentDocument!;
      const paragraph = Array.from(current.querySelectorAll('p')).find(p => p.textContent?.startsWith('右侧阅读锚点'))!;
      const svg = current.querySelector('.meo-export-mermaid svg');
      samples.push({ y: paragraph.getBoundingClientRect().top, hasSvg: Boolean(svg),
        sourceLine: paragraph.dataset.sourceLine, top: current.scrollingElement!.scrollTop,
        label: Array.from(svg?.querySelectorAll('.nodeLabel') ?? []).map(node => node.textContent).join(','),
        oldResult: Boolean(svg?.textContent?.includes('延迟旧图')),
        focused: (window as any).__sourceMermaidEditor().hasFocus });
      requestAnimationFrame(sample);
    };
    (window as any).__sourceMermaidProbe = { samples, initialY: anchor.getBoundingClientRect().top, stop() { active = false; } };
    requestAnimationFrame(sample);
  });
  for (const label of ['编辑一次', '编辑二次', '编辑三次', '最新开始']) {
    const previous = await page.evaluate(() => (window as any).__sourceMermaidEditor().state.doc.toString().match(/A\[([^\]]+)\]/)?.[1]);
    await selectText(previous!);
    await page.keyboard.type(label);
  }
  await waitForDiagram('最新开始');
  console.log('Rapid Source edits rendered');
  await selectText('C[完成步骤]');
  await page.keyboard.type('C[');
  // Source auto-closes brackets; delete that completion to simulate an unfinished label.
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => (window as any).__invalidMermaidRenders > 0);
  console.log('Incomplete syntax rendered without clearing the diagram');
  assert.equal(await page.evaluate(() => Boolean(document.querySelector<HTMLIFrameElement>('.preview-frame')
    ?.contentDocument?.querySelector('.meo-export-mermaid svg'))), true, 'Incomplete syntax must retain the last valid diagram');
  await selectText('C[');
  await page.keyboard.type('C[完成步骤]');
  await waitForDiagram('完成步骤');
  console.log('Syntax recovery rendered');
  await selectText('完成步骤');
  await page.keyboard.type('延迟旧图');
  await page.waitForFunction(() => (window as any).__heldMermaidRender).catch(async error => {
    throw new Error(`Slow render did not start: ${await page.evaluate(() => (window as any).__sourceMermaidEditor().state.doc.toString())}`, { cause: error });
  });
  console.log('Superseded slow render started');
  await selectText('延迟旧图');
  await page.keyboard.type('最新结果');
  await selectText('```', true);
  await page.keyboard.type('  C --> D[归档记录]\n```');
  const expectedSelection = await page.evaluate(() => {
    const selection = (window as any).__sourceMermaidEditor().state.selection.main;
    return { anchor: selection.anchor, head: selection.head };
  });
  await page.evaluate(() => (window as any).__releaseHeldMermaidRender());
  await waitForDiagram('归档记录');
  assert.deepEqual(await page.evaluate(() => {
    const selection = (window as any).__sourceMermaidEditor().state.selection.main;
    return { anchor: selection.anchor, head: selection.head };
  }), expectedSelection, 'A completed preview render must preserve the Source caret');
  assert.equal(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')
    ?.contentDocument?.querySelector('.meo-export-mermaid svg')?.textContent?.includes('最新结果')), true);
  await page.evaluate(() => new Promise<void>(resolve => {
    let remaining = 12;
    const sample = () => --remaining ? requestAnimationFrame(sample) : resolve();
    requestAnimationFrame(sample);
  }));
  const probe = await page.evaluate(() => {
    const probe = (window as any).__sourceMermaidProbe;
    probe.stop();
    return { initialY: probe.initialY, samples: probe.samples,
      leakedSyntaxError: document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.body.textContent?.includes('Syntax error in text'),
      config: (window as any).mermaid.mermaidAPI.getConfig() };
  });
  assert.ok(probe.samples.length > 10);
  assert.ok(probe.samples.every((sample: any) => sample.hasSvg), 'Replacement must never blank the right-hand diagram');
  assert.ok(probe.samples.every((sample: any) => !sample.oldResult), 'A superseded slow render must never replace the latest result');
  assert.ok(probe.samples.every((sample: any) => sample.focused), 'Preview rendering must not steal Source focus');
  const drift = Math.max(...probe.samples.map((sample: any) => Math.abs(sample.y - probe.initialY)));
  assert.ok(drift <= 1, `Right-hand reading anchor moved ${drift.toFixed(1)}px during edits: ${JSON.stringify(probe.samples.filter((sample: any, index: number, samples: any[]) => index === 0 || sample.y !== samples[index - 1].y))}`);
  assert.equal(probe.leakedSyntaxError, false);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(externalRequests, [], 'Mermaid must render without external requests');
  console.log(`Source split updates retained the diagram, focus and reading anchor (${drift.toFixed(1)}px drift)`);
  assert.equal(probe.config.layout, 'elk', 'Production Mermaid must use ELK as its default layout');
  assert.equal(probe.config.look, 'classic', 'Default appearance must remain classic');
  await page.click('.source-preview-scroll-sync-button');
  assert.equal(await page.$eval('.source-preview-scroll-sync-button', element => element.getAttribute('aria-pressed')), 'true');
  await selectText('最新结果');
  await page.keyboard.type('联动模式完成');
  await waitForDiagram('联动模式完成');
  assert.equal(await page.evaluate(() => (window as any).__sourceMermaidEditor().hasFocus), true);
  for (const appearance of ['dark', 'light']) {
    await page.evaluate(appearance => {
      const select = document.querySelector<HTMLSelectElement>('.preview-appearance-select')!;
      select.value = appearance;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      (window as any).__sourceMermaidEditor().focus();
    }, appearance);
    await page.waitForFunction(appearance => {
      const block = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
        ?.querySelector<HTMLElement>('.meo-export-mermaid');
      return block?.dataset.meoPreviewMermaidAppearance === appearance
        && block.querySelector('svg')?.textContent?.includes('联动模式完成');
    }, {}, appearance);
    const expectedColor = getMermaidPalette(appearance === 'dark').nodeBackground;
    const rgb = `rgb(${[1, 3, 5].map(offset => parseInt(expectedColor.slice(offset, offset + 2), 16)).join(', ')})`;
    assert.equal(await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const shape = frame.contentDocument!.querySelector('.meo-export-mermaid g.node .label-container')!;
      return frame.contentWindow!.getComputedStyle(shape).fill;
    }), rgb, 'The actual split Preview must use the shared light/dark node colors');
  }
  for (const number of [2, 3]) {
    await selectText(`x_{0} = ${number - 1}`);
    await page.keyboard.type(`x_{0} = ${number}`);
    await page.waitForFunction(number => { const block = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
      ?.querySelector<HTMLElement>('.meo-export-math-display');
      return block?.querySelector('.katex') && atob(block.dataset.sourceB64 ?? '') === `x_{0} = ${number}`;
    }, {}, number);
    assert.equal(await page.evaluate(() => (window as any).__sourceMermaidEditor().hasFocus), true, 'Formula Preview updates retain Source focus');
    const beforeCopy = await page.evaluate(() => (window as any).__sourceMermaidEditor().state.selection.toJSON());
    const frame = page.frames().find(frame => frame.parentFrame() === page.mainFrame())!;
    await frame.hover('.meo-export-math-display');
    const appearance = await frame.$eval('.meo-export-math-display', element => ({
      background: getComputedStyle(element).backgroundColor,
      opacity: getComputedStyle(element.querySelector('.meo-copy-code-btn')!).opacity,
      controls: element.querySelectorAll('.meo-visual-controls').length
    }));
    assert.deepEqual(appearance, { background: 'rgba(0, 0, 0, 0)', opacity: '1', controls: 0 });
    await frame.click('.meo-export-math-display .meo-copy-code-btn');
    assert.equal(await page.evaluate(() => (window as any).__copiedFormula), `x_{0} = ${number}`);
    assert.deepEqual(await page.evaluate(() => (window as any).__sourceMermaidEditor().state.selection.toJSON()), beforeCopy);
  }
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(externalRequests, []);
  console.log('Source split Mermaid and formula update/copy regression passed');
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
