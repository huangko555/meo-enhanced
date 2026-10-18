import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-live-decoration-history-entry.ts'], target: 'browser', format: 'iife',
  plugins: [{ name: 'observe-policy', setup(builder) {
    builder.onLoad({ filter: /src[\\/]foundation[\\/]largeDocument\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const boundary = 'export function assessLargeDocument(text: string): LargeDocumentAssessment {';
      assert.ok(source.includes(boundary));
      return { loader: 'ts', contents: source.replace(boundary,
        boundary + ' (window as any).__assessments = ((window as any).__assessments ?? 0) + 1;') };
    });
  } }] });
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewport({ width: 1100, height: 720 });
  await page.setContent('<style>html,body,#editor{height:100%;margin:0}</style><div id="editor"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: await build.outputs[0].text() });
  for (const mode of ['source', 'live'] as const) {
    await page.evaluate(mode => {
      const scope = window as any, api = scope.__liveHistory;
      scope.__editor = api.create({ parent: document.getElementById('editor'), text: 'Small document\n\nTAIL', initialMode: mode, onApplyChanges() {} });
      scope.__editor.focus();
    }, mode);
    assert.equal(await page.evaluate(() => (window as any).__liveHistory.sourcePreparation((window as any).__editor)), true);
    const ordinaryAssessments = await page.evaluate(() => {
      const scope = window as any;
      scope.__liveHistory.input(scope.__editor, scope.__editor.view.state.doc.length, 'ordinary typing');
      return scope.__assessments;
    });
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(await page.evaluate(() => (window as any).__assessments), ordinaryAssessments,
      'ordinary small-document input must not add a whole-document assessment');
    await page.evaluate(mode => {
      const scope = window as any, api = scope.__liveHistory, editor = scope.__editor;
      scope.__beforeGrowth = editor.getText();
      editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
      if (mode === 'live') api.beginComposition(editor);
      api.input(editor, editor.view.state.doc.length, '\n\n' + 'Growing document paragraph.\n\n'.repeat(4_100) + 'GROWTH-END');
      scope.__grownText = editor.getText();
      editor.view.dispatch({ effects: [] , scrollIntoView: true });
    }, mode);
    if (mode === 'live') {
      await new Promise(resolve => setTimeout(resolve, 450));
      assert.equal(await page.evaluate(() => (window as any).__liveHistory.largeBudget((window as any).__editor)), false,
        'policy changes must wait for composition to finish');
      await page.evaluate(() => (window as any).__liveHistory.completeComposition((window as any).__editor));
    }
    await page.waitForFunction(() => !(window as any).__liveHistory.sourcePreparation((window as any).__editor), {timeout:5000});
    const result = await page.evaluate(mode => {
      const scope = window as any, editor = scope.__editor;
      const lines = Array.from(editor.view.contentDOM.querySelectorAll('.cm-line')) as HTMLElement[];
      const tail = lines.find(line => line.textContent?.includes('GROWTH-END'));
      const bounds = editor.view.scrollDOM.getBoundingClientRect(), rect = tail?.getBoundingClientRect();
      return { text: editor.getText() === scope.__grownText,
        selection: editor.view.state.selection.main.head === editor.view.state.doc.length,
        mode: editor.view.dom.classList.contains('meo-mode-' + mode),
        visible: !!rect && rect.bottom > bounds.top && rect.top < bounds.bottom,
        budget: scope.__liveHistory.largeBudget(editor) };
    }, mode);
    assert.equal(result.text, true); assert.equal(result.selection, true); assert.equal(result.mode, true); assert.equal(result.visible, true);
    if (mode === 'live') assert.equal(result.budget, true);
    assert.equal(await page.evaluate(() => (window as any).__editor.undo()), true);
    await page.waitForFunction(() => (window as any).__editor.getText() === (window as any).__beforeGrowth);
    await page.evaluate(() => {
      const scope = window as any;
      scope.__editor.setMode('source'); scope.__editor.setMode('live');
    });
    assert.equal(await page.evaluate(() => (window as any).__liveHistory.largeBudget((window as any).__editor)), true,
      'the performance policy stays stable across shrinking and mode switches in this session');
    await page.evaluate(() => (window as any).__editor.destroy());
  }
  await page.evaluate(() => {
    const scope = window as any;
    scope.__editor = scope.__liveHistory.create({ parent: document.getElementById('editor'), text: 'plain line.\n'.repeat(512),
      initialMode: 'source', onApplyChanges() {} });
    scope.__richerText = '![](x)\n'.repeat(512);
    scope.__editor.setText(scope.__richerText);
  });
  await page.waitForFunction(() => !(window as any).__liveHistory.sourcePreparation((window as any).__editor), {timeout:5000});
  assert.equal(await page.evaluate(() => (window as any).__editor.getText() === (window as any).__richerText), true,
    'a shorter replacement with many images must activate the complexity budget without changing text');
  await page.evaluate(() => (window as any).__editor.destroy());
  assert.deepEqual(errors, []);
  console.log('Automatic large-document activation preserves modes, text, caret, reading position, composition and undo');
} catch (error) { primaryError = error; throw error; }
finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
