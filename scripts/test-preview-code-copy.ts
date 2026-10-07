import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import exportRuntime from '../src/export/runtime';
import { convertHtmlToDocx } from '../src/export/docxRuntime.mts';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-preview-code-copy-'));
const entry = path.join(temporary, 'entry.ts');
fs.writeFileSync(entry, [
  'import ' + JSON.stringify(path.resolve('scripts/test-preview-code-update-entry.ts')) + ';',
  'import { bindTooltips } from ' + JSON.stringify(path.resolve('webview/src/adapters/tooltip.ts')) + ';',
  'bindTooltips(document.body);'
].join('\n'));
const build = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const script = await build.outputs[0]!.text();
const styles = fs.readFileSync('webview/src/styles.css', 'utf8');
const source = '  const text = "中文 <&>";\n\n\treturn text;  \n';
const mermaidSource = 'flowchart LR\nA["中文 <&>"]-->B\n';
const mathSource = '\\frac{x^2}{y} + \\text{中文}';
const markdown = [
  '# Copy fixture', 'Selection remains readable.', 'Inline $a^2$ stays inline.',
  '~~~typescript\n' + source + '~~~', '~~~\nplain\n~~~',
  '    indented\n        nested', '~~~latex\nx^2\n~~~',
  // Invalid formulas still belong to the formula path, not ordinary code.
  '~~~latex\n\\invalidcommand{\n~~~',
  '~~~mermaid\n' + mermaidSource + '~~~', '$$\n' + mathSource + '\n$$'
].join('\n\n');
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch: request => {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/katex.css') return new Response(Bun.file('node_modules/katex/dist/katex.min.css'));
    if (pathname.startsWith('/fonts/')) return new Response(Bun.file(path.join('node_modules/katex/dist/fonts', path.basename(pathname))));
    return new Response('<!doctype html><style>' + styles
    + '</style><style>html,body{height:100%;margin:0}.preview-host:not([hidden]){height:100%;display:flex;flex-direction:column}.preview-frame{width:100%;height:100%;flex:1}'
    + ':root{--meo-semantic-codeCopyBackground:transparent;--meo-semantic-codeCopyHoverBackground:rgba(127,127,127,.2)}</style><body></body>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
});
const origin = 'http://127.0.0.1:' + server.port;
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  await browser.defaultBrowserContext().overridePermissions(origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 760 });
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  await page.goto(origin);
  await page.bringToFront();
  await page.addStyleTag({ url: origin + '/katex.css' });
  await page.evaluate(href => { document.body.dataset.meoKatexSrc = href; }, origin + '/katex.css');
  await page.addScriptTag({ path: 'node_modules/mermaid/dist/mermaid.min.js' });
  await page.addScriptTag({ content: script });
  await page.evaluate(() => {
    const nativeWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async text => {
      (window as any).__copyPayload = text;
      await nativeWrite(text);
    };
  });
  // Windows exposes native clipboard line breaks as CRLF; the API payload remains exact LF source.
  const readClipboard = () => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, '\n'));
  await page.evaluate(() => {
    const controller = (window as any).__previewController;
    controller.setAppearance('light');
    controller.setVisible(true);
  });
  const render = async (text: string, language: 'en' | 'zh-CN') => {
    const value = exportRuntime.renderPreviewDocument({
      markdownText: text, sourceDocumentPath: 'C:/preview-copy.md', uiLanguage: language
    });
    await page.evaluate(({ text, value, language }) => {
      const controller = (window as any).__previewController;
      controller.setUiLanguage(language);
      void controller.requestRender(text, { preserveViewport: true });
      const message = (window as any).__previewMessages.filter((message: any) => message.type === 'requestPreviewRender').at(-1);
      controller.acceptRenderResponse({ type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value } });
    }, { text, value, language });
    await page.waitForFunction(html => {
      const doc = (window as any).__previewController.host.querySelector('iframe').contentDocument;
      if (!doc || !doc.querySelector('.meo-preview-code-actions')) return false;
      const expected = doc.createElement('main');
      expected.innerHTML = html;
      return doc.querySelector('code.hljs')?.textContent === expected.querySelector('code.hljs')?.textContent
        && doc.querySelector('p')?.textContent === expected.querySelector('p')?.textContent;
    }, {}, value.html);
  };
  await render(markdown, 'en');
  const frame = page.frames().find(frame => frame.parentFrame() === page.mainFrame())!;
  assert.deepEqual(await frame.$$eval('.meo-export-math-display', nodes => nodes.map(node =>
    node.querySelectorAll(':scope > .meo-preview-code-actions > .meo-copy-code-btn').length)), [1, 1, 1],
  'Every formula block must expose a copy control outside its fitted canvas');
  await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('iframe')!
    .contentDocument?.querySelector('.meo-export-mermaid.is-rendered svg'));
  assert.equal(await frame.$eval('.meo-export-mermaid', node => node.querySelectorAll('.meo-copy-code-btn').length), 1,
    'Mermaid rendering must retain its copy control');
  assert.equal(await frame.$$eval('.meo-preview-code-actions', nodes => nodes.length), 7);
  assert.equal(await frame.$$eval('.meo-export-math-inline .meo-preview-code-actions', nodes => nodes.length), 0,
    'Inline equations must not acquire block copy controls');
  await page.evaluate(() => {
    (window as any).__originalMathBlock = document.querySelector<HTMLIFrameElement>('iframe')!
      .contentDocument!.querySelector('.meo-export-math-display');
  });
  assert.equal(await page.$eval('iframe', node => node.getAttribute('sandbox')), 'allow-same-origin');
  const buttonSelector = '.meo-preview-code-actions > .meo-copy-code-btn';
  const copyPoint = async (index = 0) => {
    const offset = await page.$eval('iframe', node => {
      const rect = node.getBoundingClientRect();
      return { x: rect.left + node.clientLeft, y: rect.top + node.clientTop };
    });
    const point = await frame.$$eval(buttonSelector, (nodes, index) => {
      const rect = nodes[index]!.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, index);
    return { x: point.x + offset.x, y: point.y + offset.y };
  };
  const clickCopy = async (index = 0) => {
    const point = await copyPoint(index);
    await page.mouse.move(point.x, point.y);
    await page.mouse.click(point.x, point.y);
  };
  // Preview keeps scripts disabled; asynchronous frame pollers cannot run there.
  const waitForCopied = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await frame.$eval(buttonSelector, node => node.classList.contains('copied'))) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Copy did not produce successful feedback');
  };
  const geometry = await frame.$eval('.meo-export-code-block-wrap', node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  assert.equal(await frame.$eval('.meo-preview-code-actions', node => getComputedStyle(node).opacity), '0');

  for (const appearance of ['light', 'dark'] as const) {
    await page.evaluate(appearance => {
      document.documentElement.dataset.editorAppearance = appearance;
      (window as any).__previewController.setAppearance(appearance);
    }, appearance);
    for (const language of ['en', 'zh-CN'] as const) {
      await page.evaluate(language => (window as any).__previewController.setUiLanguage(language), language);
      const point = await copyPoint();
      await page.mouse.move(point.x, point.y);
      await frame.waitForFunction(() => getComputedStyle(document.querySelector('.meo-preview-code-actions')!).opacity === '1', { polling: 50 });
      let visibleHint: { label: string | null; opacity: string } | null = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        visibleHint = await frame.$eval('.meo-tooltip.is-visible', node => ({
          label: node.querySelector('.meo-tooltip-label')?.textContent ?? null,
          opacity: getComputedStyle(node).opacity
        })).catch(() => null);
        if (visibleHint?.label === (language === 'en' ? 'Copy code' : '复制代码') && visibleHint.opacity === '1') break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(visibleHint?.label, language === 'en' ? 'Copy code' : '复制代码');
      assert.equal(visibleHint?.opacity, '1');
      const hint = await frame.$eval(buttonSelector, node => ({
        label: node.getAttribute('aria-label'), tooltip: node.getAttribute('data-tooltip'),
        native: node.getAttribute('title'), cursor: getComputedStyle(node).cursor,
        color: getComputedStyle(node).color, bg: getComputedStyle(node).backgroundColor,
        gapCursor: getComputedStyle(node.parentElement!).cursor, hintOpacity: getComputedStyle(document.querySelector('.meo-tooltip')!).opacity
      }));
      assert.equal(hint.label, language === 'en' ? 'Copy code' : '复制代码');
      assert.equal(hint.tooltip, hint.label);
      assert.equal(hint.native, null);
      assert.equal(hint.cursor, 'pointer');
      assert.equal(hint.gapCursor, 'default');
      assert.equal(hint.bg, 'rgba(127, 127, 127, 0.2)');
      assert.equal(hint.color, appearance === 'light' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)');
      const buttonBounds = await frame.$eval(buttonSelector, node => {
        const button = node.getBoundingClientRect();
        const code = node.closest('.meo-export-code-block-wrap')!.querySelector('.meo-export-code-line-source')!.getBoundingClientRect();
        return { bottom: button.bottom, codeTop: code.top };
      });
      assert.ok(buttonBounds.bottom <= buttonBounds.codeTop, 'Copy control must not cover the first code line');
      fs.mkdirSync('tmp/preview-code-copy', { recursive: true });
      await page.screenshot({ path: 'tmp/preview-code-copy/' + appearance + '-' + language + '.png' });
      console.log('Visual ' + appearance + '/' + language + ': ' + JSON.stringify(hint));
    }
  }
  await frame.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('.meo-export-code-line-source')!);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  const selection = await frame.evaluate(() => getSelection()!.toString());
  const requestsBefore = await page.evaluate(() => (window as any).__previewMessages.length);
  await clickCopy();
  await waitForCopied();
  assert.equal(await page.evaluate(() => (window as any).__copyPayload), source, 'The Clipboard API receives the exact code body');
  assert.equal(await readClipboard(), source, 'Native clipboard must preserve every line and indentation');
  assert.equal(await frame.evaluate(() => getSelection()!.toString()), selection);
  assert.equal(await page.evaluate(() => (window as any).__previewMessages.length), requestsBefore, 'Copy must not request export or editing');
  await page.evaluate(() => {
    (window as any).__clipboardWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async () => { throw new Error('Denied for failure regression'); };
  });
  await clickCopy();
  assert.equal(await frame.$eval(buttonSelector, node => node.classList.contains('copied')), false, 'A failed second attempt must clear prior success');
  // A delayed older success must not overwrite the feedback of a newer failed attempt.
  await page.evaluate(() => {
    navigator.clipboard.writeText = async text => {
      await new Promise<void>(resolve => { (window as any).__releaseCopy = resolve; });
      await (window as any).__clipboardWrite(text);
      (window as any).__olderCopyFinished = true;
    };
  });
  await clickCopy();
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Newer attempt denied'); }; });
  await clickCopy();
  await page.evaluate(() => (window as any).__releaseCopy());
  await page.waitForFunction(() => (window as any).__olderCopyFinished === true);
  assert.equal(await frame.$eval(buttonSelector, node => node.classList.contains('copied')), false);
  await page.evaluate(() => { navigator.clipboard.writeText = (window as any).__clipboardWrite; });
  await frame.evaluate(() => getSelection()!.removeAllRanges());
  await page.mouse.move(0, 0);
  await frame.evaluate(() => document.body.focus());
  await page.keyboard.press('Tab');
  await frame.waitForFunction(() => getComputedStyle(document.querySelector('.meo-preview-code-actions')!).opacity === '1', { polling: 50 });
  assert.equal(await frame.$eval(buttonSelector, node => node.matches(':focus-visible')), true);
  await page.keyboard.press('Enter');
  await waitForCopied();
  assert.equal(await readClipboard(), source);
  await new Promise(resolve => setTimeout(resolve, 2100));
  assert.equal(await frame.$eval(buttonSelector, node => node.classList.contains('copied')), false);
  await page.keyboard.press('Space');
  await waitForCopied();
  assert.equal(await readClipboard(), source);

  await render(markdown.replace('Selection remains', 'Updated prose remains'), 'zh-CN');
  assert.equal(await page.evaluate(() => (window as any).__originalMathBlock ===
    document.querySelector<HTMLIFrameElement>('iframe')!.contentDocument!.querySelector('.meo-export-math-display')), true,
  'Copy controls must not invalidate unchanged formula presentation');
  await clickCopy();
  assert.equal(await readClipboard(), source);
  const updated = source.replace('const text', 'let text');
  await render(markdown.replace(source, updated), 'en');
  await clickCopy();
  await waitForCopied();
  assert.equal(await readClipboard(), updated, 'Incremental updates must copy the current source');
  await clickCopy(1);
  assert.equal(await readClipboard(), 'plain\n');
  await clickCopy(2);
  assert.equal(await readClipboard(), 'indented\n    nested\n');
  const afterGeometry = await frame.$eval('.meo-export-code-block-wrap', node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  assert.deepEqual(afterGeometry, geometry, 'Hover, focus, copying and language changes must not shift layout');

  const copyBlock = async (selector: string, expected: string) => {
    await frame.$eval(selector, node => node.scrollIntoView({ block: 'center' }));
    const index = await frame.$eval(selector, (node, buttonSelector) =>
      Array.from(document.querySelectorAll(buttonSelector)).indexOf(node.querySelector(buttonSelector)!), buttonSelector);
    const point = await copyPoint(index);
    await page.mouse.move(point.x, point.y);
    assert.equal(await frame.$eval(selector, node =>
      getComputedStyle(node.querySelector('.meo-preview-code-actions')!).opacity), '1', 'Hover must reveal the block copy control');
    const appearance = await page.evaluate(() => document.documentElement.dataset.editorAppearance);
    fs.mkdirSync('.local/probes/preview-block-copy', { recursive: true });
    await page.screenshot({ path: `.local/probes/preview-block-copy/${appearance}-${selector.includes('mermaid') ? 'mermaid' : 'math'}.png` });
    await clickCopy(index);
    await page.waitForFunction((selector) => document.querySelector<HTMLIFrameElement>('iframe')!
      .contentDocument!.querySelector(selector)?.querySelector('.meo-copy-code-btn')?.classList.contains('copied'), {}, selector);
    assert.equal(await readClipboard(), expected);
    assert.equal(await page.evaluate(() => (window as any).__copyPayload), expected);
  };
  await copyBlock('.meo-export-math-display', 'x^2');
  await copyBlock('.meo-export-math-display:has(.katex-error)', '\\invalidcommand{');
  await copyBlock('.meo-export-mermaid', mermaidSource);
  await copyBlock(`.meo-export-math-display[data-source-b64="${Buffer.from(mathSource).toString('base64')}"]`, mathSource);
  assert.equal(await frame.$$eval('.meo-latex-math-canvas .meo-preview-code-actions', nodes => nodes.length), 0,
    'Formula fitting must never scale or pan copy controls');
  const updatedMermaid = mermaidSource.replace('-->B', '-->C');
  const updatedMath = mathSource.replace('x^2', 'x^3');
  await render(markdown.replace(mermaidSource, updatedMermaid).replace(mathSource, updatedMath), 'en');
  await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('iframe')!
    .contentDocument!.querySelector('.meo-export-mermaid')?.getAttribute('data-meo-preview-mermaid-pending') !== 'true');
  await copyBlock('.meo-export-mermaid', updatedMermaid);
  await copyBlock(`.meo-export-math-display[data-source-b64="${Buffer.from(updatedMath).toString('base64')}"]`, updatedMath);
  assert.equal(await frame.$$eval('.meo-export-mermaid .meo-copy-code-btn', nodes => nodes.length), 1,
    'Content and appearance changes must not duplicate Mermaid copy controls');
  await page.evaluate(() => {
    document.documentElement.dataset.editorAppearance = 'light';
    (window as any).__previewController.setAppearance('light');
  });
  await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('iframe')!
    .contentDocument!.querySelector<HTMLElement>('.meo-export-mermaid')?.dataset.meoPreviewMermaidAppearance === 'light');
  await copyBlock('.meo-export-mermaid', updatedMermaid);
  await copyBlock(`.meo-export-math-display[data-source-b64="${Buffer.from(updatedMath).toString('base64')}"]`, updatedMath);

  await render(markdown.replace('~~~\nplain\n~~~', '~~~\n~~~'), 'en');
  await clickCopy(1);
  assert.equal(await readClipboard(), '', 'An empty code body must copy no label or fence');
  const mermaid = exportRuntime.renderPreviewDocument({ markdownText: '~~~mermaid\nflowchart LR\nA-->B\n~~~',
    sourceDocumentPath: 'C:/preview-copy.md', uiLanguage: 'en' });
  assert.doesNotMatch(mermaid.html, /meo-export-code-block-wrap/, 'Mermaid has a separate surface excluded from ordinary code controls');

  for (const target of ['html', 'pdf', 'docx'] as const) {
    const exported = await exportRuntime.renderExportHtmlDocument({
      readingSnapshot: { snapshotId: 'copy-' + target, text: '~~~typescript\n' + source + '~~~\n\n~~~mermaid\n' + mermaidSource + '~~~\n\n$$\n' + mathSource + '\n$$', appearance: 'dark',
        uiLanguage: 'zh-CN', environment: { previewFontFamily: '', previewSourceColoring: false } },
      sourceDocumentPath: 'C:/preview-copy.md', outputFilePath: path.join(temporary, 'copy.' + target), target,
      mermaidRuntimeSrc: '', baseHref: 'file:///', title: 'Copy fixture', shikiLanguageAssetsRoot: ''
    });
    assert.doesNotMatch(exported.htmlDocument, /meo-preview-code-actions|meo-copy-code-btn|meo-tooltip|复制代码|Copy code|clipboard/);
    const output = await browser.newPage();
    await output.setContent(exported.htmlDocument);
    assert.equal(await output.$$eval('[role="button"], [role="tooltip"], [data-tooltip]', nodes => nodes.length), 0);
    assert.deepEqual(await output.$$eval('.meo-export-code-line-source', nodes => nodes.map(node => node.textContent)), source.slice(0, -1).split('\n'));
    if (target === 'pdf') assert.ok((await output.pdf()).length > 1000);
    if (target === 'docx') {
      const archive = await JSZip.loadAsync(await convertHtmlToDocx(exported.htmlDocument, { lang: 'zh-CN', title: 'Copy fixture' }));
      const xml = await archive.file('word/document.xml')!.async('string');
      assert.doesNotMatch(xml, /meo-preview-code-actions|meo-copy-code-btn|meo-tooltip|复制代码|Copy code/);
      assert.match(xml, /const text/);
      assert.match(xml, /return text/);
    }
    await output.close();
    console.log('Export ' + target + ': controls absent, code preserved');
  }
  await page.evaluate(() => (window as any).__previewController.dispose());
} catch (error) {
  primaryError = error;
} finally {
  server.stop(true);
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
  fs.rmSync(temporary, { recursive: true, force: true });
}
console.log('Preview code copy production checks passed');
