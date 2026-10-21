import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const root = path.resolve(import.meta.dir, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-native-fraction-'));
const baseline = process.env.MEO_VIEWPORT_BASELINE;
const controlled = new Set(['webview/src/helpers/viewportController.ts', 'webview/src/editor/nativeInputViewport.ts']);
const build = await Bun.build({
  entrypoints: [path.join(root, 'scripts/test-native-input-fractional-viewport-entry.ts')],
  target: 'browser', format: 'iife', outdir: temporary, naming: 'bundle.js',
  plugins: baseline ? [{ name: 'viewport-negative-control', setup(build) {
    build.onLoad({ filter: /[\\/](?:viewportController|nativeInputViewport)\.ts$/ }, ({ path: source }) => {
      const relative = path.relative(root, source).replaceAll('\\', '/');
      if (!controlled.has(relative)) return;
      return { contents: execFileSync('git', ['show', `${baseline}:${relative}`], { encoding: 'utf8' }),
        loader: 'ts', resolveDir: path.dirname(source) };
    });
  } }] : []
});
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primary: unknown;
try {
  for (const [dpr, zoom] of [[1, 1], [1.25, 1], [1, 1.25]]) {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 700, height: 500, deviceScaleFactor: dpr });
      await page.setContent('<!doctype html><div class="editor-host"><div class="cm-editor"><div class="cm-scroller"><div class="cm-content"><div id="prefix"></div><div data-meo-rendered-block-start-line="1"><textarea>2401</textarea></div><div id="tail"></div></div></div></div></div>');
      await page.addStyleTag({ path: path.join(root, 'webview/src/styles.css') });
      await page.addStyleTag({ content: 'html,body{margin:0;height:100%}.editor-host{height:450px;width:650px;display:block}.cm-editor{height:100%;display:block}.cm-scroller{height:100%;display:block;overflow:auto}.cm-content{padding:0}#prefix{height:5000.125px}#tail{height:2000px}textarea{font:16px monospace;height:40px}' });
      await page.$eval('.editor-host', (element, zoom) => { (element as HTMLElement).style.zoom = String(zoom); }, zoom);
      await page.addScriptTag({ path: path.join(temporary, 'bundle.js') });
      const result = await page.evaluate(async () => {
        const { ViewportController, Text } = (window as any).FractionalViewportHarness;
        const dom = document.querySelector<HTMLElement>('.cm-editor')!, scrollDOM = dom.querySelector<HTMLElement>('.cm-scroller')!;
        const contentDOM = dom.querySelector<HTMLElement>('.cm-content')!, input = dom.querySelector('textarea')!;
        const prefix = document.getElementById('prefix')!;
        const controller = new ViewportController({ dom, scrollDOM, contentDOM, state: { doc: Text.of(['line']) } }, { getMode: () => 'source' });
        try {
          scrollDOM.scrollTop = 4880; input.focus({ preventScroll: true });
          input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', bubbles: true }));
          const top = input.getBoundingClientRect().top, values: number[] = [];
          let height = prefix.getBoundingClientRect().height;
          for (const delta of [0.1875, -0.34375, 0.625, -0.8125]) {
            height += delta; prefix.style.height = `${height}px`;
            controller.reconcileAfterEditorUpdate();
            await new Promise(resolve => requestAnimationFrame(resolve));
            values.push(input.getBoundingClientRect().top);
          }
          const offset = parseFloat(scrollDOM.style.getPropertyValue('--meo-native-input-scroll-offset')) || 0;
          scrollDOM.dispatchEvent(new WheelEvent('wheel', { deltaY: 300, bubbles: true }));
          height += 4; prefix.style.height = `${height}px`; controller.reconcileAfterEditorUpdate();
          return { top, values, offset, afterRelease: input.getBoundingClientRect().top, focused: document.activeElement === input, value: input.value };
        } finally { controller.destroy(); }
      });
      for (const top of result.values) assert.ok(Math.abs(top - result.top) <= zoom! / 64 + 0.001,
        `DPR ${dpr}, zoom ${zoom}: native scroll quantization moved unchanged input: ${JSON.stringify(result)}`);
      assert.ok(result.offset >= 0 && result.offset < 1.001, 'keep a bounded native scroll remainder');
      assert.ok(result.afterRelease - result.values.at(-1)! > 3, 'user scrolling must release the held position');
      assert.ok(result.focused); assert.equal(result.value, '2401');
    } finally { await page.close(); }
  }
  console.log('Native input fractional layout, physical-pixel bounds and scroll release passed at 100% and 125%');
} catch (error) { primary = error; throw error; }
finally { if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary); }
