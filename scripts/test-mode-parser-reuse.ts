import assert from 'node:assert/strict';
import { launchTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-mode-parser-reuse-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 720 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addStyleTag({ content: ':root{--meo-token-heading-color:rgb(11,22,33);--meo-token-processingInstruction-color:rgb(44,55,66)}' });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const result = await page.evaluate(() => {
    const h = (window as any).ModeParserReuse;
    const text = '# Heading\n\n' + 'ordinary paragraph with **strong** text\n\n'.repeat(1000) + '## Final heading';
    const editor = h.createEditor({ parent: document.getElementById('app'), text, initialMode: 'source', onApplyChanges() {} });
    try {
      h.forceParsing(editor.view, text.length, 5000);
      const marker = Array.from(editor.view.dom.querySelectorAll('.cm-line span'))
        .find((element: any) => element.textContent === '#') as HTMLElement;
      const sourceMarkerColor = marker ? getComputedStyle(marker).color : null;
      const before = { text: editor.getText(), history: editor.getHistoryDepth(), selection: editor.view.state.selection.toJSON() };
      const retained = [];
      for (const mode of ['live', 'source', 'live', 'source']) {
        const tree = h.currentSyntaxTree(editor.view.state);
        editor.setMode(mode);
        retained.push(h.currentSyntaxTree(editor.view.state) === tree);
      }
      const after = { text: editor.getText(), history: editor.getHistoryDepth(), selection: editor.view.state.selection.toJSON() };
      editor.setText(text + '\n\nChanged tail');
      h.forceParsing(editor.view, editor.getText().length, 5000);
      const changedTree = h.currentSyntaxTree(editor.view.state);
      editor.setMode('live');
      return { before, after, retained, sourceMarkerColor, changedRetained: h.currentSyntaxTree(editor.view.state) === changedTree,
        changedText: editor.getText(), expectedChangedText: text + '\n\nChanged tail' };
    } finally { editor.destroy(); }
  });
  assert.deepEqual(result.retained, [true, true, true, true], 'Mode switches must retain the completed Markdown parse');
  assert.deepEqual(result.after, result.before, 'Parser reuse must preserve Document, History and Selection');
  assert.equal(result.changedRetained, true, 'An updated Document parse must also survive switching');
  assert.equal(result.changedText, result.expectedChangedText);
  assert.equal(result.sourceMarkerColor, 'rgb(11, 22, 33)', 'Source heading punctuation must retain heading coloring');
  console.log('Mode switches retain production Markdown parsing without changing Document or History');
} finally { await browser.close(); }
