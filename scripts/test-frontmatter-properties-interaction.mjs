import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import puppeteer from 'puppeteer-core';

const repoRoot = path.resolve(import.meta.dirname, '..');
const editorBundle = fs.readdirSync(path.join(repoRoot, 'webview', 'dist'))
  .find((name) => /^editor-.*\.js$/.test(name));
if (!editorBundle) throw new Error('Built editor bundle was not found.');

const browserCandidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft/Edge/Application/msedge.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe'
];
const executablePath = browserCandidates.find((candidate) => fs.existsSync(candidate));
if (!executablePath) throw new Error('No supported browser was found.');

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.wasm', 'application/wasm']
]);
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  if (pathname === '/') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><head><link rel="stylesheet" href="/webview/src/styles.css"><style>
      html,body,#app{height:100%;margin:0} #app{width:780px}
      :root{--meo-background:#20252b;--meo-foreground:#e6edf3;--meo-semantic-markdownSyntax:#7d8998;--meo-semantic-mutedForeground:#7d8998;--meo-semantic-tableBorder:#3e444d;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:28px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px}
    </style></head><body><div id="app"></div><script type="module">
      const { createEditor } = await import('/webview/dist/${editorBundle}');
      window.createEditor = createEditor;
    </script></body></html>`);
    return;
  }
  const relativePath = pathname.replace(/^\/+/, '');
  const filePath = path.resolve(repoRoot, relativePath);
  if (!filePath.startsWith(`${repoRoot}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.statusCode = 404;
    response.end('Not found');
    return;
  }
  response.setHeader('Content-Type', contentTypes.get(path.extname(filePath)) ?? 'application/octet-stream');
  fs.createReadStream(filePath).pipe(response);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Test server did not start.');

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--edge-skip-compat-layer-relaunch']
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 900, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => typeof window.createEditor === 'function');
  const failures = await page.evaluate(async () => {
    const text = [
      '---',
      'title: Frontmatter Properties 渲染测试',
      'aliases: [Properties Test, YAML Test]',
      'tags: [Markdown, Editor, Frontmatter, 中文标签]',
      'date: 2026-07-24',
      'draft: false',
      'rating: 4.5',
      'homepage: https://example.com/docs, jj',
      '"a:b": 带冒号的引号键',
      'metadata:',
      '  author: Example Author',
      '  category: 测试文档',
      '  nested:',
      '    enabled: true',
      '    level: 2',
      'summary: >',
      '  这是一段折叠块标量，用于测试 Preview 中复杂 YAML 的原文保留。',
      '  第二行仍然属于 summary 字段。',
      'notes: |',
      '  Keep: this colon as literal block content.',
      '  保留缩进、冒号：以及普通文本。',
      'links:',
      '  - https://example.com/first',
      '  - label: Documentation',
      '    url: https://example.com/second',
      'emptyValue:',
      'nullValue: null',
      '---',
      'Body'
    ].join('\n');
    const diagnosticFrom = text.indexOf('Frontmatter');
    const editor = window.createEditor({
      parent: document.getElementById('app'),
      text,
      initialMode: 'live',
      initialDiagnostics: [{
        from: diagnosticFrom,
        to: diagnosticFrom + 'Frontmatter'.length,
        severity: 1,
        message: 'Unknown word',
        source: 'test'
      }],
      onApplyChanges() {}
    });
    const wait = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    editor.view.dispatch({ selection: { anchor: text.length } });
    editor.view.requestMeasure();
    await wait();

    const sourceLines = text.split('\n');
    const lineElement = (lineNumber) => document.querySelectorAll('.cm-content > .cm-line')[lineNumber - 1] ?? null;
    const visibleLeft = (element) => {
      if (!element) return null;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const index = node.data.search(/\S/);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        return range.getBoundingClientRect().left;
      }
      return null;
    };
    const snapshot = (lineNumber) => {
      const line = lineElement(lineNumber);
      return {
        height: line?.getBoundingClientRect().height ?? null,
        keyLeft: visibleLeft(line?.querySelector('.meo-md-frontmatter-key')),
        valueLeft: line?.querySelector('.meo-md-frontmatter-value')?.getClientRects()[0]?.left ?? null,
        text: line?.textContent ?? ''
      };
    };
    const checkedLines = sourceLines
      .map((source, index) => ({ source, lineNumber: index + 1 }))
      .filter(({ source, lineNumber }) => lineNumber > 1 && lineNumber < sourceLines.length - 1 && source.includes(':'));
    const inactive = new Map(checkedLines.map(({ lineNumber }) => [lineNumber, snapshot(lineNumber)]));
    const failures = [];
    const visualLineHeight = Number.parseFloat(getComputedStyle(lineElement(2)).lineHeight);
    const titleSnapshot = inactive.get(2);
    if (titleSnapshot?.height === null || titleSnapshot.height > visualLineHeight + 1) {
      failures.push({ source: sourceLines[1], lineNumber: 2, symptom: 'diagnostic-split-title', visualLineHeight, titleSnapshot });
    }
    const homepageLine = lineElement(8);
    const homepageLink = homepageLine?.querySelector('.meo-md-link');
    const homepageIcon = homepageLine?.querySelector('.meo-md-link-open-btn');
    if (homepageLink instanceof HTMLElement && homepageIcon instanceof HTMLElement) {
      const range = document.createRange();
      range.selectNodeContents(homepageLink);
      const textRects = Array.from(range.getClientRects());
      const lastTextRect = textRects.at(-1);
      const iconRect = homepageIcon.getBoundingClientRect();
      const verticalDelta = lastTextRect
        ? (iconRect.top + iconRect.bottom - lastTextRect.top - lastTextRect.bottom) / 2
        : null;
      const horizontalGap = lastTextRect ? iconRect.left - lastTextRect.right : null;
      if (
        verticalDelta === null
        || horizontalGap === null
        || Math.abs(verticalDelta) > 2
        || horizontalGap < 2
        || horizontalGap > 10
      ) {
        failures.push({
          source: sourceLines[7],
          lineNumber: 8,
          symptom: 'link-icon-alignment',
          verticalDelta,
          horizontalGap
        });
      }
    } else {
      failures.push({ source: sourceLines[7], lineNumber: 8, symptom: 'link-icon-missing' });
    }
    const aliasesPills = lineElement(3)?.querySelector('.meo-md-frontmatter-array-pills');
    if (aliasesPills instanceof HTMLElement) {
      aliasesPills.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      await wait();
      const aliasesLine = lineElement(3);
      if (aliasesLine?.querySelector('.meo-md-frontmatter-array-pills') || !aliasesLine?.textContent?.includes('[Properties Test, YAML Test]')) {
        failures.push({ source: sourceLines[2], lineNumber: 3, symptom: 'array-pill-did-not-expand' });
      }
    } else {
      failures.push({ source: sourceLines[2], lineNumber: 3, symptom: 'array-pill-missing' });
    }
    for (const item of checkedLines) {
      const docLine = editor.view.state.doc.line(item.lineNumber);
      const colonOffset = Math.max(0, item.source.indexOf(':') + 1);
      const positions = [
        ['start', docLine.from],
        ['after-key', Math.min(docLine.to, docLine.from + colonOffset)],
        ['end', docLine.to]
      ];
      for (const [position, anchor] of positions) {
        editor.view.dispatch({ selection: { anchor } });
        editor.view.requestMeasure();
        await wait();
        const before = inactive.get(item.lineNumber);
        const after = snapshot(item.lineNumber);
        const heightDelta = before.height === null || after.height === null ? null : after.height - before.height;
        const keyDelta = before.keyLeft === null || after.keyLeft === null ? null : after.keyLeft - before.keyLeft;
        const valueDelta = before.valueLeft === null || after.valueLeft === null ? null : after.valueLeft - before.valueLeft;
        if (heightDelta === null || Math.abs(heightDelta) > 1 || (keyDelta !== null && Math.abs(keyDelta) > 1) || (valueDelta !== null && Math.abs(valueDelta) > 1)) {
          failures.push({ ...item, position, before, after, heightDelta, keyDelta, valueDelta });
        }
      }
    }
    editor.destroy();
    return failures;
  });
  if (failures.length > 0) {
    throw new Error(`Frontmatter rows changed on activation:\n${JSON.stringify(failures, null, 2)}`);
  }
  console.log('Frontmatter Properties activation layout is stable.');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
