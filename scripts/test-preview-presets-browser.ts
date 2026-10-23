import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';
import { createCustomPreviewPreset, parseCustomPreviewPresetManifest } from '../src/foundation/customPreviewPreset';
import type { PreviewPresetDefinition } from '../src/foundation/previewPresets';

const build = await Bun.build({ entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const bundle = await build.outputs[0]!.text();
const text = [
  '---', '111: aaa', '222: bbb', '333: ccc', '444: ddd', '555: eee', '666: fff', '---', '',
  '# Preview presets', '', 'first', 'second', '', '<!-- retained default comment -->', '',
  '> [!NOTE]', '> A GitHub reading style.', '', '- [x] Ready', '- [ ] Pending', '',
  '```typescript', 'const answer = { value: 42 };', 'console.log(answer.value);', '```', '',
  '<kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd>', '',
  'A footnote.[^sample]', '',
  '```mermaid', 'flowchart LR', '  A[Markdown] --> B[Preview]', '```', '',
  '| Name | Description |', '| --- | --- |', '| GitHub | Repository documentation |', '',
  ...Array.from({ length: 60 }, (_, index) => `## Section ${index}\n\nReading paragraph ${index} with **bold** and a [link](https://example.com).\n`),
  '[^sample]: A footnote with a [link](https://example.com).'
].join('\n');
const init = {
  type: 'init', documentId: 'file:///preview-presets.md', text, version: 1, savedRevision: { version: 1, text },
  diagnostics: [], mode: 'preview', uiLanguage: 'zh-CN', sourceLineNumbers: 'on', previewAppearance: 'light',
  previewFontFamily: 'Georgia', previewSourceColoring: false, previewShowComments: true, editorAppearance: 'dark',
  gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit',
  fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false,
  findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, vscodeTheme: null
};
const browser = await launchTestBrowser();
try {
  let nextDelay = 0;
  const errors: string[] = [];
  const open = async (state: unknown = undefined, customPreviewPresets: readonly PreviewPresetDefinition[] = [], uiLanguage: 'en' | 'zh-CN' = 'zh-CN') => {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    await page.setViewport({ width: 1400, height: 760 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: 'webview/src/styles.css' });
    await page.exposeFunction('__renderPreset', async (message: any) => {
      if (message.type !== 'requestPreviewRender') return null;
      const delay = nextDelay;
      nextDelay = 0;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      return { type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value: exportRuntime.renderPreviewDocument({
        markdownText: message.text, sourceDocumentPath: 'C:/tmp/presets.md', uiLanguage: message.uiLanguage,
        styleEnvironment: message.environment, preset: message.preset, contentWidth: message.contentWidth,
        presetDefinition: customPreviewPresets.find(preset => preset.id === message.preset)
      }) } };
    });
    await page.addScriptTag({ content: `window.__presetState=${JSON.stringify(state ?? { sourcePreviewScrollSyncEnabled: false })};window.__presetMessages=[];window.acquireVsCodeApi=()=>({getState(){return window.__presetState},setState(state){window.__presetState=state},postMessage(message){window.__presetMessages.push(message);window.__renderPreset(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
    await page.addScriptTag({ path: 'webview/dist/mermaid.min.js' });
    await page.addScriptTag({ content: bundle });
    await page.evaluate(init => window.dispatchEvent(new MessageEvent('message', { data: init })), { ...init, uiLanguage, customPreviewPresets });
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.body?.textContent?.includes('Preview presets'));
    return page;
  };
  const page = await open();
  const previewLineHeight = async () => page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const paragraph = frame.contentDocument!.querySelector('.meo-export-doc p')!;
    const style = frame.contentWindow!.getComputedStyle(paragraph);
    return Math.round(parseFloat(style.lineHeight) / parseFloat(style.fontSize) * 10) / 10;
  });
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {data: {type: 'editorLineHeightChanged', value: 2.1}})));
  await page.waitForFunction(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame');
    const paragraph = frame?.contentDocument?.querySelector('.meo-export-doc p');
    if (!paragraph) return false;
    const style = frame!.contentWindow!.getComputedStyle(paragraph);
    return Math.abs(parseFloat(style.lineHeight) / parseFloat(style.fontSize) - 2.1) < .01;
  });
  assert.equal(await previewLineHeight(), 2.1, 'Default preview follows editor line spacing');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {data: {type: 'editorLineHeightChanged', value: 1.5}})));
  await page.evaluate(() => {
    (window as any).__sharedPreviewMenu = {
      panel: document.querySelector('.preview-options-panel'),
      controls: [...document.querySelectorAll('.preview-options-panel > .preview-select-control')]
    };
  });
  const waitFor = async (predicate: any, options: any = {}, ...args: any[]) => {
    try { return await page['waitForFunction'](predicate, options, ...args); } catch (error) {
      await page.screenshot({ path: 'tmp/preview-preset-failure.png' });
      const state = await page.evaluate(() => ({
        mode: document.querySelector<HTMLElement>('.editor-root')?.dataset.mode,
        preview: document.querySelector('.preview-host')?.outerHTML.slice(0, 140),
        split: document.querySelector('.source-preview-button')?.getAttribute('aria-pressed'),
        controls: Array.from(document.querySelectorAll<HTMLElement>('.preview-select-control')).map(element => ({ class: element.className, parent: element.parentElement?.className, hidden: element.hidden })),
        framePreset: document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement.dataset.meoPreviewPreset
      }));
      throw new Error(`Failed ${String(predicate)}: ${JSON.stringify(state)}`, { cause: error });
    }
  };
  const waitPreset = async (preset: string) => waitFor(preset => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement.dataset.meoPreviewPreset === preset, {}, preset);
  const choose = async (kind: 'preset' | 'width', value: string) => {
    const trigger = `.preview-${kind}-dropdown`;
    const overflowClosed = await page.$eval(trigger, element => element.closest<HTMLElement>('.toolbar-overflow-panel')?.hidden === true);
    if (overflowClosed) await page.click('.toolbar-overflow-indicator');
    try { await page.click(trigger); } catch (error) {
      await page.screenshot({ path: 'tmp/preview-preset-failure.png' });
      throw new Error(`Cannot choose ${kind}=${value}: ${JSON.stringify(await page.$eval(trigger, element => ({ parent: element.closest('.preview-select-control')?.parentElement?.className, mode: document.querySelector<HTMLElement>('.editor-root')?.dataset.mode, rect: element.getBoundingClientRect().toJSON() })))}`, { cause: error });
    }
    await page.click(`.preview-${kind}-dropdown-panel [data-value="${value}"]`);
  };
  const read = () => page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const root = doc.querySelector<HTMLElement>('.markdown-body')!;
    const style = doc.defaultView!.getComputedStyle(root);
    const code = doc.querySelector<HTMLElement>('.meo-export-code-line-source')!;
    return {
      preset: doc.documentElement.dataset.meoPreviewPreset, background: style.backgroundColor, font: style.fontFamily,
      comments: doc.body.textContent!.includes('retained default comment'), width: style.maxWidth,
      highlighted: doc.documentElement.dataset.meoPreviewSourceColoring === 'true' && Boolean(code.dataset.meoShiki), codeText: code.textContent,
      hidden: ['font-family-control', 'source-coloring', 'show-comments', 'width-control'].map(name => document.querySelector<HTMLElement>(`.preview-${name}`)!.hidden)
    };
  });
  const assertGithubVisuals = async (appearance: 'light' | 'dark') => {
    const beforeLineHeight = await previewLineHeight();
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {data: {type: 'editorLineHeightChanged', value: 2.1}})));
    assert.equal(await previewLineHeight(), beforeLineHeight, 'GitHub retains its own line spacing');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {data: {type: 'editorLineHeightChanged', value: 1.5}})));

    await waitFor((appearance: string) => {
      const block = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector<HTMLElement>('.meo-export-mermaid.is-rendered');
      return block?.dataset.meoPreviewMermaidAppearance === appearance && block.dataset.meoPreviewMermaidPreset === 'github-readme';
    }, {}, appearance);
    const actual = await page.evaluate(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const win = doc.defaultView!;
      const style = (selector: string) => win.getComputedStyle(doc.querySelector(selector)!);
      const svg = doc.querySelector('.meo-export-mermaid-svg svg')!.getBoundingClientRect();
      const diagram = doc.querySelector('.meo-export-mermaid')!.getBoundingClientRect();
      const scroller = doc.scrollingElement!;
      return {
        frontmatter: {
          rows: Array.from(doc.querySelector<HTMLTableElement>('.meo-export-frontmatter table')!.rows,
            row => Array.from(row.cells, cell => [cell.tagName, cell.textContent])),
          padding: style('.meo-export-frontmatter th').padding,
          border: [style('.meo-export-frontmatter td').borderTopWidth, style('.meo-export-frontmatter td').borderTopStyle, style('.meo-export-frontmatter td').borderTopColor],
          backgrounds: [1, 2].map(row => style(`.meo-export-frontmatter tr:nth-child(${row})`).backgroundColor),
          colors: ['th', 'td'].map(tag => style(`.meo-export-frontmatter ${tag}`).color),
          weights: ['th', 'td'].map(tag => style(`.meo-export-frontmatter ${tag}`).fontWeight)
        },
        keycap: [style('kbd').borderTopWidth, style('kbd').borderTopStyle, style('kbd').boxShadow],
        // These links have already passed through Preview's navigation binding.
        links: ['.footnote-ref a', '.footnote-backref', 'p a[data-meo-preview-href]:not([id])'].map(selector => {
          const link = doc.querySelector(selector)!;
          return [style(selector).color, style(selector).textDecorationLine, link.hasAttribute('href'), link.hasAttribute('data-meo-preview-href')];
        }),
        centerOffset: (svg.left + svg.right - diagram.left - diagram.right) / 2,
        diagramSize: (() => {
          const box = doc.querySelector<SVGSVGElement>('.meo-export-mermaid-svg svg')!.viewBox.baseVal;
          return [box.width, box.height];
        })(),
        diagramPadding: style('.meo-export-mermaid').paddingTop,
        nodeFill: style('.meo-export-mermaid-svg .node rect').fill,
        scrollbar: win.getComputedStyle(scroller).scrollbarColor,
        track: win.getComputedStyle(scroller, '::-webkit-scrollbar-track').backgroundColor,
        canScroll: scroller.scrollHeight > scroller.clientHeight,
        overflow: scroller.scrollWidth > scroller.clientWidth
      };
    });
    const linkColor = appearance === 'light' ? 'rgb(9, 105, 218)' : 'rgb(68, 147, 248)';
    const background = appearance === 'light' ? 'rgb(255, 255, 255)' : 'rgb(13, 17, 23)';
    const foreground = appearance === 'light' ? 'rgb(31, 35, 40)' : 'rgb(240, 246, 252)';
    assert.deepEqual(actual.frontmatter, {
      rows: [['111', 'aaa'], ['222', 'bbb'], ['333', 'ccc'], ['444', 'ddd'], ['555', 'eee'], ['666', 'fff']]
        .map(([key, value]) => [['TH', key], ['TD', value]]),
      padding: '6px 13px',
      border: ['1px', 'solid', appearance === 'light' ? 'rgb(209, 217, 224)' : 'rgb(61, 68, 77)'],
      backgrounds: [background, appearance === 'light' ? 'rgb(246, 248, 250)' : 'rgb(21, 27, 35)'],
      colors: [foreground, foreground],
      weights: ['600', '400']
    }, 'Frontmatter keeps GitHub key/value rows, borders, striping and text in both themes');
    assert.deepEqual(actual.keycap.slice(0, 2), ['1px', 'solid'], 'Keyboard keycaps keep their visible border');
    assert.notEqual(actual.keycap[2], 'none', 'Keyboard keycaps keep their bottom shadow');
    for (const link of actual.links) assert.deepEqual(link, [linkColor, 'underline', false, true], 'Bound Preview links retain GitHub colors and decoration');
    assert.ok(Math.abs(actual.centerOffset) < 1, `Mermaid must be centered: ${actual.centerOffset}`);
    assert.deepEqual(actual.diagramSize, [440, 152]);
    assert.equal(actual.diagramPadding, '0px');
    if (appearance === 'light') assert.equal(actual.nodeFill, 'rgb(236, 236, 255)');
    assert.ok(actual.scrollbar.endsWith(background), 'The scrollbar track must not expose the differently themed host');
    assert.equal(actual.track, background, 'The WebKit scrollbar fallback also has an opaque track');
    assert.ok(actual.canScroll && !actual.overflow);
  };
  await waitPreset('default');
  const readDiagram = () => page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const svg = doc.querySelector('.meo-export-mermaid.is-rendered svg')!;
    return { viewBox: svg.getAttribute('viewBox'), fill: doc.defaultView!.getComputedStyle(svg.querySelector('.node rect')!).fill };
  });
  await waitFor(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('.meo-export-mermaid.is-rendered svg'));
  const defaultDiagram = await readDiagram();
  const defaultScrollbar = await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    return doc.defaultView!.getComputedStyle(doc.scrollingElement!).scrollbarColor;
  });
  assert.ok((await read()).comments && (await read()).font.includes('Georgia'));
  assert.equal((await read()).highlighted, false);
  await choose('preset', 'github-readme');
  await waitPreset('github-readme');
  await waitFor(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector<HTMLElement>('.meo-export-code-line-source')?.dataset.meoShiki);
  let github = await read();
  assert.equal(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.querySelector('colgroup[data-meo-preview-columns]') === null), true);
  assert.deepEqual(github.hidden, [false, false, false, false]);
  assert.equal(await page.$eval('.preview-code-font-family-control', element => (element as HTMLElement).hidden), false, 'GitHub shows both fixed font controls');
  await page.click('.preview-options-trigger');
  assert.equal(await page.$$eval('.preview-options-panel button', buttons => buttons.every(button => (button as HTMLButtonElement).disabled)), true);
  assert.deepEqual(await page.$$eval('.preview-options-panel .preview-toolbar-dropdown-value', values => values.map(value => value.textContent)), ['由样式决定', '由样式决定', '适配面板']);
  for (const [selector, reason] of [
    ['.preview-font-family-dropdown', '字体由此预设的样式决定'], ['.preview-code-font-family-dropdown', '字体由此预设的样式决定'],
    ['.preview-width-dropdown', '正文宽度由此预设固定'],
    ['[data-preview-source-coloring="true"]', '此预设固定开启代码着色'], ['[data-preview-comments="false"]', '此预设固定隐藏 HTML 注释']
  ]) {
    await page.hover(selector!);
    await waitFor(reason => document.querySelector('.meo-tooltip.is-visible .meo-tooltip-label')?.textContent === reason, {}, reason);
    await page.click(selector!);
    assert.equal(await page.$eval('.meo-tooltip.is-visible .meo-tooltip-label', label => label.textContent), reason, 'Fixed preset controls keep their reason after a click');
    assert.equal(await page.$eval('.preview-options-panel', panel => (panel as HTMLElement).hidden), false);
  }
  await page.keyboard.press('Escape');
  assert.equal(github.comments, false);
  assert.equal(github.font.includes('Georgia'), false);
  assert.equal(github.background, 'rgb(13, 17, 23)');
  assert.equal(github.codeText, 'const answer = { value: 42 };');
  await page.click('[data-preview-appearance-choice="light"]');
  assert.equal((await read()).background, 'rgb(255, 255, 255)');
  await waitFor(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    const keyword = doc?.querySelector<HTMLElement>('.meo-export-code-line-source > span');
    return keyword && doc?.defaultView!.getComputedStyle(keyword).color === 'rgb(207, 34, 46)';
  }, { timeout: 5000 });
  await waitFor(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    return doc?.defaultView!.getComputedStyle(doc.querySelector('.markdown-body')!).maxWidth === '1076px';
  });
  mkdirSync('tmp', { recursive: true });
  await assertGithubVisuals('light');
  // Both presets are light: appearance alone cannot invalidate a retained diagram.
  await choose('preset', 'default');
  await waitPreset('default');
  await waitFor(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector<HTMLElement>('.meo-export-mermaid.is-rendered')?.dataset.meoPreviewMermaidPreset === 'default');
  assert.deepEqual(await readDiagram(), defaultDiagram);
  await choose('preset', 'github-readme');
  await waitPreset('github-readme');
  await assertGithubVisuals('light');
  await page.screenshot({ path: 'tmp/preview-github-light.png' });
  await page.click('[data-preview-appearance-choice="dark"]');
  await waitFor(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    const keyword = doc?.querySelector<HTMLElement>('.meo-export-code-line-source > span');
    return keyword && doc?.defaultView!.getComputedStyle(keyword).color === 'rgb(255, 123, 114)';
  }, { timeout: 5000 });
  await assertGithubVisuals('dark');
  await page.screenshot({ path: 'tmp/preview-github-dark.png' });
  // Keep a source anchor in view while switching between different typography.
  await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.querySelector('#section-20')!.scrollIntoView());
  await choose('preset', 'default');
  await waitPreset('default');
  const restored = await read();
  await waitFor(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector<HTMLElement>('.meo-export-mermaid.is-rendered')?.dataset.meoPreviewMermaidPreset === 'default');
  assert.deepEqual(await readDiagram(), defaultDiagram, 'GitHub Mermaid configuration and cached SVGs must not affect Default');
  assert.ok(restored.comments && restored.font.includes('Georgia'));
  assert.equal(restored.background, 'rgb(255, 255, 255)');
  assert.equal(restored.highlighted, false);
  assert.deepEqual(restored.hidden, [false, false, false, false]);
  assert.equal(await page.$eval('.preview-font-family-dropdown', button => (button as HTMLButtonElement).disabled), false);
  assert.equal(await page.$eval('.preview-width-dropdown', button => (button as HTMLButtonElement).disabled), true);
  assert.equal(await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    return doc.defaultView!.getComputedStyle(doc.scrollingElement!).scrollbarColor;
  }), defaultScrollbar, 'Switching back leaves the original Default scrollbar styling intact');
  assert.ok(await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const rect = doc.querySelector('#section-20')!.getBoundingClientRect();
    return rect.top > -200 && rect.top < 200;
  }), 'preset switches retain the reading anchor');
  await choose('preset', 'github-readme');
  await waitPreset('github-readme');
  assert.equal((await read()).width, '1076px');
  assert.equal((await read()).background, 'rgb(13, 17, 23)');
  // A host Default appearance update must not reset the active platform preference.
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'previewAppearanceChanged', appearance: 'light' } })));
  assert.equal((await read()).background, 'rgb(13, 17, 23)');
  await page.click('[data-preview-appearance-choice="auto"]');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'vscodeCodeThemeChanged', appearance: 'light', vscodeTheme: null } })));
  // Editor appearance is explicitly dark here; Auto follows it, not the host palette.
  assert.equal((await read()).background, 'rgb(13, 17, 23)');
  await page.click('.more-tools-wrapper > .format-button');
  await page.click('.editor-appearance-button[data-editor-appearance="light"]');
  assert.equal((await read()).background, 'rgb(255, 255, 255)');
  await page.click('.editor-appearance-button[data-editor-appearance="dark"]');
  assert.equal((await read()).background, 'rgb(13, 17, 23)');
  await page.click('.more-tools-wrapper > .format-button');
  nextDelay = 400;
  await choose('preset', 'default');
  await choose('preset', 'github-readme');
  await waitPreset('github-readme');
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal((await read()).preset, 'github-readme');
  await page.click('button[data-mode="source"]');
  await waitFor(() => document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === 'source'
    && (window as any).__presetMessages.findLast((message: any) => message.type === 'setMode')?.mode === 'source');
  if (await page.$eval('.source-preview-button', element => element.getAttribute('aria-pressed') !== 'true')) await page.click('.source-preview-button');
  await waitFor(() => document.querySelector('.source-preview-more-panel .preview-preset-control')
    && !document.querySelector<HTMLElement>('.preview-host')!.inert
    && getComputedStyle(document.querySelector<HTMLElement>('.preview-host')!).visibility !== 'hidden');
  await page.click('.source-preview-more-button');
  assert.equal(await page.evaluate(() => {
    const original = (window as any).__sharedPreviewMenu;
    const panel = document.querySelector('.source-preview-more-panel');
    return panel === original.panel && original.controls.every((control: HTMLElement) => control.parentElement === panel)
      && document.querySelectorAll('.preview-options-panel').length === 1;
  }), true, 'Full and split preview share one menu and the same option controls');
  assert.equal(await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('.preview-host')!;
    const panel = document.querySelector<HTMLElement>('.source-preview-more-panel')!;
    const styles = getComputedStyle(panel);
    return styles.color === host.style.getPropertyValue('--meo-preview-foreground')
      && styles.getPropertyValue('--meo-preview-background').trim() === host.style.getPropertyValue('--meo-preview-background');
  }), true, 'The portaled split menu retains the actual preview palette');
  assert.equal(await page.$eval('.source-preview-more-panel .preview-preset-control', control => {
    const dropdown = control.querySelector<HTMLElement>('.preview-preset-dropdown')!;
    const info = control.querySelector<HTMLElement>('.preview-preset-info')!;
    const row = control.getBoundingClientRect();
    return dropdown.getBoundingClientRect().width < row.width - 40
      && Math.abs(info.getBoundingClientRect().right - row.right) < 1;
  }), true, 'The split preset selector keeps content width and aligns to the right');
  mkdirSync('tmp/preview-toolbar', { recursive: true });
  await page.screenshot({ path: 'tmp/preview-toolbar/options-split-zh.png' });
  assert.equal(await page.$$eval('.source-preview-more-panel .preview-select-control', elements => elements.every(element => (element as HTMLElement).hidden ? element.getBoundingClientRect().height === 0 : element.getBoundingClientRect().height > 0)), true);
  await choose('preset', 'default');
  await waitPreset('default');
  await page.click('button[data-mode="preview"]');
  await waitFor(() => document.querySelector('.preview-format-group .preview-preset-control'));
  assert.equal(await page.evaluate(() => (window as any).__sharedPreviewMenu.panel === document.querySelector('.preview-options-panel')), true);
  await choose('preset', 'github-readme');
  await waitPreset('github-readme');
  await page.setViewport({ width: 480, height: 760 });
  await waitFor(() => !document.querySelector<HTMLElement>('.toolbar-overflow-indicator')!.hidden);
  await choose('preset', 'default');
  await waitPreset('default');
  await choose('preset', 'github-readme');
  await waitPreset('github-readme');
  assert.equal(await page.$$eval('.preview-select-control[hidden]', elements => elements.every(element => getComputedStyle(element).display === 'none')), true);
  await assertGithubVisuals((await read()).background === 'rgb(255, 255, 255)' ? 'light' : 'dark');
  await page.click('button[data-mode="source"]');
  await waitFor(() => document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === 'source'
    && (window as any).__presetMessages.findLast((message: any) => message.type === 'setMode')?.mode === 'source');
  if (await page.$eval('.source-preview-button', element => element.getAttribute('aria-pressed') !== 'true')) await page.click('.source-preview-button');
  await waitFor(() => !document.querySelector<HTMLElement>('.preview-host')!.inert && !document.querySelector<HTMLElement>('.preview-host')!.hidden);
  assert.equal(await page.$$eval('.source-preview-more-panel .preview-preset-control, .source-preview-more-panel .preview-font-family-control', elements => elements.length), 2);
  await page.click('button[data-mode="preview"]');
  await waitFor(() => document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === 'preview'
    && document.querySelector('.source-preview-more-panel .preview-preset-control') === null);
  await page.setViewport({ width: 1400, height: 760 });
  await waitFor(() => !document.querySelector('.toolbar-overflow-panel .preview-export-control'));
  // The snapshot carries the active preset and retains Default settings for Word.
  await page.hover('.preview-export-trigger');
  await page.click('.preview-export-menu-action[data-format="html"][data-include-table-of-contents="false"]');
  assert.ok(await page.evaluate(() => (window as any).__presetMessages.some((message: any) => message.type === 'exportDocument')));
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'requestExportSnapshot', requestId: 'preset-export' } })));
  await waitFor(() => (window as any).__presetMessages.some((message: any) => message.type === 'exportSnapshotResult'));
  const exported = await page.evaluate(() => (window as any).__presetMessages.findLast((message: any) => message.type === 'exportSnapshotResult'));
  assert.equal(exported.result.value.preset, 'github-readme');
  assert.equal(exported.result.value.appearance, 'dark');
  assert.equal(exported.result.value.environment.previewFontFamily, 'Georgia');
  assert.equal(exported.result.value.environment.previewSourceColoring, false);
  assert.equal(exported.result.value.environment.previewShowComments, true);
  const saved = await page.evaluate(() => (window as any).__presetState);
  assert.equal(saved.previewPresetState.preset, 'github-readme');
  const reopened = await open(saved);
  await reopened.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement.dataset.meoPreviewPreset === 'github-readme');
  assert.equal(await reopened.evaluate(() => (window as any).__presetMessages.findLast((message: any) => message.type === 'setPreviewPreset')?.preset), 'github-readme', 'Existing document choices migrate to Host startup memory');
  assert.equal(await reopened.$eval('.preview-width-control', element => (element as HTMLElement).hidden), false);
  assert.equal(await reopened.$eval('.preview-width-dropdown', element => (element as HTMLButtonElement).disabled), true);
  await page.bringToFront();
  // A stored GitHub preset must not change exports from editing surfaces.
  for (const mode of ['live', 'source']) {
    await page.click(`button[data-mode="${mode}"]`);
    await waitFor((mode: string) => document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === mode, {}, mode);
    if (mode === 'source' && await page.$eval('.source-preview-button', element => element.getAttribute('aria-pressed') === 'true')) {
      await page.click('.source-preview-button');
      await waitFor(() => document.querySelector<HTMLElement>('.preview-host')!.inert);
    }
    await page.evaluate(mode => window.dispatchEvent(new MessageEvent('message', { data: { type: 'requestExportSnapshot', requestId: `${mode}-export` } })), mode);
    await waitFor((mode: string) => (window as any).__presetMessages.some((message: any) => message.type === 'exportSnapshotResult' && message.requestId === `${mode}-export`), { timeout: 5000 }, mode);
    assert.equal(await page.evaluate(mode => (window as any).__presetMessages.findLast((message: any) => message.type === 'exportSnapshotResult' && message.requestId === `${mode}-export`).result.value.preset, mode), 'github-readme');
  }
  const fontPage = await open();
  const selectReadingPreset = async (id: string) => {
    await fontPage.select('.preview-preset-control select', id);
    await fontPage.waitForFunction(id => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement.dataset.meoPreviewPreset === id, {}, id);
  };
  await selectReadingPreset('newsprint');
  assert.equal(await fontPage.$eval('.preview-font-family-control select', element => (element as HTMLSelectElement).value), '');
  await fontPage.select('.preview-font-family-control select', 'Arial');
  await fontPage.waitForFunction(() => {
    const root = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('.meo-export-doc');
    return root && getComputedStyle(root).fontFamily.startsWith('Arial');
  });
  // Text existing in the DOM is insufficient: a zero-size ancestor used to hide every code line.
  for (const id of ['newsprint', 'whitey', 'obsidian-minimal']) {
    await selectReadingPreset(id);
    assert.ok(await fontPage.$eval('.preview-frame', frame => {
      const doc = (frame as HTMLIFrameElement).contentDocument!;
      const lines = [...doc.querySelectorAll('.meo-export-code-line-source')];
      return lines.length > 0 && lines.every(line => parseFloat(getComputedStyle(line).fontSize) > 0 && line.getBoundingClientRect().height > 0);
    }), `${id} displays its actual code text`);
  }
  await selectReadingPreset('newsprint');
  const codeFont = await fontPage.$eval('.preview-frame', frame => getComputedStyle((frame as HTMLIFrameElement).contentDocument!.querySelector('code')!).fontFamily);
  await selectReadingPreset('obsidian-minimal');
  assert.equal(await fontPage.$eval('.preview-font-family-control select', element => (element as HTMLSelectElement).value), '');
  await fontPage.select('.preview-font-family-control select', 'Georgia');
  await selectReadingPreset('newsprint');
  assert.equal(await fontPage.$eval('.preview-font-family-control select', element => (element as HTMLSelectElement).value), 'Arial');
  assert.equal(await fontPage.$eval('.preview-frame', frame => getComputedStyle((frame as HTMLIFrameElement).contentDocument!.querySelector('code')!).fontFamily), codeFont);
  assert.ok(!await fontPage.evaluate(() => (window as any).__presetMessages.some((message: any) => message.type === 'setPreviewFontFamily')), 'Preset font overrides never write Default settings');
  const fontSaved = await fontPage.evaluate(() => (window as any).__presetState);
  const fontReopened = await open(fontSaved);
  await fontReopened.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement.dataset.meoPreviewPreset === 'newsprint');
  assert.equal(await fontReopened.$eval('.preview-font-family-control select', element => (element as HTMLSelectElement).value), 'Arial');
  await fontPage.select('.preview-font-family-control select', '');
  await fontPage.waitForFunction(() => {
    const root = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('.meo-export-doc');
    return root && !getComputedStyle(root).fontFamily.startsWith('Arial');
  });
  await selectReadingPreset('default');
  assert.equal(await fontPage.$eval('.preview-font-family-control select', element => (element as HTMLSelectElement).value), 'Georgia');
  await fontPage.close();
  await fontReopened.close();
  for (const language of ['zh-CN', 'en'] as const) {
    const whiteyPage = await open(undefined, [], language);
    await whiteyPage.select('.preview-preset-control select', 'whitey');
    const waitWhitey = async (appearance: 'light' | 'dark') => whiteyPage.waitForFunction(appearance => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
      const root = doc?.querySelector('.meo-export-doc');
      const diagram = doc?.querySelector<HTMLElement>('.meo-export-mermaid.is-rendered');
      return root && doc?.defaultView?.getComputedStyle(root).backgroundColor === (appearance === 'dark' ? 'rgb(30, 34, 42)' : 'rgb(254, 254, 254)')
        && diagram?.dataset.meoPreviewMermaidPreset === 'whitey' && diagram.dataset.meoPreviewMermaidAppearance === appearance;
    }, {}, appearance);
    assert.equal(await whiteyPage.$eval('.preview-appearance-select', element => (element as HTMLSelectElement).value), 'auto');
    await waitWhitey('dark');
    await whiteyPage.click('[data-preview-appearance-choice="light"]');
    await waitWhitey('light');
    const whiteyTypography = async () => whiteyPage.$eval('.preview-frame', frame => {
      const doc = (frame as HTMLIFrameElement).contentDocument!;
      return ['.meo-export-doc', 'h1', 'h2', 'pre.meo-export-code-block', 'th', 'td'].map(selector => {
        const style = doc.defaultView!.getComputedStyle(doc.querySelector(selector)!);
        return [style.fontFamily, style.fontSize, style.lineHeight, style.fontWeight, style.padding, style.maxWidth, style.textAlign];
      });
    });
    const lightTypography = await whiteyTypography();
    assert.equal(await whiteyPage.$$eval('[data-preview-appearance-choice]', buttons => buttons.every(button => !(button as HTMLButtonElement).disabled)), true);
    await whiteyPage.screenshot({ path: `tmp/whitey-${language}-light.png` });
    await whiteyPage.click('[data-preview-appearance-choice="dark"]');
    await waitWhitey('dark');
    assert.deepEqual(await whiteyTypography(), lightTypography, 'Whitey appearance changes preserve manuscript typography');
    const colors = await whiteyPage.$eval('.preview-frame', frame => {
      const doc = (frame as HTMLIFrameElement).contentDocument!;
      const style = (selector: string) => doc.defaultView!.getComputedStyle(doc.querySelector(selector)!);
      return { text: style('.meo-export-doc').color, link: style('a').color, code: style('pre.meo-export-code-block').backgroundColor, heading: style('h1').textAlign };
    });
    assert.deepEqual(colors, { text: 'rgb(206, 207, 207)', link: 'rgb(79, 179, 255)', code: 'rgb(1, 31, 75)', heading: 'center' });
    await whiteyPage.screenshot({ path: `tmp/whitey-${language}-dark.png` });
    await whiteyPage.click('.preview-options-trigger');
    await whiteyPage.click('[data-preview-source-coloring="true"]');
    await whiteyPage.click('.preview-options-trigger');
    await whiteyPage.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector<HTMLElement>('.meo-export-code-line-source')?.dataset.meoShiki);
    await whiteyPage.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'requestExportSnapshot', requestId: 'whitey-dark-export' } })));
    await whiteyPage.waitForFunction(() => (window as any).__presetMessages.some((message: any) => message.type === 'exportSnapshotResult' && message.requestId === 'whitey-dark-export'));
    const snapshot = await whiteyPage.evaluate(() => (window as any).__presetMessages.findLast((message: any) => message.type === 'exportSnapshotResult' && message.requestId === 'whitey-dark-export').result.value);
    assert.equal(snapshot.preset, 'whitey');
    assert.equal(snapshot.appearance, 'dark');
    const whiteySaved = await whiteyPage.evaluate(() => (window as any).__presetState);
    const whiteyReopened = await open(whiteySaved, [], language);
    await whiteyReopened.waitForFunction(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
      return doc?.documentElement.dataset.meoPreviewPreset === 'whitey' && doc.defaultView!.getComputedStyle(doc.querySelector('.meo-export-doc')!).backgroundColor === 'rgb(30, 34, 42)';
    });
    await whiteyReopened.close();
    await whiteyPage.click('[data-preview-appearance-choice="auto"]');
    await whiteyPage.click('.more-tools-wrapper > .format-button');
    await whiteyPage.click('.editor-appearance-button[data-editor-appearance="light"]');
    await waitWhitey('light');
    await whiteyPage.click('.editor-appearance-button[data-editor-appearance="dark"]');
    await waitWhitey('dark');
    await whiteyPage.click('.more-tools-wrapper > .format-button');
    await whiteyPage.click('[data-mode="source"]');
    await whiteyPage.waitForSelector('.source-preview-button', { visible: true });
    if (await whiteyPage.$eval('.source-preview-button', button => button.getAttribute('aria-pressed') !== 'true')) await whiteyPage.click('.source-preview-button');
    await whiteyPage.waitForFunction(() => !document.querySelector<HTMLElement>('.preview-host')!.inert);
    await waitWhitey('dark');
    await whiteyPage.close();
  }
  const invalidCodePreset = createCustomPreviewPreset(parseCustomPreviewPresetManifest({
    schemaVersion: 1, id: 'invalid-code-size', name: 'Invalid code size', description: 'Readability fallback test',
    themes: { light: { css: 'light.css' }, dark: { css: 'dark.css' } }
  }), { light: '.meo-export-doc .meo-export-code-line { font-size: 0 !important; line-height: 0 !important; }', dark: '' }, 'd'.repeat(64));
  const fallbackPage = await open(undefined, [invalidCodePreset]);
  await fallbackPage.select('.preview-preset-control select', invalidCodePreset.id);
  await fallbackPage.click('[data-preview-appearance-choice="light"]');
  await fallbackPage.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('[data-meo-code-typography-fallback]'));
  assert.ok(await fallbackPage.$eval('.preview-frame', frame => [...(frame as HTMLIFrameElement).contentDocument!.querySelectorAll('.meo-export-code-line-source')].every(line => parseFloat(getComputedStyle(line).fontSize) > 0 && line.getBoundingClientRect().height > 0)));
  assert.equal(await fallbackPage.$eval('.preview-preset-info', element => element.classList.contains('has-error')), true);
  await fallbackPage.click('[data-preview-appearance-choice="dark"]');
  await fallbackPage.waitForFunction(() => !document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('[data-meo-code-typography-fallback]'));
  assert.equal(await fallbackPage.$eval('.preview-preset-info', element => element.classList.contains('has-error')), false);
  await fallbackPage.close();
  await page.close();
  await reopened.close();
  assert.deepEqual(errors, []);
  console.log('Preview preset switching, reading position, settings, split toolbar and persistence browser tests passed.');
} finally {
  await browser.close();
}
