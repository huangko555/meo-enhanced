import assert from 'node:assert/strict';
import fs from 'node:fs';
import sharp from 'sharp';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';

const bundle = await Bun.build({ entrypoints: ['scripts/test-mermaid-editing-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(bundle.success, bundle.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let failure: unknown;
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 1200, height: 1100 });
  await page.setContent('<!doctype html><meta charset="utf-8"><style>html,body,#app{height:100%;margin:0}</style><div id="app" class="editor-host"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: fs.readFileSync('webview/dist/mermaid.min.js', 'utf8') });
  await page.addScriptTag({ content: await bundle.outputs[0]!.text() });
  const frames = (count = 16) => page.evaluate(async count => {
    for (let i = 0; i < count; i++) await new Promise(resolve => requestAnimationFrame(resolve));
  }, count);
  const fence = '`'.repeat(3);
  const text = ['Before', '', '$$', 'x+1', '$$', '', '<div><p>Unchanged HTML</p></div>', '',
    fence + 'js', 'const stableBefore = "unchanged code";', fence, '',
    fence + 'mermaid', 'flowchart LR', 'A[Unchanged] --> B[Stable]', fence, '',
    fence + 'js', ...Array.from({ length: 19 }, (_, i) => `const target${i + 1} = ${i + 1};`), fence, '',
    '$$', 'y+2', '$$', '', '<div><p>Unaffected below</p></div>', '',
    fence + 'js', 'const stableAfter = 42;', fence, '', 'After'].join('\n');
  fs.mkdirSync('.local/block-passive-acceptance', { recursive: true });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(({ theme, text }) => {
      const w = window as any;
      w.passiveEditor?.destroy(); document.querySelector('#app')!.replaceChildren();
      w.MermaidEditingHarness.applyBuiltInVisualBaseline(theme);
      w.MermaidEditingHarness.applyUiTheme(theme, false);
      w.MermaidEditingHarness.applyCodeTheme(theme);
      w.passiveEditor = w.MermaidEditingHarness.createEditor({ parent: document.querySelector('#app'), text,
        initialMode: 'live', uiLanguage: 'en', onApplyChanges() {} });
    }, { theme, text });
    await page.waitForSelector('.meo-mermaid-block svg'); await frames();
    await page.click('.meo-md-long-code-placeholder .meo-long-code-action'); await frames();
    await page.evaluate(() => {
      const view = (window as any).passiveEditor.view;
      view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('const target15') } }); view.focus();
      const nodes = Array.from(view.dom.querySelectorAll('.meo-md-math-fenced-display,.meo-md-html-block,.meo-mermaid-block'));
      (window as any).unchangedBlocks = nodes;
    }); await frames();
    await page.click('.meo-md-long-code-footer .meo-long-code-action'); await frames(24);
    const folded = await page.evaluate(() => {
      const view = (window as any).passiveEditor.view, target = document.activeElement as HTMLElement;
      const action = target.querySelector('.meo-long-code-action')!;
      const active = view.dom.querySelector('.cm-activeLine.meo-md-code-block');
      const neutral = view.dom.querySelector('.cm-line.meo-md-code-block:not(.cm-activeLine)');
      return { reading: target.classList.contains('meo-block-reading-target'), summary: target.classList.contains('meo-md-long-code-placeholder'),
        tag: target.tagName, classes: target.className, containerReading: view.dom.classList.contains('meo-block-reading'),
        shadow: getComputedStyle(target).boxShadow, actionShadow: getComputedStyle(action).boxShadow,
        activeBackground: active && getComputedStyle(active).backgroundColor, neutralBackground: neutral && getComputedStyle(neutral).backgroundColor,
        watchedBlocks: (window as any).unchangedBlocks.length,
        retainedBlocks: (window as any).unchangedBlocks.every((node: Element) => node.isConnected) };
    });
    assert.ok(folded.reading && folded.summary && folded.retainedBlocks, JSON.stringify(folded));
    assert.equal(folded.watchedBlocks, 5, 'Both formulas, both HTML blocks and the Mermaid diagram must be mounted');
    assert.equal(folded.shadow, 'none', 'Collapse must not outline the whole summary bar');
    assert.ok(folded.actionShadow.includes('inset'), 'The small expansion action carries the visible focus cue');
    assert.equal(folded.activeBackground, folded.neutralBackground, 'Reading focus must not light up an unrelated first code row');
    await page.screenshot({ path: `.local/block-passive-acceptance/${theme}-folded.png` });

    const passive = await page.evaluate(async () => {
      const view = (window as any).passiveEditor.view, target = document.activeElement as HTMLElement;
      let attributes = 0, hiddenFocus = 0, blurs = 0;
      const blur = () => { blurs++; }; target.addEventListener('blur', blur);
      const observer = new MutationObserver(records => {
        attributes += records.length;
        if (!target.classList.contains('meo-block-reading-target')) hiddenFocus++;
      });
      observer.observe(target, { attributes: true });
      view.dispatch({});
      for (let i = 0; i < 4; i++) await new Promise(resolve => requestAnimationFrame(resolve));
      const noOpAttributes = attributes;
      view.dispatch({ changes: { from: 0, insert: 'prefix ' } });
      for (let i = 0; i < 12; i++) await new Promise(resolve => requestAnimationFrame(resolve));
      observer.disconnect(); target.removeEventListener('blur', blur);
      return { noOpAttributes, hiddenFocus, blurs, retained: target.isConnected, focused: target === document.activeElement };
    });
    assert.deepEqual(passive, { noOpAttributes: 0, hiddenFocus: 0, blurs: 0, retained: true, focused: true },
      'Unrelated refresh and position mapping retain existing focus without a transient reset');
    await page.keyboard.press('Enter'); await frames();
    assert.ok(await page.evaluate(() => (window as any).passiveEditor.view.hasFocus), 'The compact focus cue still accepts keyboard entry');

    await page.evaluate(() => {
      const w = window as any, view = w.passiveEditor.view;
      view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('const target15') } }); view.focus();
      const nodes = Array.from(view.dom.querySelectorAll('.meo-md-math-fenced-display,.meo-md-html-block,.meo-mermaid-block'));
      const lines = Array.from(view.contentDOM.querySelectorAll<HTMLElement>('.cm-line'))
        .filter(line => /stableBefore|stableAfter/.test(line.textContent ?? '')).map(node => ({ node, html: node.innerHTML }));
      w.passiveWitness = { nodes, lines, changes: [] as string[] };
      let remaining = 48;
      const sample = () => {
        if (nodes.some(node => !node.isConnected)) w.passiveWitness.changes.push('rendered block replaced');
        if (lines.some(line => !line.node.isConnected || line.node.innerHTML !== line.html)) w.passiveWitness.changes.push('unrelated code changed');
        if (--remaining) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.keyboard.type('abc'); await frames(52);
    assert.equal(await page.evaluate(() => (window as any).passiveWitness.lines.length), 2, 'Both neighboring code blocks must be observed');
    assert.deepEqual(await page.evaluate(() => (window as any).passiveWitness.changes), [],
      'Typing retains unaffected rendered blocks and neighboring source tokens on every sampled frame');

    await page.evaluate(() => {
      const view = (window as any).passiveEditor.view;
      view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('flowchart LR') } }); view.focus();
    }); await frames();
    await page.screenshot({ path: `.local/block-passive-acceptance/${theme}.png` });
    // Witness colors isolate painted icon/text pixels without changing geometry.
    for (const language of ['en', 'zh-CN']) for (const font of ['Consolas, monospace', 'Segoe UI, sans-serif']) {
      await page.evaluate(({ language, font }) => {
        (window as any).passiveEditor.setUiLanguage(language);
        document.documentElement.style.setProperty('--meo-font-live', font);
      }, { language, font }); await frames();
      for (let direction = 0; direction < 2; direction++) {
        const button = await page.$('.meo-mermaid-layout-btn'); assert.ok(button);
        await button.evaluate(button => {
          button.style.color = '#00ff00'; button.style.background = '#000000';
          (button.querySelector('svg') as SVGElement).style.color = '#ff0000';
        });
        const { data, info } = await sharp(await button.screenshot()).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const icon: number[] = [], caption: number[] = [];
        for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
          const offset = (y * info.width + x) * info.channels, r = data[offset]!, g = data[offset + 1]!, b = data[offset + 2]!;
          if (r > 130 && g < 80 && b < 80) icon.push(y);
          if (g > 130 && r < 80 && b < 80) caption.push(y);
        }
        assert.ok(icon.length && caption.length, 'Both parts must be visibly painted');
        const center = (rows: number[]) => (Math.min(...rows) + Math.max(...rows)) / 2;
        assert.ok(Math.abs(center(icon) - center(caption)) <= 1,
          `Layout action painted alignment: ${JSON.stringify({ theme, language, font, direction, icon: center(icon), caption: center(caption) })}`);
        await button.click(); await frames();
      }
    }
    console.log(`${theme}: compact fold focus, passive DOM/focus retention and painted layout labels passed`);
  }
  assert.deepEqual(errors, []);
} catch (error) { failure = error; }
if (failure === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, failure);
