import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const text = '[[Sample]] and [local](sample.md)\n\n' + 'Plain filler.\n\n'.repeat(4_100) + 'TAIL';
const build = await Bun.build({ entrypoints: ['scripts/test-link-status-work-budget-entry.ts'], target: 'browser', format: 'iife',
  plugins: [{ name: 'count-production-resource-refreshes', setup(builder) {
    builder.onLoad({ filter: /webview[\\/]src[\\/]editor\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const boundary = '    refreshDecorations() {';
      assert.ok(source.includes(boundary));
      return { loader: 'ts', contents: source.replace(boundary, boundary
        + '\n      (window as any).__resourceRefreshes = ((window as any).__resourceRefreshes ?? 0) + 1;') };
    });
  } }]
});
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.setViewport({ width: 1100, height: 720 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  let exists = true;
  let issue: string | undefined;
  let fail = false;
  await page.exposeFunction('__linkHost', (message: any) => {
    if (message.type !== 'resolveLocalLinks' && message.type !== 'resolveWikiLinks') return null;
    return { type: message.type === 'resolveLocalLinks' ? 'resolvedLocalLinks' : 'resolvedWikiLinks', requestId: message.requestId,
      result: fail ? { ok: false, error: { code: 'operation-failed', message: 'Test resolution failed' } }
        : { ok: true, value: { results: message.targets.map((target: string) => ({ target, exists,
        ...(message.type === 'resolveWikiLinks' && issue ? { issue } : {}) })) } } };
  });
  await page.addScriptTag({ content: `window.__linkResponses=0;window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){window.__linkHost(message).then(response=>{if(response){window.__linkResponses++;window.dispatchEvent(new MessageEvent('message',{data:response}));}});}});` });
  await page.addScriptTag({ content: await build.outputs[0].text() });
  await page.evaluate(text => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'init', documentId: 'file:///link-budget.md', text, version: 1, savedRevision: { version: 1, text }, diagnostics: [],
    mode: 'source', uiLanguage: 'en', sourceLineNumbers: 'on', previewAppearance: 'dark', previewFontFamily: '', previewSourceColoring: false,
    editorAppearance: 'dark', gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
    diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false,
    findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
    restoreReadingPositionOnOpen: false, vscodeTheme: null
  } })), text);
  await page.waitForFunction(() => {
    const api = (window as any).__linkStatusBudget;
    return api?.local.getLocalLinkStatus('sample.md') === true && api.wiki.getWikiLinkStatus('Sample') === true;
  });
  await page.waitForFunction(() => !document.querySelector('.meo-preload-toolbar'));
  const request = async (kind: 'local' | 'wiki', content = text) => {
    const responses = await page.evaluate(({ kind, content }) => {
      const scope = window as any;
      scope.__resourceRefreshes = 0;
      const responses = scope.__linkResponses;
      if (kind === 'local') scope.__linkStatusBudget.local.requestLocalLinkStatuses(content);
      else scope.__linkStatusBudget.wiki.requestWikiLinkStatuses(content);
      return responses;
    }, { kind, content });
    await page.waitForFunction(responses => (window as any).__linkResponses > responses, {}, responses);
    return page.evaluate(() => (window as any).__resourceRefreshes);
  };
  for (const mode of ['source', 'live'] as const) {
    await page.click(`button[data-mode="${mode}"]`);
    await page.waitForFunction(mode => document.getElementById('app')?.dataset.mode === mode
      && !!document.querySelector(`.editor-host:not([hidden]):not([inert]):not([data-preview-cover]) .meo-mode-${mode}`), {}, mode);
    assert.equal(await request('local'), 0, mode + ': unchanged local statuses must not rebuild presentation');
    assert.equal(await request('wiki'), 0, mode + ': unchanged wiki statuses must not rebuild presentation');
    exists = false;
    assert.equal(await request('local'), 1, mode + ': changed local status must refresh exactly once');
    assert.equal(await page.evaluate(() => (window as any).__linkStatusBudget.local.getLocalLinkStatus('sample.md')), false);
    assert.equal(await request('local'), 0);
    issue = mode + ' ambiguity';
    assert.equal(await request('wiki'), 1, mode + ': changed wiki issue/status must refresh exactly once');
    assert.equal(await page.evaluate(() => (window as any).__linkStatusBudget.wiki.getWikiLinkIssue('Sample')), issue);
    assert.equal(await request('wiki'), 0);
    issue += ' changed';
    assert.equal(await request('wiki'), 1, 'issue-only changes must refresh even when existence is unchanged');
    assert.equal(await page.evaluate(() => (window as any).__linkStatusBudget.wiki.getWikiLinkIssue('Sample')), issue);
    exists = true;
    assert.equal(await request('local'), 1);
    assert.equal(await request('wiki'), 1);
  }
  fail = true;
  assert.equal(await request('local'), 1);
  assert.equal(await request('local'), 0, 'repeated failures with an empty cache need no refresh');
  assert.equal(await request('wiki'), 1);
  assert.equal(await request('wiki'), 0);
  fail = false;
  assert.equal(await request('local'), 1);
  assert.equal(await request('wiki'), 1);
  const cleared = await page.evaluate(() => {
    const scope = window as any;
    scope.__resourceRefreshes = 0;
    for (let repeat = 0; repeat < 2; repeat++) {
      scope.__linkStatusBudget.local.requestLocalLinkStatuses('Plain prose');
      scope.__linkStatusBudget.wiki.requestWikiLinkStatuses('Plain prose');
    }
    return { refreshes: scope.__resourceRefreshes, local: scope.__linkStatusBudget.local.getLocalLinkStatus('sample.md'),
      wiki: scope.__linkStatusBudget.wiki.getWikiLinkStatus('Sample'), issue: scope.__linkStatusBudget.wiki.getWikiLinkIssue('Sample') ?? null };
  });
  assert.deepEqual(cleared, { refreshes: 2, local: null, wiki: null, issue: null });
  assert.deepEqual(errors, []);
  console.log('Production Source/Live link statuses: unchanged/empty results skip refresh; changes and issues refresh exactly once');
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
