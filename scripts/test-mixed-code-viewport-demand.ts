import assert from 'node:assert/strict';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-live-decoration-history-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 640 });
  await page.setContent('<style>html,body,#editor{height:100%;margin:0;color:#ddd}</style><div id="editor"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const preparation = await page.evaluate(async () => {
    const api = (window as any).__liveHistory;
    const text = '# Root\n\n```javascript\nconst nearValue = "near";\n```\n\n'
      + 'Paragraph with ordinary source words.\n\n'.repeat(10_000)
      + '```javascript\nconst distantValue = "distant";\n```\n\nFinal paragraph.\n';
    const editor = (window as any).demandEditor = api.create({ parent: document.getElementById('editor'), text, initialMode: 'source' });
    (window as any).demandOriginal = text;
    const ready = await editor.prepareLiveSyntax(() => true);
    const syntax = api.syntaxInfo(editor);
    const keyword = [...document.querySelectorAll('.cm-line span')].find(node => node.textContent === 'const');
    (window as any).demandKeywordColor = keyword ? getComputedStyle(keyword).color : null;
    await editor.setMode('live');
    await editor.setMode('source');
    const line = editor.view.state.doc.lineAt(text.indexOf('const distantValue')).number;
    editor.scrollToLine(line, 'center');
    return { ready, syntax, keywordColor: (window as any).demandKeywordColor };
  });
  assert.ok(preparation.ready);
  assert.equal(preparation.syntax.published, preparation.syntax.length, 'all outer Markdown is available before showing Live');
  assert.equal(preparation.syntax.available, false, 'the distant embedded parser is intentionally still pending');
  assert.ok(preparation.keywordColor, 'visible near code has a syntax palette');
  await page.waitForFunction(() => {
    const line = [...document.querySelectorAll('.cm-line')].find(node => node.textContent?.includes('const distantValue'));
    const keyword = line && [...line.querySelectorAll('span')].find(node => node.textContent === 'const');
    return keyword && getComputedStyle(keyword).color === (window as any).demandKeywordColor;
  });
  assert.ok(await page.evaluate(() => (window as any).demandEditor.getText() === (window as any).demandOriginal),
    'mode changes and demand parsing cannot change source text');
  await page.evaluate(() => (window as any).demandEditor.destroy());
  console.log('Mixed code demand: complete Markdown before Live, skipped distant grammar, exact palette on scroll and unchanged source passed');
} finally { await closeTestBrowser(browser); }
