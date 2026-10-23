import assert from 'node:assert/strict';
import fs from 'node:fs';
import exportRuntime from '../src/export/runtime';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const builds = await Promise.all(['scripts/test-mermaid-editing-entry.ts', 'scripts/test-preview-code-update-entry.ts', 'scripts/test-tooltip-display-latency-entry.ts']
  .map(entry => Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife' })));
for (const build of builds) assert.ok(build.success, build.logs.map(String).join('\n'));
const styles = fs.readFileSync('webview/src/styles.css', 'utf8');
const server = Bun.serve({ hostname: '127.0.0.1', port: 40000 + process.pid % 20000, fetch: () => new Response(
  '<!doctype html><style>' + styles + '</style><style>html,body{height:100%;margin:0}#app{height:100%}.preview-host:not([hidden]){height:calc(100% - 60px);display:flex;flex-direction:column}.preview-frame{width:100%;flex:1}#outside{height:50px}</style><button id="outside">Outside</button><div id="app"></div>',
  { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) });
const browser = await launchTestBrowser();
const failures: string[] = [];
let primary: unknown;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 850 });
  const settle = () => page.evaluate(async () => {
    for (let frame = 0; frame < 8; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
  const check = async (name: string, action: () => Promise<void>) => {
    try { await action(); console.log('PASS ' + name); }
    catch (error) { failures.push(name + ': ' + String(error)); console.error('FAIL ' + failures.at(-1)); }
  };
  const diagram = '```mermaid\nflowchart LR\nA --> B\n```';
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.addStyleTag({ path: 'webview/dist/katex/katex-embedded.css' });
  await page.addScriptTag({ path: 'node_modules/mermaid/dist/mermaid.min.js' });
  await page.addScriptTag({ content: await builds[0]!.outputs[0]!.text() });
  const live = async (text: string) => {
    await page.mouse.move(5, 10);
    await page.evaluate(text => {
      const scope = window as any;
      scope.editor?.destroy(); document.querySelector('#app')!.replaceChildren();
      scope.editor = scope.MermaidEditingHarness.createEditor({ parent: document.querySelector('#app'), text,
        initialMode: 'live', onApplyChanges() {} });
    }, text);
    await settle();
  };
  await live('Before\n\n$$\nx^2\n$$\n\nAfter');
  await check('Live valid formula enables image copy without pointer interaction', async () => {
    assert.equal(await page.$eval('.meo-copy-image-btn', node => node.getAttribute('aria-disabled')), 'false');
  });
  await page.click('.meo-md-math-fenced-display .katex'); await page.mouse.move(5, 10); await settle();
  await page.evaluate(() => {
    const view = (window as any).editor.view, line = view.state.doc.line(4);
    view.dispatch({ changes: { from: line.from, to: line.to, insert: '\\frac{' }, selection: { anchor: line.from + 6 } });
  });
  await settle();
  await check('Incomplete formula disables image copy without pointer interaction', async () => {
    assert.equal(await page.$eval('.meo-copy-image-btn', node => node.getAttribute('aria-disabled')), 'true');
  });
  await page.evaluate(() => {
    const view = (window as any).editor.view, line = view.state.doc.line(4);
    view.dispatch({ changes: { from: line.from, to: line.to, insert: 'x^3' }, selection: { anchor: line.from + 3 } });
  });
  await settle();
  await check('Recovered formula re-enables image copy without pointer interaction', async () => {
    assert.equal(await page.$eval('.meo-copy-image-btn', node => node.getAttribute('aria-disabled')), 'false');
  });
  await live('Before\n\n' + diagram + '\n\nAfter');
  await page.waitForFunction(() => document.querySelector('.meo-mermaid-block svg') && !document.querySelector('[data-meo-mermaid-rendering="true"]'));
  await check('Live valid Mermaid enables image copy without pointer interaction', async () => {
    assert.equal(await page.$eval('.meo-copy-image-btn', node => node.getAttribute('aria-disabled')), 'false');
  });
  await page.hover('.meo-mermaid-block'); await settle();
  await page.focus('.meo-mermaid-fullscreen-btn');
  await page.click('.meo-mermaid-fullscreen-btn'); await settle();
  await check('Live pointer fullscreen entry avoids a close-button outline', async () => {
    assert.equal(await page.$$eval('.meo-mermaid-fullscreen button:focus-visible', nodes => nodes.length), 0);
  });
  await check('Fullscreen Tab and Shift+Tab stay within the viewer', async () => {
    await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
    assert.equal(await page.$eval('.meo-mermaid-exit-btn', node => node === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.$eval('.meo-mermaid-fullscreen-controls button', node => node === document.activeElement), true);
  });
  await page.click('.meo-mermaid-exit-btn'); await page.mouse.move(5, 10); await settle();
  await check('Live pointer fullscreen exit restores focus without keeping controls visible', async () => {
    const state = await page.$eval('.meo-mermaid-fullscreen-btn', node => ({ focused: document.activeElement === node,
      outline: getComputedStyle(node).outlineStyle, opacity: getComputedStyle(node.closest('.meo-mermaid-preview-controls')!).opacity }));
    assert.deepEqual(state, { focused: true, outline: 'none', opacity: '0' });
  });
  await page.keyboard.press('Enter'); await page.waitForSelector('.meo-mermaid-fullscreen'); await settle();
  await page.keyboard.press('Escape'); await settle();
  await check('Live keyboard fullscreen return retains visible keyboard focus', async () => {
    const state = await page.$eval('.meo-mermaid-fullscreen-btn', node => ({ active: node === document.activeElement,
      visible: node.matches(':focus-visible'), shadow: getComputedStyle(node).boxShadow }));
    assert.ok(state.active && state.visible && state.shadow !== 'none', JSON.stringify(state));
  });
  await page.keyboard.press('Enter'); await page.waitForSelector('.meo-mermaid-fullscreen');
  await page.click('.meo-mermaid-fullscreen-controls button');
  await check('Using the mouse after keyboard fullscreen entry clears the earlier button ring', async () => {
    assert.equal(await page.$eval('.meo-mermaid-exit-btn', node => getComputedStyle(node, '::before').outlineStyle), 'none');
  });
  await page.click('.meo-mermaid-exit-btn'); await page.mouse.move(5, 10); await settle();
  await check('Mouse exit after keyboard entry restores focus without a ring', async () => {
    assert.equal(await page.$eval('.meo-mermaid-fullscreen-btn', node => getComputedStyle(node).boxShadow), 'none');
  });
  await page.evaluate(() => {
    const view = (window as any).editor.view, line = view.state.doc.line(5);
    view.dispatch({ changes: { from: line.from, to: line.to, insert: 'A[unfinished' } });
  });
  await page.waitForSelector('.meo-mermaid-error-badge');
  await check('Invalid Mermaid disables retained diagram copying without pointer interaction', async () => {
    assert.equal(await page.$eval('.meo-copy-image-btn', node => node.getAttribute('aria-disabled')), 'true');
  });
  await page.evaluate(() => (window as any).editor.destroy());
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.$eval('#app', node => node.remove());
  await page.addScriptTag({ path: 'node_modules/mermaid/dist/mermaid.min.js' });
  await page.addScriptTag({ content: await builds[1]!.outputs[0]!.text() });
  await page.addScriptTag({ content: await builds[2]!.outputs[0]!.text() });
  await page.evaluate(() => { (window as any).tooltipBinding = (window as any).TooltipLatencyHarness.bindTooltips(document.body); });
  const markdown = '> Diagram\n>\n' + diagram.split('\n').map(line => '> ' + line).join('\n') + '\n>\n'
    + '> > Nested\n> >\n' + diagram.split('\n').map(line => '> > ' + line).join('\n')
    + '\n\n$$\nx^2\n$$\n\n```ts\nconst x = 1;\n```\n\nAfter';
  const value = exportRuntime.renderPreviewDocument({ markdownText: markdown, sourceDocumentPath: 'C:/actions.md', uiLanguage: 'en' });
  await page.evaluate(({ markdown, value }) => {
    const scope = window as any, controller = scope.__previewController;
    controller.setVisible(true); void controller.requestRender(markdown);
    const message = scope.__previewMessages.filter((message: any) => message.type === 'requestPreviewRender').at(-1);
    controller.acceptRenderResponse({ type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value } });
  }, { markdown, value });
  const frame = () => page.frames().find(frame => frame.parentFrame() === page.mainFrame())!;
  await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('iframe')?.contentDocument
    ?.querySelectorAll('.meo-preview-fullscreen-btn[aria-disabled="false"]').length === 2);
  const click = async (selector: string) => {
    const point = await page.evaluate(selector => {
      const iframe = document.querySelector<HTMLIFrameElement>('iframe')!;
      const node = iframe.contentDocument!.querySelector(selector)!;
      node.scrollIntoView({ block: 'center' });
      const rect = node.getBoundingClientRect(), bounds = iframe.getBoundingClientRect();
      return { x: bounds.x + rect.x + rect.width / 2, y: bounds.y + rect.y + rect.height / 2 };
    }, selector);
    await page.mouse.move(point.x, point.y); await page.mouse.click(point.x, point.y); await settle();
  };
  await click('.meo-preview-fullscreen-btn');
  await check('Pointer fullscreen entry has no focused close-button outline', async () => {
    assert.equal(await page.$$eval('.meo-mermaid-fullscreen button:focus-visible', nodes => nodes.length), 0);
  });
  await page.click('.meo-mermaid-exit-btn');
  await page.mouse.move(5, 10); await settle();
  await check('Pointer fullscreen exit restores focus without a ring', async () => {
    const focus = await frame().evaluate(() => ({ target: document.activeElement?.className,
      outline: document.activeElement && getComputedStyle(document.activeElement).outlineStyle }));
    assert.equal(focus.target, 'meo-preview-fullscreen-btn'); assert.equal(focus.outline, 'none');
  });
  await check('Preview controls disappear after pointer fullscreen exit', async () => {
    const states = await frame().$$eval('.meo-preview-code-actions', nodes => nodes.map(node => getComputedStyle(node).opacity));
    assert.ok(states.every(state => state === '0'), JSON.stringify(states));
  });
  await check('Pointer fullscreen return does not leave a floating focus tooltip', async () => {
    assert.equal(await frame().$$eval('.meo-tooltip.is-visible, .meo-tooltip.is-pending', nodes => nodes.length), 0);
  });
  await check('Preview keyboard focus keeps actions visible', async () => {
    await frame().focus('.meo-preview-fullscreen-btn'); await page.keyboard.press('Tab'); await settle();
    assert.equal(await frame().$eval('.meo-preview-code-actions', node => getComputedStyle(node).opacity), '1');
    assert.equal(await frame().$$eval('.meo-preview-code-actions :focus-visible', nodes => nodes.length), 1);
  });
  await check('Preview keyboard fullscreen return retains its focus ring', async () => {
    await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
    await page.keyboard.press('Enter'); await settle(); await page.keyboard.press('Escape'); await settle();
    assert.equal(await frame().$eval('.meo-preview-fullscreen-btn', node => node.matches(':focus-visible') && getComputedStyle(node).outlineStyle !== 'none'), true);
  });
  await check('Pointer source copy releases an earlier keyboard action highlight', async () => {
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } }));
    await click('.meo-copy-code-btn'); await page.mouse.move(5, 10); await settle();
    assert.equal(await frame().$eval('.meo-preview-code-actions', node => getComputedStyle(node).opacity), '0');
  });
  for (const group of ['.meo-export-math-display', '.meo-export-code-block-wrap']) {
    await check(group + ' source-copy focus does not pin its actions after pointer use', async () => {
      await frame().focus(group + ' .meo-copy-code-btn');
      await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
      await page.keyboard.press('Tab');
      await click(group + ' .meo-copy-code-btn'); await page.mouse.move(5, 10); await settle();
      assert.equal(await frame().$eval(group + ' .meo-preview-code-actions', node => getComputedStyle(node).opacity), '0');
    });
  }
  for (const manual of [false, true]) {
    await check((manual ? 'Direct' : 'Delegated') + ' tooltip ignores pointer-restored logical focus', async () => {
      await page.keyboard.press('Tab');
      await page.evaluate(manual => {
        const scope = window as any, button = document.createElement('button');
        button.id = 'pointer-focus-probe'; button.dataset.tooltip = 'Pointer focus'; button.textContent = 'Action';
        document.body.append(button);
        if (manual) scope.directHint = scope.TooltipLatencyHarness.createTooltip(button, { content: { text: 'Pointer focus' } });
        scope.TooltipLatencyHarness.focusRenderedBlockAction(button, true);
      }, manual);
      await settle();
      assert.equal(await page.$eval('#pointer-focus-probe', node => {
        const tooltip = document.getElementById(node.getAttribute('aria-describedby') ?? '');
        return !!tooltip?.matches('.is-pending, .is-visible');
      }), false);
    });
    await page.evaluate(() => { (window as any).directHint?.dispose(); document.querySelector('#pointer-focus-probe')?.remove(); });
  }
  await page.evaluate(() => { (window as any).tooltipBinding.dispose(); (window as any).__previewController.dispose(); });
  assert.deepEqual(failures, []);
} catch (error) { primary = error; }
finally {
  server.stop(true);
  if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary);
}
