import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { launchTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['webview/src/index.ts'], target: 'browser', format: 'iife', plugins: [{
  name: 'observe-real-document-snapshots', setup(builder) {
    builder.onLoad({ filter: /documentSnapshot\.ts$/ }, async args => {
      if (!args.path.includes('webview')) return undefined;
      const contents = await fs.readFile(args.path, 'utf8');
      const marker = '  return snapshot;';
      assert.equal(contents.split(marker).length, 2);
      return { contents: contents.replace(marker,
        '  ((globalThis as any).__sharingSnapshots ??= []).push(snapshot); return snapshot;'), loader: 'ts' };
    });
  }
}] });
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: `window.__sharingMessages=[];window.acquireVsCodeApi=()=>({getState(){return{}},setState(){},postMessage(message){window.__sharingMessages.push(message);if(message.type==='applyChanges')queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'applied',version:message.baseVersion+1}})));}});` });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const text = '# Sharing\n\n' + 'Ordinary immutable document text.\n'.repeat(24_000);
  await page.evaluate(text => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'init', documentId: 'file:///sharing.md', text, version: 1, savedRevision: { version: 1, text },
    diagnostics: [], mode: 'source', uiLanguage: 'en', sourceLineNumbers: 'on',
    previewAppearance: 'dark', previewFontFamily: '', previewSourceColoring: false, previewShowComments: false,
    editorAppearance: 'dark', gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
    diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
    contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
    outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, vscodeTheme: null
  } })), text);
  await page.waitForSelector('.editor-host > .cm-editor .cm-content');
  const sharing = await page.evaluate(() => {
    const scope = window as any, view = document.querySelector<any>('.editor-host > .cm-editor .cm-content').cmTile.root.view;
    const candidates = (scope.__sharingSnapshots ?? []).filter((snapshot: any) => snapshot.length === view.state.doc.length);
    scope.__sharingView = view;
    return { shared: candidates.some((snapshot: any) => snapshot.value === view.state.doc),
      uniqueTrees: new Set(candidates.map((snapshot: any) => snapshot.value)).size,
      previews: scope.__sharingMessages.filter((message: any) => message.type === 'requestPreviewRender').length };
  });
  assert.equal(sharing.shared, true, 'initial Editor and Document Session must own the same persistent Text tree');
  assert.equal(sharing.uniqueTrees, 1, 'identical current and saved Init text must share one tree');
  assert.equal(sharing.previews, 0, 'Source startup must not prepare hidden Preview');
  await page.evaluate(() => (window as any).__sharingView.focus());
  await page.keyboard.type('Q');
  await page.waitForFunction(() => (window as any).__sharingMessages.some((message: any) => message.type === 'applyChanges'));
  const changes = await page.evaluate(() => (window as any).__sharingMessages.filter((message: any) => message.type === 'applyChanges'));
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].changes, [{ from: '# Sharing'.length, to: '# Sharing'.length, insert: 'Q' }]);
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await page.waitForFunction(text => (window as any).__sharingView.state.doc.toString() === text, {}, text);
  console.log('production initial document identity, first edit, undo and hidden Preview budget passed');
} finally { await browser.close(); }
