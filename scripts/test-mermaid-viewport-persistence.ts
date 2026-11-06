import { installPackagedMermaid } from './mermaid-runtime-test-helpers';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-block-sticky-header-production-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primary: unknown;
let stage = 'setup';
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 1050, height: 650 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addStyleTag({ content: ':root{--meo-background:#24292e;--meo-foreground:#e6edf3;--meo-code-background:#1b2024;--meo-font-live:Arial;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-size:14px}' });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  await page.evaluate(() => {
    (window as any).mermaid = { initialize() {}, async render(_id: string, source: string) {
      if (source.includes('INVALID')) throw new Error('Incomplete diagram');
      const type = source.startsWith('pie') ? 'pie' : 'flowchart-v2';
      const tiny = source.includes('tiny');
      const render = (window as any).viewportRenderCount = ((window as any).viewportRenderCount ?? 0) + 1;
      return { svg: `<svg width="320" height="160" viewBox="0 0 320 160" aria-roledescription="${type}" data-render="${render}" data-source="${encodeURIComponent(source)}"><rect x="${tiny ? 150 : 0}" width="${tiny ? 20 : 320}" height="160" fill="#282e33" stroke="#66717c"/></svg>` };
    } };
    (window as any).viewportEditor = (window as any).BlockStickyHeaderHarness.createEditor({
      parent: document.querySelector('#app'), text: 'Before\n\n```mermaid\nflowchart LR\nA[original] --> B\n```\n\nAfter',
      initialMode: 'live', uiLanguage: 'en', sourceLineNumbers: 'on', onApplyChanges() {}
    });
  });
  const settle = () => page.evaluate(async () => {
    for (let i = 0; i < 10; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
  const wrapper = '.meo-mermaid-svg-wrapper';
  const dock = '.meo-mermaid-preview-controls:not(.is-outside-viewport)';
  const camera = () => page.$eval(wrapper, node => {
    const matrix = new DOMMatrix(getComputedStyle(node).transform);
    return { zoom: matrix.a, panX: matrix.e, panY: matrix.f };
  });
  const pointAt = (selector: string, x: number, y: number) => page.$eval(selector, (node, x, y) => {
    const svg = node.querySelector('svg') as SVGSVGElement;
    const point = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: point.x, y: point.y };
  }, x, y);
  const assertPoint = (actual: { x: number; y: number }, expected: { x: number; y: number }, message: string) => {
    assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y) < 0.001,
      `${message}: ${JSON.stringify({ actual, expected })}`);
  };
  const cycle = async () => {
    await page.$eval('.meo-mermaid-mode-btn', node => (node as HTMLElement).click());
    await settle();
  };
  const waitForSource = async (source: string) => {
    try {
      await page.waitForFunction(source => document.querySelector('.meo-mermaid-block svg')?.getAttribute('data-source') === encodeURIComponent(source), { timeout: 5000 }, source);
    } catch (cause) {
      const actual = await page.evaluate(() => ({ text: (window as any).viewportEditor.getText(), html: document.querySelector('.meo-mermaid-block')?.innerHTML }));
      throw new Error(`Expected render of ${JSON.stringify(source)}; actual ${JSON.stringify(actual)}`, { cause });
    }
    await settle();
  };
  await waitForSource('flowchart LR\nA[original] --> B');
  await cycle();
  await page.waitForSelector('.meo-mermaid-editing-preview');
  await page.waitForSelector(dock);
  await page.$eval(dock + ' button:first-child', node => (node as HTMLElement).click());
  const rect = await page.$eval('.meo-mermaid-block', node => node.getBoundingClientRect().toJSON());
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + 36, rect.y + rect.height / 2 + 24, { steps: 4 });
  await page.mouse.up();
  let before = await camera();
  assert.deepEqual(before, { zoom: 1.25, panX: 36, panY: 24 });
  stage = 'proportional embedded zoom';
  const layoutBeforeZoom = await page.$eval('.meo-mermaid-block', node => node.getBoundingClientRect().toJSON());
  const anchor = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const originalPoint = await pointAt(wrapper, anchor.x, anchor.y);
  await page.$eval(dock, controls => {
    const buttons = controls.querySelectorAll<HTMLButtonElement>('button');
    for (let i = 0; i < 15; i++) buttons[0]!.click();
  });
  assert.ok(Math.abs((await camera()).zoom - 1.25 ** 16) < 0.0001, 'Embedded Mermaid zoom continues beyond 4x');
  assertPoint(await pointAt(wrapper, anchor.x, anchor.y), originalPoint, 'Embedded zoom keeps the visible center on the same diagram point after panning');
  assert.deepEqual(await page.$eval('.meo-mermaid-block', node => node.getBoundingClientRect().toJSON()), layoutBeforeZoom,
    'Zoom does not change document block geometry');
  await page.$eval(dock, controls => {
    const buttons = controls.querySelectorAll<HTMLButtonElement>('button');
    for (let i = 0; i < 15; i++) buttons[1]!.click();
  });
  const inverse = await camera();
  assert.ok(Math.abs(inverse.zoom - before.zoom) < 0.00000001, 'Inverse steps restore the embedded zoom');
  assertPoint({ x: inverse.panX, y: inverse.panY }, { x: before.panX, y: before.panY }, 'Inverse zoom steps preserve the embedded camera');
  before = inverse;
  await page.evaluate(()=>{const e=(window as any).viewportEditor;const pos=e.getText().indexOf('\n```',e.getText().indexOf('```mermaid')+10);e.view.dispatch({selection:{anchor:pos}});e.view.focus();});
  await page.evaluate(()=>{const e=(window as any).viewportEditor;e.pastePlainText('\nC[changed]');});
  await waitForSource('flowchart LR\nA[original] --> B\nC[changed]');
  assert.deepEqual(await camera(), before, 'Editing the split source preserves zoom and pan');
  stage = 'undo';
  await page.evaluate(() => (window as any).viewportEditor.undo());
  await waitForSource('flowchart LR\nA[original] --> B');
  assert.deepEqual(await camera(), before, 'Undo preserves the camera');
  await page.evaluate(() => (window as any).viewportEditor.redo());
  await waitForSource('flowchart LR\nA[original] --> B\nC[changed]');
  assert.deepEqual(await camera(), before, 'Redo preserves the camera');
  for (const action of ['side','stacked','close','open']) {
    stage = 'layout '+action;
    if(action==='side'||action==='stacked') await page.$eval('.meo-mermaid-layout-btn',b=>(b as HTMLElement).click()); else await cycle();
    await settle(); await waitForSource('flowchart LR\nA[original] --> B\nC[changed]');
    assert.deepEqual(await camera(), before, action+' preserves the camera');
  }
  const replaceSource = async (source: string) => {
    await page.evaluate(source => {
      const view = (window as any).viewportEditor.view;
      const text = view.state.doc.toString();
      const from = text.indexOf('```mermaid\n') + '```mermaid\n'.length;
      view.dispatch({ changes: { from, to: text.indexOf('\n```', from), insert: source } });
    }, source);
  };
  await replaceSource('flowchart LR\nINVALID');
  stage = 'error recovery';
  await page.waitForSelector('.meo-mermaid-error-badge');
  await replaceSource('flowchart LR\nA[recovered] --> B');
  await waitForSource('flowchart LR\nA[recovered] --> B');
  assert.deepEqual(await camera(), before, 'Temporary syntax errors preserve the camera');
  stage = 'theme refresh';
  const renderBeforeTheme = await page.$eval(wrapper + ' svg', node => node.getAttribute('data-render'));
  await page.evaluate(() => (window as any).MermaidEditingHarness.refreshMermaidTheme());
  await page.waitForFunction(render => document.querySelector('.meo-mermaid-svg-wrapper svg')?.getAttribute('data-render') !== render, {}, renderBeforeTheme);
  await settle();
  assert.deepEqual(await camera(), before, 'Theme re-render preserves the camera');
  await page.$eval(dock + ' button:nth-child(4)', node => (node as HTMLElement).click());
  await page.waitForSelector('.meo-mermaid-fullscreen-scrim');
  await settle();
  const fullscreenCamera = () => page.$eval('.meo-mermaid-fullscreen .meo-mermaid-svg-wrapper', node => {
    const matrix = new DOMMatrix(getComputedStyle(node).transform);
    return { zoom: matrix.a, x: matrix.e, y: matrix.f };
  });
  const fittedCamera = await fullscreenCamera();
  stage = 'fullscreen free pan and zoom anchors';
  await page.mouse.move(525, 325);
  await page.mouse.down();
  await page.mouse.move(1925, 1025, { steps: 5 });
  await page.mouse.up();
  assertPoint(await fullscreenCamera(), { x: 1400, y: 700 }, 'Fullscreen panning is unrestricted even when the fitted diagram leaves the canvas');
  const fullscreenWrapper = '.meo-mermaid-fullscreen .meo-mermaid-svg-wrapper';
  const fullscreenPoint = await pointAt(fullscreenWrapper, 525, 325);
  await page.click('.meo-mermaid-fullscreen-controls button:first-child');
  assertPoint(await pointAt(fullscreenWrapper, 525, 325), fullscreenPoint, 'Fullscreen buttons preserve the viewport center after panning');
  const pointerPoint = await pointAt(fullscreenWrapper, 390, 240);
  const beforeWheel = (await fullscreenCamera()).zoom;
  await page.mouse.move(390, 240);
  await page.mouse.wheel({ deltaY: -120 });
  await page.waitForFunction(expected => {
    const node = document.querySelector('.meo-mermaid-fullscreen .meo-mermaid-svg-wrapper')!;
    return Math.abs(new DOMMatrix(getComputedStyle(node).transform).a - expected) < 0.00001;
  }, {}, beforeWheel * 1.1);
  assertPoint(await pointAt(fullscreenWrapper, 390, 240), pointerPoint, 'Fullscreen wheel preserves the pointer anchor without boundary correction');
  await page.click('.meo-mermaid-fullscreen-controls button:nth-child(3)');
  assert.deepEqual(await fullscreenCamera(), fittedCamera, 'Reset brings an offscreen diagram back into view');
  await page.$eval('.meo-mermaid-fullscreen-controls', controls => {
    for (let i = 0; i < 16; i++) controls.querySelector<HTMLButtonElement>('button')!.click();
  });
  assert.ok(Math.abs((await fullscreenCamera()).zoom / fittedCamera.zoom - 1.25 ** 16) < 0.001,
    'Fullscreen Mermaid zoom continues proportionally beyond 4x');
  await page.mouse.move(525, 325);
  await page.mouse.wheel({ deltaY: -120 });
  await page.waitForFunction(expected => {
    const node = document.querySelector('.meo-mermaid-fullscreen .meo-mermaid-svg-wrapper')!;
    return Math.abs(new DOMMatrix(getComputedStyle(node).transform).a - expected) < 0.001;
  }, {}, fittedCamera.zoom * 1.25 ** 16 * 1.1);
  await page.mouse.wheel({ deltaY: 120 });
  await page.waitForFunction(expected => {
    const node = document.querySelector('.meo-mermaid-fullscreen .meo-mermaid-svg-wrapper')!;
    return Math.abs(new DOMMatrix(getComputedStyle(node).transform).a - expected) < 0.001;
  }, {}, fittedCamera.zoom * 1.25 ** 16);
  await page.$eval('.meo-mermaid-fullscreen-controls', controls => {
    for (let i = 0; i < 16; i++) controls.querySelectorAll<HTMLButtonElement>('button')[1]!.click();
  });
  assert.ok(Math.abs((await fullscreenCamera()).zoom - fittedCamera.zoom) < 0.00001);
  await page.mouse.move(525, 325);
  await page.mouse.wheel({ deltaY: -120 });
  await page.waitForFunction(expected => {
    const node = document.querySelector('.meo-mermaid-fullscreen .meo-mermaid-svg-wrapper')!;
    return Math.abs(new DOMMatrix(getComputedStyle(node).transform).a - expected) < 0.00001;
  }, {}, fittedCamera.zoom * 1.1);
  await page.mouse.wheel({ deltaY: 120 });
  await page.waitForFunction(expected => {
    const node = document.querySelector('.meo-mermaid-fullscreen .meo-mermaid-svg-wrapper')!;
    return Math.abs(new DOMMatrix(getComputedStyle(node).transform).a - expected) < 0.00001;
  }, {}, fittedCamera.zoom);
  await page.$eval('.meo-mermaid-fullscreen-controls button:nth-child(3)', node => (node as HTMLButtonElement).click());
  assert.deepEqual(await fullscreenCamera(), fittedCamera, 'Reset still returns to the fitted fullscreen camera');
  await page.keyboard.press('Escape');
  await settle();
  assert.deepEqual(await camera(), before, 'Fullscreen return preserves the embedded camera');

  // Separate blocks with identical source must never share the SVG cache's camera.
  stage = 'independent blocks';
  await page.evaluate(() => {
    const view = (window as any).viewportEditor.view;
    view.dispatch({ changes: { from: view.state.doc.length, insert: '\n\n```mermaid\nflowchart LR\nA[recovered] --> B\n```' } });
  });
  await page.waitForFunction(() => document.querySelectorAll('.meo-mermaid-svg-wrapper > svg').length === 2);
  await settle();
  assert.deepEqual(await page.$$eval(wrapper, nodes => nodes.map(node => {
    const m = new DOMMatrix(getComputedStyle(node).transform);
    return { zoom: m.a, panX: m.e, panY: m.f };
  })), [before, { zoom: 1, panX: 0, panY: 0 }], 'Identical diagrams have independent cameras');
  await page.evaluate(() => {
    const view = (window as any).viewportEditor.view;
    view.dispatch({ changes: { from: 0, insert: 'An inserted paragraph\n\n' } });
  });
  await settle();
  assert.deepEqual(await camera(), before, 'Edits before the block remap its camera');
  await page.evaluate(() => {
    const view = (window as any).viewportEditor.view;
    const text = view.state.doc.toString();
    view.dispatch({ changes: { from: text.lastIndexOf('\n\n```mermaid'), to: text.length } });
  });
  await settle();

  // Controls modify only the transient camera, including explicit Reset.
  stage = 'reset';
  const documentState = () => page.evaluate(() => {
    const editor = (window as any).viewportEditor;
    return { text: editor.getText(), selection: editor.view.state.selection.toJSON(), history: editor.getHistoryDepth(), scrollTop: editor.view.scrollDOM.scrollTop };
  });
  const beforeReset = await documentState();
  await page.$eval(dock + ' button:nth-child(3)', node => (node as HTMLElement).click());
  await settle();
  assert.deepEqual(await camera(), { zoom: 1, panX: 0, panY: 0 });
  assert.deepEqual(await documentState(), beforeReset, 'Camera controls do not change source, selection, history or scroll');
  await replaceSource('flowchart LR\nA[reset retained] --> B');
  await waitForSource('flowchart LR\nA[reset retained] --> B');
  assert.deepEqual(await camera(), { zoom: 1, panX: 0, panY: 0 }, 'Reset survives the next update');
  await page.$eval(dock + ' button:first-child', node => (node as HTMLElement).click());
  await replaceSource('pie\n"First": 40\n"Second": 60');
  stage = 'type change';
  await waitForSource('pie\n"First": 40\n"Second": 60');
  assert.deepEqual(await camera(), { zoom: 1, panX: 0, panY: 0 }, 'Changing diagram type resets the camera');

  await page.$eval(dock + ' button:first-child', node => (node as HTMLElement).click());
  stage = 'whole block replacement';
  await page.evaluate(() => {
    const view = (window as any).viewportEditor.view;
    const text = view.state.doc.toString();
    const from = text.indexOf('```mermaid');
    const to = text.indexOf('\n```', from) + 4;
    view.dispatch({ changes: { from, to, insert: text.slice(from, to) } });
  });
  await page.waitForFunction(() => {
    const node = document.querySelector('.meo-mermaid-svg-wrapper');
    return node && new DOMMatrix(getComputedStyle(node).transform).a === 1;
  }, { timeout: 4000 });
  await settle();
  assert.deepEqual(await camera(), { zoom: 1, panX: 0, panY: 0 }, 'Replacing the entire block creates a fresh camera even with identical source');
  stage = 'offscreen content persistence';
  await page.$eval(dock + ' button:first-child', node => (node as HTMLElement).click());
  const nextRect = await page.$eval('.meo-mermaid-block', node => node.getBoundingClientRect().toJSON());
  await page.mouse.move(nextRect.x + 30, nextRect.y + nextRect.height / 2);
  await page.mouse.down();
  await page.mouse.move(nextRect.x + 530, nextRect.y + nextRect.height / 2, { steps: 5 });
  await page.mouse.up();
  assert.deepEqual(await camera(), { zoom: 1.25, panX: 500, panY: 0 });
  await replaceSource('pie\n"tiny": 100');
  await waitForSource('pie\n"tiny": 100');
  const offscreen = await camera();
  assert.deepEqual(offscreen, { zoom: 1.25, panX: 500, panY: 0 }, 'Smaller content retains the camera even when entirely offscreen');
  await replaceSource('pie\n"tiny": 90\n"Other": 10');
  await waitForSource('pie\n"tiny": 90\n"Other": 10');
  assert.deepEqual(await camera(), offscreen, 'Ordinary updates do not recenter offscreen content');
  stage = 'document Source/Live';
  await page.evaluate(() => (window as any).viewportEditor.setMode('source'));
  await settle();
  await page.evaluate(() => (window as any).viewportEditor.setMode('live'));
  await waitForSource('pie\n"tiny": 90\n"Other": 10');
  assert.deepEqual(await camera(), offscreen, 'Document mode reconfiguration retains the session camera');
  await page.$eval(dock + ' button:nth-child(3)', node => (node as HTMLElement).click());
  assert.deepEqual(await camera(), { zoom: 1, panX: 0, panY: 0 }, 'Reset recovers offscreen embedded content');
  stage = 'real Mermaid runtime';
  await page.evaluate(() => (window as any).viewportEditor.destroy());
  await installPackagedMermaid(page);
  await page.evaluate(() => {
    document.querySelector('#app')!.replaceChildren();
    (window as any).MermaidEditingHarness.refreshMermaidTheme();
    (window as any).viewportEditor = (window as any).BlockStickyHeaderHarness.createEditor({
      parent: document.querySelector('#app'),
      text: 'Before\n\n```mermaid\nflowchart LR\nsubgraph Process\n A[Original] --> B{Review}\n B --> C[Approved]\n B --> D[Revise]\n D --> A\nend\n```\n\nAfter',
      initialMode: 'live', uiLanguage: 'en', sourceLineNumbers: 'on', onApplyChanges() {}
    });
  });
  await page.waitForSelector('.meo-mermaid-svg-wrapper svg', { timeout: 15000 });
  await settle(); await cycle();
  await page.waitForSelector('.meo-mermaid-editing-preview .meo-mermaid-svg-wrapper > svg'); await settle();
  await page.$eval(dock + ' button:first-child', node => (node as HTMLElement).click());
  const realRect = await page.$eval('.meo-mermaid-block', node => node.getBoundingClientRect().toJSON());
  await page.mouse.move(realRect.x + realRect.width / 2, realRect.y + realRect.height / 2);
  await page.mouse.down();
  await page.mouse.move(realRect.x + realRect.width / 2 + 36, realRect.y + realRect.height / 2 + 24, { steps: 4 });
  await page.mouse.up();
  const realCamera = await camera();
  assert.equal(realCamera.zoom, 1.25);
  assertPoint({ x: realCamera.panX, y: realCamera.panY }, { x: 36, y: 24 }, 'Actual Mermaid drag retains its displacement');
  await page.evaluate(()=>{const e=(window as any).viewportEditor;const pos=e.getText().indexOf('\n```',e.getText().indexOf('```mermaid')+10);e.view.dispatch({selection:{anchor:pos}});e.view.focus();});
  await page.keyboard.type('\nC --> E[Added node]', { delay: 60 });
  await page.waitForFunction(() => document.querySelector('.meo-mermaid-editing-preview .meo-mermaid-svg-wrapper')?.textContent?.includes('Added node'), { timeout: 15000 });
  await settle();
  assert.deepEqual(await camera(), realCamera, 'Actual Mermaid/ELK rendering retains the camera while typing');
  await replaceSource('pie title Real runtime\n"First": 40\n"Second": 60');
  await page.waitForFunction(() => document.querySelector('.meo-mermaid-svg-wrapper svg')?.getAttribute('aria-roledescription') === 'pie', { timeout: 15000 });
  await settle();
  assert.deepEqual(await camera(), { zoom: 1, panX: 0, panY: 0 }, 'Actual Mermaid type metadata resets a changed diagram type');
  await page.$eval(dock, controls => {
    for (let i = 0; i < 4; i++) controls.querySelector<HTMLButtonElement>('button')!.click();
  });
  mkdirSync('.local/visual-zoom-acceptance', { recursive: true });
  await page.screenshot({ path: '.local/visual-zoom-acceptance/mermaid-embedded.png' });
  assert.deepEqual(errors, []);
  await page.evaluate(() => (window as any).viewportEditor.destroy());
  console.log('Mermaid viewport persistence passed: typing, undo/redo, block/document modes, syntax recovery, theme/fullscreen, independent blocks, anchor mapping, Reset, type change, replacement, content shrink, document/scroll isolation and actual Mermaid rendering');
} catch (error) {
  console.error('Mermaid viewport stage:', stage);
  primary = error;
} finally {
  if (primary === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primary);
}
