import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assertReadableMermaidTasks } from './mermaid-contrast-helpers';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-block-sticky-header-production-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primary: unknown;
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 1050, height: 650 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addStyleTag({ content: ':root{--meo-background:#24292e;--meo-foreground:#e6edf3;--meo-code-background:#1b2024;--meo-font-live:Arial;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-size:14px;--meo-semantic-codeCopyForeground:#b6c2ce;--meo-semantic-codeCopyHoverBackground:#30363d}' });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  await page.evaluate(() => {
    (window as any).mermaid = { initialize() {}, async render(_id: string, source: string) {
      const height = source.includes('tall') ? 1800 : 100;
      return { svg: `<svg width="320" height="${height}" viewBox="0 0 320 ${height}"><rect x="60" y="10" width="200" height="60" fill="#282e33" stroke="#66717c"/><text x="130" y="45" fill="#e6edf3">Diagram</text><path d="M160 70v${height - 90}" stroke="#89b4fa"/></svg>` };
    } };
    (window as any).BlockStickyHeaderHarness.bindTooltips(document.body);
  });
  const settle = () => page.evaluate(async () => {
    for (let i = 0; i < 10; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
  const mount = async (tall: boolean, longSource = false) => {
    await page.evaluate(({ tall, longSource }) => {
      const host = window as any;
      host.controlsEditor?.destroy(); document.querySelector('#app')!.replaceChildren();
      host.controlsEditor = host.BlockStickyHeaderHarness.createEditor({ parent: document.querySelector('#app'),
        text: 'Before\n\n```mermaid\nflowchart TD\nA[' + (tall ? 'tall' : 'short') + '] --> B\n'
          + (longSource ? Array.from({ length: 80 }, (_, i) => '%% source ' + i).join('\n') + '\n' : '') + '```\n\n'
          + Array.from({ length: 80 }, (_, i) => 'Paragraph ' + i).join('\n\n'),
        initialMode: 'live', uiLanguage: 'zh-CN', sourceLineNumbers: 'on', onApplyChanges() {} });
    }, { tall, longSource });
    await page.waitForSelector('.meo-mermaid-block svg'); await settle();
  };
  const dock = '.meo-mermaid-preview-controls:not(.is-outside-viewport)';
  const assertPosition = async (context: string) => {
    await page.mouse.move(0, 0);
    await settle();
    if (!await page.$(dock)) {
      const diagnostic = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.meo-mermaid-block, .meo-mermaid-preview-controls, #app > .cm-editor > .cm-scroller, .meo-rendered-block-preview-pane'), node => ({
        class: node.className, rect: node.getBoundingClientRect().toJSON(), columns: node.dataset.meoControlsColumns,
        display: getComputedStyle(node).display, grid: getComputedStyle(node).gridTemplateColumns,
        padding: getComputedStyle(node).padding, box: getComputedStyle(node).boxSizing
      })));
      console.error(context, JSON.stringify(diagnostic), errors);
      throw new Error(`${context}: no visible controls`);
    }
    const bounds = await page.$eval(dock, controls => {
      const root = controls.closest('.meo-mermaid-block')!.getBoundingClientRect();
      const scroller = controls.closest('.cm-scroller')!.getBoundingClientRect();
      const rect = controls.getBoundingClientRect();
      const pane = controls.closest('.meo-rendered-block-preview-pane')?.getBoundingClientRect();
      return { rect: rect.toJSON(), left: Math.max(root.left, scroller.left, pane?.left ?? 0),
        right: Math.min(root.right, scroller.right, innerWidth, pane?.right ?? innerWidth),
        top: Math.max(root.top, scroller.top), bottom: Math.min(root.bottom, scroller.bottom, innerHeight, pane?.bottom ?? innerHeight) };
    });
    assert.ok(Math.abs(bounds.rect.right - (bounds.right - 6)) < 2, `${context}: right ${JSON.stringify(bounds)}`);
    assert.ok(Math.abs(bounds.rect.bottom - (bounds.bottom - 6)) < 2, `${context}: bottom ${JSON.stringify(bounds)}`);
    assert.ok(bounds.rect.left >= bounds.left && bounds.rect.top >= bounds.top, `${context}: controls stay inside the visible diagram`);
    const appearance = await page.$eval(dock, controls => {
      let opacity = 1;
      for (let node: Element | null = controls; node; node = node.parentElement) {
        opacity *= Number(getComputedStyle(node).opacity);
      }
      return { opacity, visibility: getComputedStyle(controls).visibility,
        editing: !!controls.closest('.meo-mermaid-editing-preview'),
        hovered: controls.closest('.meo-mermaid-block')!.matches(':hover') };
    });
    assert.equal(appearance.hovered, false, `${context}: test pointer stays outside the diagram`);
    assert.equal(appearance.opacity, appearance.editing ? 1 : 0,
      `${context}: editing controls stay visible; reading controls require hover or keyboard focus`);
    await page.mouse.move(bounds.rect.left + bounds.rect.width / 2, bounds.rect.top + bounds.rect.height / 2);
    await settle();
    await page.waitForFunction(selector => getComputedStyle(document.querySelector(selector)!).opacity === '1',
      { timeout: 2000 }, dock);
    const hovered = await page.$eval(dock, controls => ({
      opacity: Number(getComputedStyle(controls).opacity),
      visibility: getComputedStyle(controls).visibility,
      pointerEvents: getComputedStyle(controls).pointerEvents,
      diagramHovered: controls.closest('.meo-mermaid-block')!.matches(':hover')
    }));
    assert.equal(hovered.diagramHovered, true, `${context}: pointer enters the diagram`);
    assert.equal(hovered.visibility, 'visible', `${context}: controls visible on diagram hover`);
    assert.equal(hovered.opacity, 1, `${context}: controls revealed on diagram hover`);
    assert.equal(hovered.pointerEvents, 'auto', `${context}: revealed controls accept clicks`);
    assert.equal(await page.$$eval('.meo-mermaid-preview-controls', nodes => nodes.length), 1, 'One owner/group, including floating headers');
    assert.equal(await page.$$eval('.meo-mermaid-toolbar .meo-visual-control-btn', nodes => nodes.length), 0);
  };
  await mount(false); await assertPosition('short');
  await page.mouse.move(0, 0);
  await page.$eval(dock + ' button', button => (button as HTMLElement).focus({ preventScroll: true }));
  await settle();
  assert.equal(await page.$eval(dock, controls => Number(getComputedStyle(controls).opacity)), 1, 'Keyboard focus reveals the controls without pointer hover');
  await page.$eval(dock + ' button', button => (button as HTMLElement).blur()); await settle();
  let fixedWidth: number | undefined;
  for (const [mode, label] of [['preview', '编辑'], ['edit', '完成编辑'], ['preview', '编辑']]) {
    const state = await page.$eval('.meo-mermaid-toolbar', node => {
      const button = node.querySelector('.meo-mermaid-mode-btn')!;
      return { mode: (node as HTMLElement).dataset.meoMermaidMode, text: button.textContent, label: button.getAttribute('aria-label'),
        tooltip: (button as HTMLElement).dataset.tooltip, width: button.getBoundingClientRect().width,
        icon: button.querySelector('svg')!.innerHTML, count: node.querySelectorAll(':scope > button, :scope > [role="button"]').length,
        menu: node.querySelector('summary, [aria-haspopup]') !== null };
    });
    assert.equal(state.mode, mode); assert.equal(state.text, '');
    assert.equal(state.label, label); assert.equal(state.tooltip, label);
    fixedWidth ??= state.width;
    assert.equal(state.width, 22); assert.equal(state.width, fixedWidth);
    assert.equal(state.count, 4); assert.equal(state.menu, false);
    assert.equal(await page.$('.meo-mermaid-toolbar .meo-mermaid-layout-btn'), null,
      'Layout belongs to the preview instead of the source toolbar');
    assert.equal(await page.$$eval('.meo-native-source-preview-label .meo-mermaid-layout-btn', nodes => nodes.length), mode === 'edit' ? 1 : 0);
    assert.equal(await page.$eval('.meo-mermaid-toolbar', node => node.firstElementChild?.classList.contains('meo-mermaid-mode-btn')), true,
      'Finish editing precedes select all');
    if (mode === 'edit') {
      const before = await page.evaluate(() => { const editor = (window as any).controlsEditor; return {
        text: editor.getText(), selection: editor.view.state.selection.toJSON(), history: editor.getHistoryDepth()
      }; });
      const action = '.meo-native-source-preview-label .meo-mermaid-layout-btn';
      assert.equal(await page.$eval(action, node => node.textContent), '切换为左右');
      await page.focus(action); await page.keyboard.press('Enter'); await settle();
      assert.ok(await page.$('.meo-mermaid-inline-preview'));
      assert.equal(await page.$eval(action, node => node.textContent), '切换为上下');
      assert.equal(await page.$eval(action, node => node === document.activeElement), true,
        'Keyboard layout switching restores focus to the new preview action');
      await page.keyboard.press('Space'); await settle();
      assert.equal(await page.$('.meo-mermaid-inline-preview'), null);
      assert.equal(await page.$eval(action, node => node === document.activeElement), true);
      assert.deepEqual(await page.evaluate(() => { const editor = (window as any).controlsEditor; return {
        text: editor.getText(), selection: editor.view.state.selection.toJSON(), history: editor.getHistoryDepth()
      }; }), before, 'Layout controls preserve document, selection and history');
      await page.$eval(action, node => (node as HTMLElement).blur());
    }
    await assertPosition(mode);
    if (mode === 'preview' && await page.evaluate(() => (window as any).__cycled)) break;
    await page.$eval('.meo-mermaid-mode-btn', node => (node as HTMLElement).click()); await settle();
    await page.evaluate(() => { (window as any).__cycled = true; });
  }
  await mount(true, true);
  for (const scrollTop of [0, 260, 700, 1300]) {
    await page.evaluate(scrollTop => { (window as any).controlsEditor.view.scrollDOM.scrollTop = scrollTop; }, scrollTop);
    await settle(); await assertPosition(`tall/${scrollTop}`);
  }
  assert.equal(await page.$$eval('.meo-block-sticky-header:not([hidden]) .meo-mermaid-toolbar > button, .meo-block-sticky-header:not([hidden]) .meo-mermaid-toolbar > [role="button"]', nodes => nodes.length), 4);
  const before = await page.evaluate(() => { const editor = (window as any).controlsEditor; return {
    text: editor.getText(), selection: editor.view.state.selection.toJSON(), height: editor.view.contentHeight, history: editor.getHistoryDepth()
  }; });
  const transform = await page.$eval('.meo-mermaid-svg-wrapper', node => (node as HTMLElement).style.transform);
  await page.click(dock + ' button:first-child'); await settle();
  assert.notEqual(await page.$eval('.meo-mermaid-svg-wrapper', node => (node as HTMLElement).style.transform), transform);
  await page.click(dock + ' button:nth-child(3)'); await settle();
  assert.deepEqual(await page.evaluate(() => { const editor = (window as any).controlsEditor; return {
    text: editor.getText(), selection: editor.view.state.selection.toJSON(), height: editor.view.contentHeight, history: editor.getHistoryDepth()
  }; }), before, 'Preview actions do not modify document layout, selection or history');
  await page.click(dock + ' button:nth-child(4)'); await settle();
  assert.ok(await page.$('.meo-mermaid-fullscreen-scrim')); assert.equal(await page.$(dock), null);
  await page.keyboard.press('Escape'); await settle(); await assertPosition('fullscreen return');
  await page.evaluate(() => { document.querySelector<HTMLElement>('#app')!.style.transform = 'scale(0.85)'; document.querySelector<HTMLElement>('#app')!.style.transformOrigin = 'top left'; });
  await settle(); await assertPosition('transformed host');
  await page.evaluate(() => { document.querySelector<HTMLElement>('#app')!.style.transform = ''; }); await settle();
  await page.evaluate(() => { (window as any).controlsEditor.view.scrollDOM.scrollTop = 0; }); await settle();
  await page.setViewport({ width: 220, height: 650 }); await settle();
  await page.evaluate(() => { (window as any).controlsEditor.view.scrollDOM.scrollTop = 0; }); await settle();
  await assertPosition('narrow');
  assert.equal(await page.$eval(dock, node => (node as HTMLElement).dataset.meoControlsColumns), '2');
  await page.setViewport({ width: 1050, height: 650 }); await settle();
  await page.evaluate(() => { const view = (window as any).controlsEditor.view; view.scrollDOM.scrollTop = view.lineBlockAt(view.state.doc.line(6).to).bottom - 5; });
  await settle(); assert.equal(await page.$(dock), null, 'Tiny remaining visible strip hides the controls');
  await page.evaluate(() => { (window as any).controlsEditor.view.scrollDOM.scrollTop = 700; }); await settle();
  await page.evaluate(() => (window as any).controlsEditor.setUiLanguage('en')); await settle();
  assert.equal(await page.$eval('.meo-block-sticky-header .meo-mermaid-mode-btn', node => node.getAttribute('aria-label')), 'Edit');
  fs.mkdirSync('.local/mermaid-controls', { recursive: true });
  await page.screenshot({ path: '.local/mermaid-controls/tall-dark.png' });
  await page.$eval('.meo-block-sticky-header .meo-mermaid-mode-btn', node => (node as HTMLElement).click()); await settle();
  await page.evaluate(() => { (window as any).controlsEditor.view.scrollDOM.scrollTop = 600; }); await settle();
  await assertPosition('tall split');
  await page.screenshot({ path: '.local/mermaid-controls/split-dark.png' });
  await page.evaluate(() => {
    const app = document.querySelector<HTMLElement>('#app')!;
    app.style.transform = 'scale(0.85)'; app.style.transformOrigin = 'top left';
    (window as any).controlsEditor.view.requestMeasure();
  });
  await settle();
  const alignment = await page.evaluate(() => {
    const pane = document.querySelector('.meo-mermaid-inline-preview')!.getBoundingClientRect();
    const source = document.querySelector('.meo-mermaid-inline-source')!.getBoundingClientRect();
    return Math.abs(pane.right - source.right);
  });
  assert.ok(alignment <= 1, `Inline preview stays aligned when its editor is scaled: ${alignment}`);
  await assertPosition('transformed inline block');
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#app')!.style.transform = '';
    (window as any).controlsEditor.view.requestMeasure();
  });
  await settle();
  await page.evaluate(() => {
    const e = (window as any).controlsEditor, v = e.view;
    v.scrollDOM.scrollTop = v.lineBlockAt(e.getText().indexOf('Paragraph 0')).top + 200;
  });
  await settle();
  assert.equal(await page.$(dock), null, 'A preview outside its document block does not leave floating controls');
  await page.evaluate(() => { (window as any).controlsEditor.view.scrollDOM.scrollTop = 600; }); await settle();
  await assertPosition('return to inline block');
  const assertSplitHeader = async (context: string) => {
    const layout = await page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>('.meo-mermaid-inline-preview')!;
      const header = document.querySelector<HTMLElement>('.meo-block-sticky-header:not([hidden])')!;
      const title = header.querySelector('.meo-native-source-preview-label') ?? pane.querySelector('.meo-native-source-preview-label')!;
      const heading = title.getBoundingClientRect();
      const action = title.querySelector('.meo-mermaid-layout-btn')!.getBoundingClientRect();
      const h = header.getBoundingClientRect(), p = pane.getBoundingClientRect();
      const toolbar = header.querySelector('.meo-mermaid-toolbar')!.getBoundingClientRect();
      const scale = h.width / parseFloat(header.style.width);
      const sourceWidth = parseFloat(header.style.getPropertyValue('--meo-mermaid-source-width')) * scale;
      const controls = Array.from(header.querySelectorAll<HTMLElement>('.meo-mermaid-toolbar > button, .meo-mermaid-toolbar > [role="button"]'));
      return { headingTop: heading.top, headerTop: h.top, boundary: h.left + sourceWidth - p.left,
        actionRight: action.right, actionsLeft: toolbar.left, paneTop: p.top,
        sourceWidth: p.left - h.left, side: header.classList.contains('is-mermaid-side'),
        background: getComputedStyle(header).backgroundColor,
        surface: getComputedStyle(pane).backgroundColor,
        label: header.querySelector('.meo-block-sticky-language')!.textContent,
        controls: controls.length,
        hittable: [...controls, title.querySelector<HTMLElement>('.meo-mermaid-layout-btn')!].every(control => {
          const r = control.getBoundingClientRect();
          return control.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
        }),
        visibleLayoutActions: Array.from(document.querySelectorAll('.meo-mermaid-layout-btn')).filter(node => getComputedStyle(node).visibility !== 'hidden').length };
    });
    assert.ok(layout.side && Math.abs(layout.boundary) <= 1 && Math.abs(layout.headingTop - layout.headerTop) <= 1,
      `${context}: preview title shares the actual split and sticky row ${JSON.stringify(layout)}`);
    assert.ok(layout.paneTop < layout.headerTop && layout.actionRight + 6 <= layout.actionsLeft && layout.sourceWidth >= 199,
      `${context}: divider reaches the top and both columns protect their controls ${JSON.stringify(layout)}`);
    assert.equal(layout.background, layout.surface,
      `${context}: the whole sticky row masks the diagram with an opaque block surface`);
    assert.notEqual(layout.background, 'rgba(0, 0, 0, 0)');
    assert.equal(layout.label, 'mermaid');
    assert.equal(layout.controls, 4);
    assert.equal(layout.visibleLayoutActions, 1, `${context}: only the floating layout action is exposed`);
    assert.ok(layout.hittable, `${context}: all five actions remain visible and clickable`);
  };
  await assertSplitHeader('scrolled split');
  await page.evaluate(() => {
    const view = (window as any).controlsEditor.view;
    const closing = view.state.doc.toString().indexOf('\n```', view.state.doc.toString().indexOf('```mermaid')) + 1;
    view.scrollDOM.scrollTop = view.lineBlockAt(closing).bottom - view.scrollDOM.clientHeight / 2;
  });
  await settle(); await assertSplitHeader('split near block end');
  await page.screenshot({ path: '.local/mermaid-controls/split-header-end.png' });
  await page.evaluate(() => { (window as any).controlsEditor.view.scrollDOM.scrollTop = 600; }); await settle();
  await page.$eval('.meo-mermaid-inline-separator', node => (node as HTMLElement).focus({ preventScroll: true }));
  for (let step = 0; step < 12; step++) await page.keyboard.press('ArrowRight');
  await settle();
  await page.setViewport({ width: 760, height: 650 }); await settle();
  await page.$eval('.meo-mermaid-inline-separator', node => (node as HTMLElement).focus({ preventScroll: true }));
  const beforeKey = await page.$eval('.meo-mermaid-inline-separator', node => Number(node.getAttribute('aria-valuenow')));
  await page.keyboard.press('ArrowLeft'); await settle();
  const afterKey = await page.$eval('.meo-mermaid-inline-separator', node => Number(node.getAttribute('aria-valuenow')));
  assert.ok(beforeKey - afterKey >= 4 && beforeKey - afterKey <= 6,
    'The first resize key uses the visible split after the window clamps a wider preference');
  for (let step = 0; step < 12; step++) await page.keyboard.press('ArrowRight');
  await settle(); await assertSplitHeader('minimum preview width');
  for (let step = 0; step < 12; step++) await page.keyboard.press('ArrowLeft');
  await settle(); await assertSplitHeader('minimum source width');
  const drag = await page.$eval('.meo-mermaid-inline-separator', node => {
    const rect = node.getBoundingClientRect();
    const top = document.querySelector('.meo-block-sticky-header:not([hidden])')!.getBoundingClientRect().top + 15;
    const x = rect.left + 2;
    return { x, y: top, target: document.elementFromPoint(x, top)?.classList.contains('meo-mermaid-inline-separator') };
  });
  assert.equal(drag.target, true, 'The divider remains draggable through the sticky title row');
  await page.mouse.move(drag.x, drag.y); await page.mouse.down();
  await page.mouse.move(drag.x + 70, drag.y, { steps: 5 }); await page.mouse.up();
  await settle(); await assertSplitHeader('drag through sticky header');
  await page.screenshot({ path: '.local/mermaid-controls/split-header-minimum-en.png' });
  await page.setViewport({ width: 1050, height: 650 }); await settle();
  const layoutAction = '.meo-block-sticky-header:not([hidden]) .meo-mermaid-layout-btn';
  await page.focus(layoutAction); await page.keyboard.press('Enter'); await settle();
  assert.equal(await page.$('.meo-mermaid-inline-preview'), null);
  await page.waitForFunction(() => document.activeElement?.classList.contains('meo-mermaid-layout-btn'), { timeout: 3000 });
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('meo-mermaid-layout-btn')), true,
    'Switching long source to stacked reveals the new preview action and keeps keyboard focus');
  await page.keyboard.press('Space'); await settle();
  assert.ok(await page.$('.meo-mermaid-inline-preview'));
  assert.equal(await page.$eval(layoutAction, node => node === document.activeElement), true,
    'Returning to a scrolled split focuses its visible floating action');
  await assertSplitHeader('keyboard return to split');
  await page.evaluate(() => { (window as any).controlsEditor.view.scrollDOM.scrollTop = 0; }); await settle();
  assert.equal(await page.$('.meo-block-sticky-header:not([hidden])'), null);
  assert.equal(await page.$eval('.meo-mermaid-inline-preview .meo-mermaid-layout-btn', node => node === document.activeElement), true,
    'Leaving the sticky row returns focus to its ordinary layout action without scrolling');
  assert.deepEqual(errors, []);
  await page.evaluate(() => (window as any).controlsEditor.destroy());
  assert.equal(await page.$('.meo-mermaid-preview-controls'), null, 'Disposal removes the group');
  // Real width-dependent SVG layout and very wide diagrams need more than a
  // mocked aspect ratio: a Gantt rendered in a collapsed host is already cramped.
  await page.addScriptTag({ path: 'webview/dist/mermaid.min.js' });
  const wideSource = 'flowchart LR\n  A[需求] --> B[调研] --> C[设计] --> D[评审] --> E[开发] --> F[测试] --> G[修订] --> H[验收] --> I[交付] --> J[归档]';
  const ganttSource = 'gantt\n  title 示例项目计划\n  dateFormat YYYY-MM-DD\n  axisFormat %m-%d\n  section 设计\n  调研 :done, a1, 2026-10-01, 3d\n  方案 :done, a2, after a1, 4d\n  section 实施\n  开发 :active, b1, after a2, 8d\n  测试 :b2, after b1, 5d\n  section 交付\n  验收 :milestone, c1, after b2, 0d';
  for (const width of [520, 1100]) for (const light of [false, true]) {
    await page.setViewport({ width, height: 850 });
    for (const [name, source] of [['wide', wideSource], ['gantt', ganttSource]]) {
      await page.evaluate(({ source, light }) => {
        const host = window as any;
        host.controlsEditor?.destroy(); document.querySelector('#app')!.replaceChildren();
        document.documentElement.dataset.editorAppearance = light ? 'light' : 'dark';
        document.documentElement.style.setProperty('--meo-code-background', light ? '#f0f1f3' : '#2e333b');
        host.MermaidEditingHarness.refreshMermaidTheme();
        host.controlsEditor = host.BlockStickyHeaderHarness.createEditor({ parent: document.querySelector('#app'),
          text: 'Before\n\n```mermaid\n' + source + '\n```\n\nAfter', initialMode: 'live', onApplyChanges() {} });
      }, { source, light });
      await page.waitForSelector('.meo-mermaid-block svg'); await settle();
      const reading = await page.evaluate(() => {
        const chart = document.querySelector('.meo-mermaid-block')!, svg = chart.querySelector<SVGSVGElement>('svg')!;
        const toolbar = document.querySelector('.meo-mermaid-toolbar')!;
        const ticks = Array.from(svg.querySelectorAll('.tick text'), node => node.getBoundingClientRect()).filter(r => r.width > 0).sort((a, b) => a.left - b.left);
        return { chartWidth: chart.clientWidth - 24, svgWidth: svg.getBoundingClientRect().width,
          intrinsicWidth: svg.viewBox.baseVal.width, background: getComputedStyle(toolbar).backgroundColor,
          surface: getComputedStyle(chart).backgroundColor,
          tasks: Array.from(svg.querySelectorAll<SVGElement>('rect.task')).map(bar => {
            const label = svg.querySelector<SVGElement>(`[id="${bar.id}-text"]`)!;
            return { background: getComputedStyle(bar).fill, foreground: getComputedStyle(label).fill,
              outside: /taskTextOutside/.test(label.getAttribute('class') ?? '') };
          }),
          overlappingTicks: ticks.filter((r, i) => i > 0 && r.left < ticks[i - 1]!.right - 1).length };
      });
      assert.equal(reading.background, reading.surface, `${name}/${width}/${light}: reading actions mask panned diagram content`);
      assert.notEqual(reading.background, 'rgba(0, 0, 0, 0)');
      if (name === 'gantt') {
        assertReadableMermaidTasks(reading.tasks, `Live Gantt/${width}/${light}`);
        assert.ok(reading.intrinsicWidth >= 1000, 'Gantt has a usable logical layout width before being scaled');
        assert.ok(reading.svgWidth >= reading.chartWidth * 0.9, 'Gantt uses the available block width');
        assert.equal(reading.overlappingTicks, 0, 'Gantt date labels remain separated');
        if (width === 1100) await page.screenshot({ path: `.local/mermaid-controls/gantt-${light ? 'light' : 'dark'}.png` });
      }
      await page.$eval('.meo-mermaid-mode-btn', node => (node as HTMLElement).click()); await settle();
      const beforeZoom = await page.$eval('.meo-mermaid-editing-preview .meo-mermaid-block', node => node.getBoundingClientRect().height);
      for (let step = 0; step < 6; step++) await page.$eval(dock + ' button:first-child', node => (node as HTMLElement).click());
      await settle();
      const zoomed = await page.$eval('.meo-mermaid-editing-preview .meo-mermaid-block', node => {
        const chart = node.getBoundingClientRect(), graph = node.querySelector('svg')!.getBoundingClientRect();
        return { height: chart.height, graphHeight: graph.height, graphCenter: (graph.top + graph.bottom) / 2,
          chartCenter: (chart.top + chart.bottom) / 2 };
      });
      assert.equal(zoomed.height, beforeZoom, 'Zoom does not rearrange the document');
      assert.ok(zoomed.height >= 240, 'Stacked editing keeps a usable canvas for zoom and pan');
      if (name === 'wide') {
        assert.ok(zoomed.height > zoomed.graphHeight, 'A wide graph remains vertically visible at maximum zoom');
        assert.ok(Math.abs(zoomed.graphCenter - zoomed.chartCenter) < 1, 'Wide graph stays centered in its canvas');
        if (width === 1100) await page.screenshot({ path: `.local/mermaid-controls/wide-zoom-${light ? 'light' : 'dark'}.png` });
      }
      if (width === 1100) {
        await page.$eval('.meo-mermaid-layout-btn', node => (node as HTMLElement).click()); await settle();
        const inline = await page.$eval('.meo-mermaid-inline-preview', node => ({ height: node.getBoundingClientRect().height,
          chartHeight: node.querySelector('.meo-mermaid-block')!.getBoundingClientRect().height }));
        assert.ok(inline.chartHeight <= inline.height, 'Side preview keeps its existing bounded canvas');
      }
    }
  }
  assert.deepEqual(errors, []);
  await page.evaluate(() => (window as any).controlsEditor.destroy());
  console.log('Mermaid visible controls passed: reading/editing states, current labels and fixed width, short/tall/scroll/split/narrow/transform/fullscreen/hidden/disposal and layout stability');
} catch (error) {
  primary = error;
} finally {
  if (primary === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primary);
}
