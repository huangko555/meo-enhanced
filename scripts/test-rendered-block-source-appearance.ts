import { installPackagedMermaid } from './mermaid-runtime-test-helpers';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { assessLargeDocument } from '../src/foundation/largeDocument';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-mermaid-editing-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<!doctype html><meta charset="UTF-8"><style>html,body,#app{height:100%;margin:0}</style><div id="app" class="editor-host"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  const katexDirectory = 'node_modules/katex/dist';
  await page.addStyleTag({ content: fs.readFileSync(path.join(katexDirectory, 'katex.min.css'), 'utf8').replace(/url\((fonts\/[^)]+)\)/g, (_match, file) =>
    `url(data:font/${path.extname(file).slice(1)};base64,${fs.readFileSync(path.join(katexDirectory, file)).toString('base64')})`) });
  await page.addStyleTag({ content: ':root{--meo-font-live:Arial;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-size:16px;--meo-semantic-codeCopyBackground:transparent;--meo-semantic-codeCopyHoverBackground:rgba(127,127,127,.2)}' });
  await installPackagedMermaid(page);
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const settle = (count = 8) => page.evaluate(async count => {
    for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }, count);
  let layouts = 0;
  // Quotation rules and source/result dividers must paint independently, even
  // when the same rendered block carries both decorations.
  let dividers = 0;
  for (const large of [false, true]) for (const narrow of [true, false]) {
    await page.setViewport({ width: narrow ? 520 : 1100, height: 900 });
    const containers = [
      { name: 'quote', prefix: '> ', before: '' },
      { name: 'nested-quote', prefix: '> > ', before: '' },
      { name: 'quote-list', prefix: '>   ', before: '> - Item\n>\n' },
      { name: 'list-quote', prefix: '  > ', before: '- Item\n\n' },
      { name: 'alert', prefix: '> ', before: '> [!NOTE]\n>\n' },
      { name: 'footnote-quote', prefix: '    > ', before: 'Reference[^note].\n\n[^note]: Note\n\n' },
      { name: 'plain', prefix: '', before: '' },
      { name: 'list', prefix: '  ', before: '- Item\n\n' }
    ];
    for (const container of containers) for (const kind of ['html', 'math'] as const) {
      const block = kind === 'math' ? '$$\nx^2 + 1\n$$' : '<div>Divider content</div>';
      const text = 'Before\n\n' + container.before + block.split('\n').map(line => container.prefix + line).join('\n')
        + '\n\nAfter\n\n' + (large ? 'Background paragraph.\n\n'.repeat(12000) : '');
      const label = `${large ? 'large' : 'ordinary'}/${narrow ? 'narrow-dark-zh' : 'wide-light-en'}/${container.name}/${kind}`;
      assert.equal(assessLargeDocument(text).boundedEditorWork, large, label + ': production size policy');
      await page.evaluate(({ text, narrow }) => {
        const host = window as any;
        host.appearanceEditor?.destroy(); document.querySelector('#app')!.replaceChildren();
        document.documentElement.style.setProperty('--vscode-editor-background', narrow ? '#24292e' : '#ffffff');
        document.documentElement.style.setProperty('--vscode-editor-foreground', narrow ? '#e6edf3' : '#24292e');
        document.documentElement.style.setProperty('--meo-foreground', narrow ? '#e6edf3' : '#24292e');
        document.documentElement.style.setProperty('--meo-semantic-blockquoteForeground', narrow ? '#abb5be' : '#586069');
        host.MermaidEditingHarness.applyUiTheme(narrow ? 'dark' : 'light', true);
        host.appearanceEditor = host.MermaidEditingHarness.createEditor({ parent: document.querySelector('#app'),
          text, initialMode: 'live', uiLanguage: narrow ? 'zh-CN' : 'en', onApplyChanges() {} });
      }, { text, narrow });
      await settle();
      assert.equal(await page.evaluate(() => (window as any).MermaidEditingHarness.usesLargeDocumentDerivedWorkBudget(
        (window as any).appearanceEditor.view.state)), large, label + ': actual derived-work budget');
      const selector = kind === 'math' ? '.meo-math-live-result' : '.meo-md-html-live-result';
      await page.evaluate(kind => {
        const view = (window as any).appearanceEditor.view;
        view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf(kind === 'math' ? 'x^2' : 'Divider content') + 1 } });
        view.focus();
      }, kind);
      await page.waitForSelector(selector);
      const samples = await page.evaluate(async selector => {
        const samples = [];
        for (let i = 0; i < 8; i++) {
          await new Promise(requestAnimationFrame);
          const root = document.querySelector<HTMLElement>(selector)!;
          const divider = getComputedStyle(root, '::after');
          const quote = getComputedStyle(root.closest('.meo-live-quoted-block') ?? root, '::before');
          const bounds = root.getBoundingClientRect();
          samples.push({ left: parseFloat(divider.left), top: parseFloat(divider.top), width: parseFloat(divider.width),
            border: divider.borderTopWidth, quoteBorder: quote.borderTopWidth,
            quoteLeft: parseFloat(quote.left), quoteBackground: quote.backgroundImage,
            widthMatches: Math.abs(parseFloat(divider.width) - bounds.width) < 1,
            label: root.querySelector('.meo-math-result-status,.meo-md-html-result-status')?.textContent });
        }
        return samples;
      }, selector);
      assert.ok(samples.every(s => s.left === 0 && s.top === 8 && s.border === '1px' && s.widthMatches),
        label + ': source/result divider stays inside its panel in every frame: ' + JSON.stringify(samples));
      assert.ok(samples.every(s => s.quoteBorder === '0px'), label + ': quotation rule must not inherit the horizontal divider');
      if (kind === 'math' && container.prefix.includes('>')) assert.ok(samples.every(s => s.quoteLeft < 0 && s.quoteBackground !== 'none'),
        label + ': quotation rules remain outside the panel: ' + JSON.stringify(samples));
      assert.equal(samples.at(-1)!.label, narrow ? '预览' : 'Preview', label);
      assert.equal(await page.evaluate(() => (window as any).appearanceEditor.getText()), text, label + ': presentation preserves source');
      if (!large && container.name === 'nested-quote') {
        fs.mkdirSync('.local/rendered-block-source', { recursive: true });
        const points = await page.$eval(selector, root => {
          const label = root.querySelector('.meo-math-result-status,.meo-md-html-result-status')!.getBoundingClientRect();
          return { inside: Math.floor(label.left + 3), outside: Math.floor(label.left - 3),
            y: Math.round(root.getBoundingClientRect().top + 8) };
        });
        const png = await page.screenshot({ path: `.local/rendered-block-source/divider-${kind}-${narrow ? 'dark-zh' : 'light-en'}.png` });
        const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x + 1) * info.channels)];
        assert.deepEqual(pixel(points.inside, points.y), pixel(points.inside, points.y + 3),
          label + ': preview label masks the divider behind its padding');
        assert.notDeepEqual(pixel(points.outside, points.y), pixel(points.outside, points.y + 3),
          label + ': divider remains visible beside the label');
      }
      dividers++;
    }
  }
  console.log(`Source/result dividers passed (${dividers} container/size/appearance cases)`);
  for (const light of [false, true]) {
    for (const narrow of [false, true]) {
      const profile = `${light ? 'light' : 'dark'}-${narrow ? 'narrow' : 'wide'}`;
      await page.setViewport({ width: narrow ? 520 : 1100, height: 1100 });
      await page.evaluate(({ light, narrow }) => {
        const host = window as any;
        host.appearanceEditor?.destroy();
        document.querySelector('#app')!.replaceChildren();
        document.documentElement.dataset.editorAppearance = light ? 'light' : 'dark';
        for (const [name, value] of Object.entries({
          '--meo-background': light ? '#fafafa' : '#24292e', '--meo-foreground': light ? '#24292e' : '#e6edf3',
          '--meo-code-background': light ? '#f0f1f3' : '#1b2024', '--meo-semantic-mutedForeground': light ? '#586069' : '#8b949e',
          '--meo-code-action-foreground': light ? '#586069' : '#abb5be', '--meo-code-action-hover-foreground': light ? '#24292e' : '#fff'
        })) document.documentElement.style.setProperty(name, value);
        host.MermaidEditingHarness.refreshMermaidTheme();
        host.MermaidEditingHarness.applyCodeTheme(light ? 'light' : 'dark');
        host.appearanceEditor = host.MermaidEditingHarness.createEditor({
          parent: document.querySelector('#app'),
          text: '# Shared blocks\n\n```js\nconst first = 1;\nconst second = 2;\n```\n\n```mermaid\nflowchart LR\n A[脚注数据] --> B[分析] --> C[说明]\n```\n\n$$\nr = \\frac{6}{8} \\times 100\\% = 75\\%\n$$\n\nAfter'
            .split('\n').map(line => narrow ? '> ' + line : line).join('\n'),
          initialMode: 'live', onApplyChanges() {}
        });
      }, { light, narrow });
      await page.waitForSelector('.meo-mermaid-block svg');
      await settle();
      for (const mode of ['preview', 'stacked', 'side-by-side'] as const) {
        if (mode !== 'preview') {
          await page.evaluate(() => {
            document.querySelector<HTMLButtonElement>(document.querySelector('.meo-mermaid-toolbar')?.getAttribute('data-meo-mermaid-mode')==='edit'?'.meo-mermaid-layout-btn':'.meo-mermaid-mode-btn')!.click();
          });
          await settle(12);
        }
        await page.mouse.move(0, 0);
        await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
        await settle(12);
        // Frames can run faster than the hover transition on high-refresh
        // displays. Inspect the idle palette only after that transition ends.
        await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>(
          ':is(.meo-code-block-actions,.meo-mermaid-toolbar,.meo-latex-math-toolbar) :is([role="button"],button)'
        )).filter(control => control.getBoundingClientRect().width > 0)
          .every(control => getComputedStyle(control).backgroundColor === 'rgba(0, 0, 0, 0)'));
        const geometry = await page.evaluate(() => {
          const rect = (element: Element) => element.getBoundingClientRect();
          const controls = Array.from(document.querySelectorAll<HTMLElement>(':is(.meo-code-block-actions,.meo-mermaid-toolbar,.meo-latex-math-toolbar) :is([role="button"],button)')).filter(el => rect(el).width > 0);
          const sources=Array.from(document.querySelectorAll<HTMLElement>('.cm-content > .cm-line.meo-md-code-block')).map(line=>({width:rect(line).width, font:getComputedStyle(line).fontFamily}));
          const joins = Array.from(document.querySelectorAll<HTMLElement>('.meo-mermaid-source-join')).map(line => {
            const preview = line.nextElementSibling!;
            return { radius: getComputedStyle(line).borderBottomLeftRadius,
              gap: rect(preview).top - rect(line).bottom,
              left: rect(preview).left - rect(line).left, right: rect(preview).right - rect(line).right,
              background: getComputedStyle(line).backgroundColor === getComputedStyle(preview).backgroundColor };
          });
          const previews = Array.from(document.querySelectorAll<HTMLElement>(':is(.meo-rendered-block-preview,.meo-mermaid-editing-preview)')).map(pane => {
            const root = pane.querySelector('.meo-mermaid-block,.meo-md-math-fenced-display')!;
            const canvas = root.querySelector('svg,.meo-latex-math-canvas')!;
            const blockRect = rect(root), canvasRect = rect(canvas);
            return { height: rect(pane).height, verticalOffset: (canvasRect.top + canvasRect.bottom - blockRect.top - blockRect.bottom) / 2 };
          });
          return { sources, joins, previews, buttons: controls.map(control => {
            const style = getComputedStyle(control);
            return { modeControl: control.matches('.meo-mermaid-mode-btn'), background: style.backgroundColor,
              width: rect(control).width, height: rect(control).height };
          }) };
        });
        assert.ok(geometry.buttons.length >= 3, `${profile}/${mode}: controls missing`);
        assert.equal(geometry.buttons.filter(button => button.modeControl).length, 1, `${profile}/${mode}: one cycle control must remain visible`);
        assert.ok(geometry.buttons.every(button => button.background === 'rgba(0, 0, 0, 0)' && button.width === 22 && button.height === 20), `${profile}/${mode}: inconsistent idle controls ${JSON.stringify(geometry.buttons)}`);
        if (mode !== 'preview') {
          const action = await page.$eval('.meo-native-source-preview-label .meo-mermaid-layout-btn', node => ({
            border: getComputedStyle(node).borderTopWidth, width: node.getBoundingClientRect().width,
            text: node.textContent, icon: node.querySelector('svg')!.getBoundingClientRect().toJSON()
          }));
          assert.ok(action.border === '0px' && action.width > 22 && action.text?.trim(),
            `${profile}/${mode}: compact layout action keeps its action caption without a permanent border`);
          assert.ok(Math.abs(action.icon.width - 15) < 1 && Math.abs(action.icon.height - 15) < 1,
            `${profile}/${mode}: layout icon keeps its toolbar size`);
        }
        assert.ok(geometry.previews.every(preview => Math.abs(preview.verticalOffset) <= 1), `${profile}/${mode}: content is not centered ${JSON.stringify(geometry.previews)}`);
        assert.ok(geometry.sources.every(source=>source.width>100),profile+'/'+mode+': native source retains usable width');
        if (mode !== 'preview' && (mode === 'stacked' || narrow)) {
          assert.equal(geometry.joins.length, 1, `${profile}/${mode}: inline source has one joined edge`);
          assert.ok(geometry.joins.every(join => join.radius === '0px' && join.background &&
            [join.gap, join.left, join.right].every(distance => Math.abs(distance) <= 1)),
            `${profile}/${mode}: source and preview form a continuous surface ${JSON.stringify(geometry.joins)}`);
        }
        await page.keyboard.press('Tab');
        const focusPaint = await page.evaluate(async () => {
          const controls = Array.from(document.querySelectorAll<HTMLElement>(':is(.meo-code-block-actions,.meo-mermaid-toolbar,.meo-latex-math-toolbar) :is([role="button"],button)')).filter(el => el.getBoundingClientRect().width > 0);
          const paint: string[] = [];
          for (const control of controls) {
            if (!control.isConnected || control.matches(':disabled')) continue;
            control.focus();
            await new Promise(resolve => setTimeout(resolve, 220));
            if (!control.isConnected) continue;
            const style = getComputedStyle(control);
            paint.push(`${style.backgroundColor}|${style.backgroundImage}|${style.color}`);
          }
          (document.activeElement as HTMLElement)?.blur();
          return [...new Set(paint)];
        });
        assert.equal(focusPaint.length, 1, `${profile}/${mode}: different focus feedback ${JSON.stringify(focusPaint)}`);
        const math = await page.$eval('.meo-md-math-fenced-display', element => {
          const canvas = element.querySelector('.meo-latex-math-canvas')!.getBoundingClientRect();
          const root = element.getBoundingClientRect();
          return { background: getComputedStyle(element).backgroundColor,
            verticalOffset: (canvas.top + canvas.bottom - root.top - root.bottom) / 2,
            copy: element.querySelectorAll('.meo-copy-code-btn').length,
            shell: !!element.closest('.meo-rendered-block-preview') };
        });
        assert.ok(math.background === 'rgba(0, 0, 0, 0)' && Math.abs(math.verticalOffset) <= 1 && math.copy === 1 && !math.shell,
          `${profile}: math is ordinary centered document content ${JSON.stringify(math)}`);
        fs.mkdirSync('.local/rendered-block-source', { recursive: true });
        await page.hover('.meo-mermaid-mode-btn');
        await page.screenshot({ path: `.local/rendered-block-source/${profile}-${mode}.png` });
        layouts++;
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(`Rendered block source appearance passed (${layouts} layouts, real Mermaid/KaTeX)`);
} catch (error) { primaryError = error; }
if (primaryError === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primaryError);
