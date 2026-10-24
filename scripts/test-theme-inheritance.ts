import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import darkPlus from '@shikijs/themes/dark-plus';
import lightPlus from '@shikijs/themes/light-plus';
import githubDark from '@shikijs/themes/github-dark';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';
import { createHighlighter } from 'shiki';

const baseline = process.argv.includes('--baseline');
const nativeGrammar = process.env.MEO_VSCODE_MARKDOWN_GRAMMAR;
const output = path.resolve(process.env.MEO_THEME_OUTPUT ?? 'tmp/theme-acceptance');
fs.mkdirSync(output, { recursive: true });
const baselinePath = path.resolve('tmp/theme-content-before.json');
const contrastRatio = (foreground: string, background: string): number => {
  const luminance = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(channel => {
    const c = value.startsWith('color(srgb') ? channel : channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
const markdown = [
  '---', 'title: Theme acceptance', 'count: 42', 'enabled: true', 'tags: [one, two]', '---', '',
  '# 编辑器配色验收 · Heading', '',
  '正文 **加粗** *斜体* ~~删除线~~ `inline code` [链接](https://example.com "Title")。', '',
  '- 列表项目', '- [x] 已完成任务', '- [ ] 未完成任务', '1. 有序列表', '',
  '> 引用 **重点** 和 `code`', '',
  '| Name | Value |', '| --- | --- |', '| Alpha | 42 |', '',
  '```typescript', '// Comment', 'const count: number = 42;', 'function greet(name: string) { return "Hello " + name; }', '```', '',
  '<div class="sample">HTML &amp; text</div>', '',
  'Setext heading', '--------------', '',
  '[ref]: https://example.com "Reference"', '[Reference][ref] ![Image](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=)', '',
  '***', '', '转义 \\*文字\\* &amp; https://example.com', '',
  '==highlight== [[Wiki]] #tag [^note]', '', '[^note]: Footnote', '',
  '```python', 'def sample(value):', '    return value + 1', '```'
].join('\n');
const outlineMarkdown = [
  '# 产品说明', '多章节目录验收：对比缩进、细线、当前章节与悬停样式。', '',
  '## 阅读与编辑', '三种编辑模式共享同一个文档。', '',
  '### 实时模式', '保留当前正文、标题和强调样式。', '',
  '### 源码模式', '显示 Markdown 标记和主题语法颜色。', '',
  '## 正文元素', '', '### 链接与强调', '**加粗**、*斜体*、`inline code` 与 [示例链接](https://example.com)。', '',
  '### 列表与引用', '- 列表内容', '- [x] 已完成项目', '> 引用内容', '',
  '# 主题与外观', '菜单栏与分段控件要有清楚的明暗层次。', '',
  '## 菜单与控件', '', '### 分段切换', '检查外框、选中块和未选中文字。', '',
  '### 下拉菜单', '检查普通状态、选中状态与键盘焦点。', '',
  '## 目录导航', '', '### 章节层级', '一级、二级和三级标题保留原有层次。', '',
  '### 阅读范围', '淡色背景提示当前可见的章节范围。', '',
  '# 内容排版', '', '## 表格与代码', '', '### 表格内容', '| 项目 | 状态 |', '| --- | --- |', '| 配色检查 | 完成 |', '',
  '### 代码示例', '```typescript', 'const theme = "editor";', '```', '',
  '## 图片与公式', '', '### 图片布局', '检查正文与侧边目录的背景衔接。', '',
  '### 公式排版', '行内公式 $a^2+b^2=c^2$。', '',
  '# 导出与快捷键', '', '## 文件导出', '预览预设与内容样式保持原样。', '',
  '## 常用操作', '使用快捷键切换、搜索和编辑文档。'
].join('\n');
const profiles = [
  { id: 'dark', kind: 'dark', theme: darkPlus, background: '#1f1f1f', widget: '#202020', foreground: '#cccccc', menu: '#1f1f1f', selection: '#0078d4' },
  { id: 'light', kind: 'light', theme: lightPlus, background: '#ffffff', widget: '#f8f8f8', foreground: '#333333', menu: '#ffffff', selection: '#0060c0' },
  { id: 'github-dark', kind: 'dark', theme: githubDark, background: '#24292e', widget: '#1f2428', foreground: '#e1e4e8', menu: '#1f2428', selection: '#044289' },
  { id: 'contrast-dark', kind: 'high-contrast', theme: darkPlus, background: '#000000', widget: '#0c141f', foreground: '#ffffff', menu: '#0c141f', selection: '#1aebff' },
  { id: 'contrast-light', kind: 'high-contrast-light', theme: lightPlus, background: '#ffffff', widget: '#ffffff', foreground: '#292929', menu: '#ffffff', selection: '#0f4a85' },
  { id: 'dark-on-light', kind: 'light', manual: 'dark', theme: lightPlus, background: '#ffffff', widget: '#f8f8f8', foreground: '#333333', menu: '#ffffff', selection: '#0060c0' },
  { id: 'light-on-dark', kind: 'dark', manual: 'light', theme: darkPlus, background: '#1f1f1f', widget: '#202020', foreground: '#cccccc', menu: '#1f1f1f', selection: '#0078d4' },
  { id: 'custom-dark', kind: 'dark', theme: darkPlus, background: '#17222b', widget: '#21313c', foreground: '#e0edf5', menu: '#21313c', selection: '#206665' }
];
// Theme fixtures stay portable and fixed; an installed Markdown grammar may
// independently replace Shiki's reference grammar for native syntax comparison.
const build = await Bun.build({ entrypoints: [baseline ? 'scripts/test-preview-reading-surface-production-entry.ts' : 'scripts/test-theme-inheritance-entry.ts'], target: 'browser', format: 'iife',
  plugins: baseline ? [{ name: 'committed-baseline', setup(build) {
    build.onLoad({ filter: /\.[cm]?tsx?$/ }, args => {
      const relative = path.relative(process.cwd(), args.path).replaceAll('\\', '/');
      if (!relative.startsWith('webview/src/') && !relative.startsWith('src/')) return;
      const result = Bun.spawnSync(['git', 'show', 'HEAD:' + relative]);
      if (result.exitCode === 0) return { contents: result.stdout.toString(), loader: 'ts' };
    });
  } }] : [] });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const bundle = await build.outputs[0]!.text();
const browser = await launchTestBrowser();
const referenceLanguage = nativeGrammar ? 'markdown-reference' : 'markdown';
const reference = await createHighlighter({ themes: [], langs: [nativeGrammar ? { ...JSON.parse(fs.readFileSync(nativeGrammar, 'utf8')), name: referenceLanguage } : 'markdown', 'yaml', 'html', 'html-derivative', 'typescript', 'python'] });
const content: Record<string, unknown> = {};
const previewCodeFontRows: Record<string, { index: number; previousSize: string; expectedSize: string }[]> = {};
const errors: string[] = [];
try {
  const page = await browser.newPage();
  const screenshot = async (name: string) => {
    await page.evaluate(async () => {
      await Promise.all([...document.querySelectorAll('.segmented-control-button-indicator')]
        .flatMap(element => element.getAnimations()).map(animation => animation.finished.catch(() => undefined)));
    });
    await page.screenshot({ path: path.join(output, name) });
  };
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  await page.setViewport({ width: 1440, height: 1050 });
  await page.exposeFunction('__renderThemePreview', (message: any) => {
    if (message.type !== 'requestPreviewRender') return null;
    return { type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value: exportRuntime.renderPreviewDocument({
      markdownText: message.text, sourceDocumentPath: 'C:/tmp/theme.md', uiLanguage: message.uiLanguage,
      styleEnvironment: message.environment, preset: message.preset, contentWidth: message.contentWidth
    }) } };
  });
  for (const profile of profiles) {
    const light = profile.kind.includes('light');
    const appearance = light ? 'light' : 'dark';
    const theme = { name: profile.theme.name, type: appearance, colors: { ...profile.theme.colors, 'editor.foreground': profile.foreground, 'editor.background': profile.background }, tokenColors: profile.theme.tokenColors,
      ...(profile.id === 'custom-dark' ? { sourceColors: { ...profile.theme.colors, 'editor.foreground': profile.foreground }, sourceTokenColors: [...profile.theme.tokenColors, { scope: 'markup.heading.markdown punctuation.definition.heading.markdown', settings: { foreground: '#ff9933', fontStyle: '' } }, { scope: 'comment', settings: { foreground: '#92aebf', fontStyle: 'italic' } }] } : {})
    };
    const variables: Record<string, string> = {
      ...theme.colors,
      'editorWidget.background': profile.widget, 'editorWidget.foreground': profile.foreground,
      'menu.background': profile.menu, 'menu.foreground': profile.foreground, 'menu.border': light ? '#cecece' : '#454545',
      'menu.selectionBackground': profile.selection, 'menu.selectionForeground': profile.kind === 'high-contrast' ? '#000000' : '#ffffff', 'menu.selectionBorder': 'transparent',
      'dropdown.background': light ? '#ffffff' : '#313131', 'dropdown.foreground': profile.foreground, 'dropdown.border': light ? '#cecece' : '#454545',
      'dropdown.listBackground': profile.menu, 'input.background': light ? '#ffffff' : '#313131', 'input.foreground': profile.foreground,
      'input.border': light ? '#cecece' : '#454545', 'descriptionForeground': light ? '#666666' : '#9d9d9d',
      'focusBorder': profile.kind.includes('contrast') ? '#f38518' : profile.selection,
      'radio.activeBackground': profile.kind.includes('contrast') ? profile.background : light ? '#e1e4e8' : '#313131',
      'radio.activeForeground': profile.foreground, 'radio.activeBorder': profile.kind.includes('contrast') ? '#f38518' : 'transparent',
      'radio.inactiveBackground': profile.widget, 'radio.inactiveForeground': light ? '#6e6e6e' : '#9d9d9d', 'radio.inactiveBorder': 'transparent',
      'radio.inactiveHoverBackground': light ? '#e8e8e8' : '#2b2b2b',
      'toolbar.hoverBackground': light ? '#e8e8e8' : '#2b2b2b', 'toolbar.activeBackground': light ? '#dadada' : '#3a3a3a',
      'editorSuggestWidget.background': profile.menu, 'editorSuggestWidget.foreground': profile.foreground,
      'editorSuggestWidget.selectedBackground': profile.selection, 'editorSuggestWidget.selectedForeground': profile.kind === 'high-contrast' ? '#000000' : '#ffffff',
      'editorSuggestWidget.highlightForeground': light ? '#0066bf' : '#85b6ff', 'editorSuggestWidget.focusHighlightForeground': '#ffffff',
      'list.hoverBackground': light ? '#eeeeee' : '#2b2b2b', 'list.hoverForeground': profile.foreground,
      'list.activeSelectionBackground': profile.selection, 'list.activeSelectionForeground': profile.kind === 'high-contrast' ? '#000000' : '#ffffff',
      'editorLineNumber.foreground': light ? '#6e7681' : '#858585', 'editorLineNumber.activeForeground': profile.foreground,
      'editorCursor.foreground': profile.foreground, 'editor.selectionBackground': light ? '#add6ff' : '#264f78',
      'editor.lineHighlightBackground': light ? '#f4f4f4' : '#2a2a2a',
      ...(profile.kind.includes('contrast') ? { contrastBorder: '#f38518', contrastActiveBorder: '#f38518' } : {})
    };
    await page.setContent(`<!doctype html><style>html,body,#app{height:100%;margin:0}</style><body class="vscode-${profile.kind}"><div id="app"></div></body>`);
    await page.evaluate(variables => {
      const style = document.documentElement.style;
      for (const [id, value] of Object.entries(variables)) style.setProperty('--vscode-' + id.replace(/\./g, '-'), value);
      style.setProperty('--vscode-font-family', '"Segoe UI", sans-serif');
      style.setProperty('--vscode-editor-font-family', 'Consolas, monospace');
      style.setProperty('--vscode-editor-font-size', '15px');
      style.setProperty('--vscode-editor-font-weight', '400');
    }, variables);
    await page.addStyleTag({ content: baseline ? Bun.spawnSync(['git', 'show', 'HEAD:webview/src/styles.css']).stdout.toString() : fs.readFileSync('webview/src/styles.css', 'utf8') });
    await page.addScriptTag({ content: 'window.acquireVsCodeApi=()=>({getState(){return {}},setState(){},postMessage(message){window.__renderThemePreview(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent("message",{data:response}));});}});' });
    await page.addScriptTag({ content: bundle });
    await page.evaluate(init => window.dispatchEvent(new MessageEvent('message', { data: init })), {
      type: 'init', documentId: 'file:///theme.md', text: markdown, version: 1, savedRevision: { version: 1, text: markdown }, diagnostics: [],
      mode: 'live', uiLanguage: 'zh-CN', sourceLineNumbers: 'on', previewAppearance: 'auto', previewFontFamily: '', previewSourceColoring: false,
      previewShowComments: false, editorAppearance: 'manual' in profile ? profile.manual : 'auto', gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
      diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false,
      findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible: true, outlineWidth: 240, vscodeTheme: theme
    });
    await page.waitForSelector('.cm-editor');
    await page.waitForFunction(() => !document.querySelector('.meo-preload-editor-shell') && getComputedStyle(document.querySelector('.editor-root')!).opacity !== '0');
    await page.waitForFunction(() => [...document.querySelectorAll('.cm-line span[style]')].some(el => el.textContent?.includes('const')));
    content[profile.id + ':live'] = await page.evaluate(() => {
      const selectors = ['.meo-md-h1', '.meo-md-strong', '.meo-md-em', '.meo-md-inline-code', '.meo-md-quote', '.meo-md-table-cell', '.meo-md-code-block', '.meo-md-code-block span[style]', '.meo-copy-code-btn'];
      return Object.fromEntries(selectors.map(selector => [selector, [...document.querySelectorAll(selector)].map(el => {
        const s = getComputedStyle(el); return [el.textContent, s.color, s.backgroundColor, s.borderColor, s.fontSize, s.fontWeight, s.fontStyle];
      })]));
    });
    if (!baseline) {
      const surfaces = await page.evaluate(() => {
        const role = (name: string) => {
          const probe = document.createElement('span'); probe.style.color = `var(--meo-document-${name})`; document.body.append(probe);
          const value = getComputedStyle(probe).color; probe.remove(); return value;
        };
        return [
          ['.meo-md-code-block', 'backgroundColor', 'block'],
          ['.meo-md-inline-code', 'backgroundColor', 'inline'],
          ['.meo-copy-code-btn', 'color', 'action-text']
        ].flatMap(([selector, property, name]) => [...document.querySelectorAll(selector!)].map(element => ({
          selector, actual: getComputedStyle(element)[property as 'color'], expected: role(name!)
        })));
      });
      for (const surface of surfaces) assert.equal(surface.actual, surface.expected, `${profile.id}: ${surface.selector} consumes the shared document role`);
      const emphasis = await page.evaluate(() => {
        const probe = document.createElement('span'); probe.style.color = 'var(--meo-ui-text-emphasis-content)'; document.body.append(probe);
        const color = getComputedStyle(probe).color; probe.remove(); return color;
      });
      for (const row of (content[profile.id + ':live'] as Record<string, string[][]>)['.meo-md-h1']!) {
        assert.equal(row[1], emphasis, `${profile.id}: Live heading uses text emphasis`);
        assert.equal(row[3], emphasis, `${profile.id}: Live heading currentColor follows text emphasis`);
      }
      const copyRest = await page.$eval('.meo-copy-code-btn', element => getComputedStyle(element).color);
      // Startup syntax/layout can still settle after the first token appears.
      // Hover only once the real control has a stable viewport position.
      await page.locator('.meo-copy-code-btn').hover();
      await page.waitForFunction(() => document.querySelector('.meo-copy-code-btn')?.matches(':hover'));
      await page.$eval('.meo-copy-code-btn', async element => {
        await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => undefined)));
      });
      const copyHover = await page.$eval('.meo-copy-code-btn', element => {
        const style = getComputedStyle(element); return { color: style.color, background: style.backgroundColor, hovered: element.matches(':hover') };
      });
      assert.ok(copyHover.hovered && contrastRatio(copyHover.color, copyHover.background) > contrastRatio(copyRest, copyHover.background), `${profile.id}: block action hover strengthens foreground contrast (${JSON.stringify({ copyRest, ...copyHover })})`);
      await page.mouse.move(0, 0);
    }
    await screenshot(profile.id + '-live.png');
    await page.click('button[data-mode="preview"]');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === 'preview');
    await page.waitForFunction(() => !!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('h1'));
    const previewContent = await page.evaluate(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const elements = [...doc.querySelectorAll('body,h1,p,strong,em,code,code span,blockquote,table,th,td,pre')];
      const rows = elements.map(el => {
        const s = doc.defaultView!.getComputedStyle(el); return [el.tagName, el.textContent, s.color, s.backgroundColor, s.borderColor, s.fontSize, s.fontWeight, s.fontStyle];
      });
      return { rows, codeFonts: elements.flatMap((el, index) => !el.matches('pre') && el.closest('pre.meo-export-code-block')
        ? [{ index, previousSize: el.matches('code') ? '0px' : '15px', expectedSize: el.matches('code') ? '15px' : '13.2px' }] : []) };
    });
    content[profile.id + ':preview'] = previewContent.rows;
    previewCodeFontRows[profile.id + ':preview'] = previewContent.codeFonts;
    if (!baseline) for (const { index, expectedSize } of previewContent.codeFonts) {
      assert.equal(previewContent.rows[index]![5], expectedSize, `${profile.id}: code typography follows the editor basis and stays readable`);
    }
    await screenshot(profile.id + '-preview.png');
    await page.click('button[data-mode="source"]');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === 'source');
    if (!baseline) {
      const controls = await page.evaluate(() => {
        const read = (selector: string, property: 'color' | 'backgroundColor' | 'borderTopColor' = 'color') => getComputedStyle(document.querySelector(selector)!)[property];
        const role = (name: string) => {
          const probe = document.createElement('span'); probe.style.color = `var(${name})`; document.body.append(probe);
          const value = getComputedStyle(probe).color; probe.remove(); return value;
        };
        const button = document.querySelector('.source-preview-button')!;
        const inactive = read('.source-preview-button');
        button.classList.add('is-active');
        const active = read('.source-preview-button'), activeBackground = read('.source-preview-button', 'backgroundColor');
        button.classList.remove('is-active');
        return { inactive, active, activeBackground, icon: read('.source-preview-button > svg'),
          inline: read('.selection-inline-button'), menu: read('.preview-options-panel'), menuBackground: read('.preview-options-panel', 'backgroundColor'),
          muted: role('--meo-ui-text-muted'), foreground: role('--meo-ui-text'),
          selectedForeground: role('--meo-ui-text-selected'), selected: role('--meo-ui-surface-selected'),
          iconForeground: role('--meo-ui-text'), menuForeground: role('--meo-ui-text'), menuSurface: role('--meo-ui-surface-raised') };
      });
      assert.equal(controls.inactive, controls.foreground, `${profile.id}: Source preview button shares the ordinary toolbar foreground`);
      assert.equal(controls.active, controls.selectedForeground, `${profile.id}: Source preview button uses the selected foreground`);
      assert.equal(controls.activeBackground, controls.selected, `${profile.id}: Source preview button uses the selected surface`);
      assert.equal(controls.icon, controls.iconForeground, `${profile.id}: Source preview icon`);
      assert.equal(controls.inline, controls.menuForeground, `${profile.id}: selected-text toolbar button`);
      assert.equal(controls.menu, controls.menuForeground, `${profile.id}: shared Preview options menu text`);
      assert.equal(controls.menuBackground, controls.menuSurface, `${profile.id}: shared Preview options menu background`);
      const foregroundChannels = controls.foreground.match(/\d+/g)!.map(Number);
      assert.equal(foregroundChannels[0], foregroundChannels[1], `${profile.id}: ordinary UI foreground is neutral`);
      assert.equal(foregroundChannels[1], foregroundChannels[2], `${profile.id}: ordinary UI icons share the neutral foreground`);
      if (profile.id === 'dark') {
        const palette = await page.evaluate(() => {
          const root = document.documentElement, style = root.style;
          const read = () => Object.fromEntries([...style].filter(name => name.startsWith('--meo-ui-')).map(name => [name, style.getPropertyValue(name)]));
          const before = read(), oldMenu = style.getPropertyValue('--vscode-menu-background'), oldWidget = style.getPropertyValue('--vscode-editorWidget-background');
          const oldEmphasis = style.getPropertyValue('--meo-content-heading-input');
          const oldLink = style.getPropertyValue('--meo-content-link-input');
          const refresh = () => (window as any).ThemeAcceptance.refreshUiTheme();
          refresh(); const reused = read();
          style.setProperty('--vscode-menu-background', '#ff00ff'); refresh(); const independent = read();
          style.setProperty('--meo-content-heading-input', '#e886ff'); refresh(); const emphasisChanged = read();
          style.setProperty('--meo-content-heading-input', oldEmphasis);
          style.setProperty('--meo-content-link-input', '#77eedd'); refresh(); const linkChanged = read();
          style.setProperty('--meo-content-link-input', oldLink);
          style.setProperty('--vscode-editorWidget-background', '#122b38'); refresh(); const changed = read();
          style.setProperty('--vscode-menu-background', oldMenu); style.setProperty('--vscode-editorWidget-background', oldWidget); refresh();
          return { before, reused, independent, emphasisChanged, linkChanged, changed, restored: read() };
        });
        assert.deepEqual(palette.reused, palette.before, 'Reapplying identical inputs preserves all UI roles');
        assert.deepEqual(palette.independent, palette.before, 'Floating UI derives from the toolbar base independently of native menu fills');
        for (const [name, value] of Object.entries(palette.before)) {
          if (name.startsWith('--meo-ui-text-emphasis')) assert.notEqual(palette.emphasisChanged[name], value, `Text emphasis invalidates ${name}`);
          else assert.equal(palette.emphasisChanged[name], value, `Text emphasis must not recolor ${name}`);
          if (name === '--meo-ui-link' || name === '--meo-ui-link-background') assert.notEqual(palette.linkChanged[name], value, `Link input invalidates ${name}`);
          else assert.equal(palette.linkChanged[name], value, `Link input must not recolor ${name}`);
        }
        assert.notEqual(palette.changed['--meo-ui-surface'], palette.before['--meo-ui-surface'], 'Changing the shared base invalidates the resolved palette');
        assert.notEqual(palette.changed['--meo-ui-surface-raised'], palette.before['--meo-ui-surface-raised'], 'Floating UI follows the changed shared base');
        assert.deepEqual(palette.restored, palette.before, 'Restoring shared inputs restores the entire palette');
      }
      await page.waitForSelector('.meo-source-token', { timeout: 10000 }).catch(async error => {
        console.log(await page.evaluate(() => ({ mode: document.querySelector('.editor-root')?.getAttribute('data-mode'), lines: document.querySelectorAll('.cm-line').length, html: document.querySelector('.cm-editor')?.outerHTML.slice(0, 1200) })));
        throw error;
      });
      const sourceTheme = 'manual' in profile ? profile.manual === 'light' ? lightPlus : darkPlus : { ...theme, colors: 'sourceColors' in theme ? theme.sourceColors : theme.colors, tokenColors: 'sourceTokenColors' in theme ? theme.sourceTokenColors : theme.tokenColors };
      const referenceTheme = { ...structuredClone(sourceTheme), name: 'reference-' + profile.id };
      await reference.loadTheme(referenceTheme as any);
      const expected = reference.codeToTokens(markdown, { lang: referenceLanguage, theme: referenceTheme.name }).tokens;
      // Compare every rendered character against TextMate, rather than sampling a few guessed token groups.
      const readSourceLines = () => page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map(line => {
        const chars: { color: string; weight: string; italic: string; underline: string }[] = [];
        const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        while (walk.nextNode()) {
          const text = walk.currentNode; const s = getComputedStyle(text.parentElement!);
          for (let i = 0; i < text.textContent!.length; i++) chars.push({ color: s.color, weight: s.fontWeight, italic: s.fontStyle, underline: s.textDecorationLine });
        }
        return { index: (window as any).ThemeAcceptance.lineIndex(line), text: line.textContent, chars };
      }));
      const actual = await readSourceLines();
      await page.evaluate(() => { const scroller = document.querySelector<HTMLElement>('.cm-scroller')!; scroller.scrollTop = scroller.scrollHeight; });
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      actual.push(...await readSourceLines());
      for (const line of actual) {
        const index = line.index;
        if (index < 0) continue;
        const tokens = expected[index]!;
        let offset = 0;
        for (const token of tokens) for (let i = 0; i < token.content.length; i++) {
          const color = token.color!.replace('#', '');
          const rgb = `rgb(${parseInt(color.slice(0, 2), 16)}, ${parseInt(color.slice(2, 4), 16)}, ${parseInt(color.slice(4, 6), 16)})`;
          assert.equal(line.chars[offset]?.color, rgb, `${profile.id}: ${line.text} character ${offset}`);
          assert.equal(line.chars[offset]?.weight, token.fontStyle! & 2 ? '700' : '400', `${profile.id}: font weight ${line.text}:${offset}`);
          assert.equal(line.chars[offset]?.italic, token.fontStyle! & 1 ? 'italic' : 'normal', `${profile.id}: italic ${line.text}:${offset}`);
          assert.equal(line.chars[offset]?.underline.includes('underline'), !!(token.fontStyle! & 4), `${profile.id}: underline ${line.text}:${offset}`);
          assert.equal(line.chars[offset]?.underline.includes('line-through'), !!(token.fontStyle! & 8), `${profile.id}: strike ${line.text}:${offset}`);
          offset++;
        }
      }
      await screenshot(profile.id + '-source-tail.png');
      await page.evaluate(() => { document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop = 0; });
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      assert.equal(await page.$eval('.mode-toolbar', el => getComputedStyle(el).backgroundColor), await page.evaluate(() => {
        const probe = document.createElement('span'); probe.style.backgroundColor = 'var(--meo-ui-surface)'; document.body.append(probe);
        const color = getComputedStyle(probe).backgroundColor; probe.remove(); return color;
      }), `${profile.id}: toolbar uses the shared derived surface`);
    }
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-host')?.hidden === true && !document.querySelector('[data-preview-cover]'));
    await screenshot(profile.id + '-source.png');
    await page.click('.more-tools-wrapper > .format-button');
    if (!baseline) {
      const toolbar = await page.$eval('.mode-toolbar', el => getComputedStyle(el).backgroundColor);
      for (const selector of ['.toolbar-right', '.toolbar-overflow-indicator']) {
        assert.equal(await page.$eval(selector, el => getComputedStyle(el).backgroundColor), toolbar, `${profile.id}: ${selector} shares the toolbar surface`);
      }
      const knobs = await page.$$eval('.more-tools-panel .menu-switch', switches => {
        const probe = document.createElement('span'); probe.style.backgroundColor = 'var(--meo-ui-on-switch-off)'; document.body.append(probe);
        const off = getComputedStyle(probe).backgroundColor; probe.remove();
        return switches.map(el => ({ checked: el.parentElement?.getAttribute('aria-checked') === 'true',
          color: getComputedStyle(el, '::after').backgroundColor, shadow: getComputedStyle(el).boxShadow, off }));
      });
      assert.ok(knobs.length > 0);
      assert.ok(knobs.every(knob => knob.color === (knob.checked ? 'rgb(255, 255, 255)' : knob.off)), `${profile.id}: switches use white when on and derived gray when off`);
      assert.ok(knobs.every(knob => knob.shadow === 'none'), `${profile.id}: switches have no permanent outline`);
    }
    await screenshot(profile.id + '-menu.png');
    if (!baseline) {
      await page.click('.more-tools-settings-button');
      await page.waitForSelector('.settings-window[open]');
      await screenshot(profile.id + '-settings.png');
      await page.click('.settings-close');
      await page.click('button[data-mode="live"]');
      await page.waitForSelector('.cm-editor.meo-mode-live');
      await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-host')?.hidden === true);
      await page.hover('.table-wrapper > .format-button');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.table-dropdown-wrapper')!).opacity === '1');
      await page.hover('.table-grid-cell[data-row="3"][data-col="3"]');
      await screenshot(profile.id + '-table-insert.png');
      {
        await page.mouse.move(700, 450);
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.table-dropdown-wrapper')!).opacity === '0');
        await page.evaluate(() => {
          const text = '# 主题控件 **粗体** `代码`\n\n调色面板 #60A5FA 与 #60A5FA80\n\n- 普通列表正文\n  - 嵌套列表正文\n1. 有序列表正文\n\n[链接 **粗体**](https://example.com) 和脚注 [^note]\n\n| Name | Value |\n| --- | --- |\n| Alpha | [表格链接](https://example.com) |\n| List | - 表格列表<br>1. 表格编号 |\n\n[^note]: 脚注正文\n\n';
          (window as any).ThemeAcceptance.replaceText(text, 'end');
        });
        await page.waitForSelector('.meo-md-html-table-cell-preview .meo-md-link');
        const contentEmphasis = await page.evaluate(() => {
          const resolve = (name: string) => {
            const probe = document.createElement('span'); probe.style.color = `var(--meo-ui-${name})`; document.body.append(probe);
            const color = getComputedStyle(probe).color; probe.remove(); return color;
          };
          const selectors = ['.meo-md-heading-content', '.meo-md-h1 .meo-md-strong', '.meo-md-h1 .meo-md-inline-code',
            '.meo-md-list-marker-ordered', '.meo-md-link', '.meo-md-strong:is(.meo-md-link), .meo-md-link .meo-md-strong, .meo-md-strong .meo-md-link',
            '.meo-md-footnote-ref', '.meo-md-footnote-backref', '.meo-md-html-table-cell-preview .meo-md-link'];
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d')!;
          const footnoteBase = document.createElement('span'); footnoteBase.style.color = 'var(--meo-background)'; document.body.append(footnoteBase);
          const documentBackground = getComputedStyle(footnoteBase).color; footnoteBase.remove();
          return { expected: resolve('text-emphasis-content'), link: resolve('link'), colors: Object.fromEntries(selectors.map(selector => [selector,
            [...document.querySelectorAll(selector)].map(el => getComputedStyle(el).color)])),
            fills: [...document.querySelectorAll('.meo-md-list-marker-bullet-dot')].map(el => ({ fill: getComputedStyle(el).fill, stroke: getComputedStyle(el).stroke })),
            tableMarkers: [...document.querySelectorAll('.meo-md-html-table-cell-list > li')].map(el => getComputedStyle(el, '::marker').color),
            body: [...document.querySelectorAll('.cm-line')].filter(el => el.textContent?.includes('普通列表正文') || el.textContent?.includes('有序列表正文')).map(el => getComputedStyle(el).color),
            footnotes: [...document.querySelectorAll('.meo-md-footnote-ref, .meo-md-footnote-backref')].map(el => {
              const background = getComputedStyle(el).backgroundColor;
              context.clearRect(0, 0, 1, 1); context.fillStyle = documentBackground; context.fillRect(0, 0, 1, 1);
              context.fillStyle = background; context.fillRect(0, 0, 1, 1);
              return { background, expected: resolve('link-background'),
                carrier: `rgb(${[...context.getImageData(0, 0, 1, 1).data].slice(0, 3).join(', ')})` };
            }),
            backgrounds: ['--meo-background', '--meo-inline-code-background'].map(name => {
              const probe = document.createElement('span'); probe.style.color = `var(${name})`; document.body.append(probe);
              const color = getComputedStyle(probe).color; probe.remove(); return color;
            }) };
        });
        for (const [selector, colors] of Object.entries(contentEmphasis.colors)) {
          assert.ok(colors.length, `${profile.id}: ${selector} is rendered`);
          const expected = /link|footnote/.test(selector) ? contentEmphasis.link : contentEmphasis.expected;
          assert.ok(colors.every(color => color === expected), `${profile.id}: ${selector} shares content text emphasis (${colors.join(', ')}; expected ${contentEmphasis.expected})`);
        }
        assert.ok(contentEmphasis.fills.length && contentEmphasis.fills.every(value => value.fill === contentEmphasis.expected || value.stroke === contentEmphasis.expected), `${profile.id}: list bullet fills/strokes`);
        assert.ok(contentEmphasis.tableMarkers.length && contentEmphasis.tableMarkers.every(value => value === contentEmphasis.expected), `${profile.id}: table list markers`);
        assert.ok(contentEmphasis.body.every(color => color !== contentEmphasis.expected), `${profile.id}: list body keeps ordinary document color`);
        assert.ok(contentEmphasis.backgrounds.every(background => contrastRatio(contentEmphasis.expected, background) >= 4.5), `${profile.id}: content emphasis is readable on document and inline code`);
        assert.ok(contentEmphasis.footnotes.length && contentEmphasis.footnotes.every(note => note.background === note.expected && note.carrier !== contentEmphasis.backgrounds[0]), `${profile.id}: reference and definition numbers use a visible derived emphasis tint`);
        assert.ok(contentEmphasis.footnotes.every(note => contrastRatio(contentEmphasis.link, note.carrier) >= 4.5), `${profile.id}: footnotes remain readable on their composited emphasis tint`);
        await page.waitForSelector('.meo-md-color-swatch-interactive');
        await page.click('.meo-md-color-swatch-interactive');
        await page.waitForSelector('.meo-hex-color-adjustment');
        await screenshot(profile.id + '-color-picker.png');
        await page.click('.meo-hex-color-adjustment-close');
        await page.waitForSelector('.meo-md-html-table textarea');
        await page.click('.meo-md-html-table textarea');
        await page.waitForSelector('.meo-md-html-table-context-trigger', { visible: true });
        await page.click('.meo-md-html-table-context-trigger');
        await page.waitForSelector('.meo-md-html-table-context-menu:not([hidden])');
        await screenshot(profile.id + '-table-menu.png');
        await page.keyboard.press('Escape');
        await page.evaluate(() => {
          (window as any).ThemeAcceptance.focusEnd();
        });
        await page.keyboard.type('/co');
        await page.waitForSelector('.meo-input-suggestions:not([hidden])');
        const matches = await page.evaluate(() => {
          const resolve = (name: string) => {
            const probe = document.createElement('span'); probe.style.color = `var(--meo-ui-${name})`; document.body.append(probe);
            const value = getComputedStyle(probe).color; probe.remove(); return value;
          };
          return { normal: resolve('text-emphasis'), selected: resolve('text-emphasis-selected'),
            highContrast: document.documentElement.dataset.meoUiContrast === 'high', highContrastSelected: resolve('text-selected'),
            heading: getComputedStyle(document.querySelector('.meo-md-heading-content')!).color,
            normalBackground: resolve('surface-raised'), hoverBackground: resolve('surface-hover'),
            prefixes: [...document.querySelectorAll('.meo-suggestion-trigger, .meo-suggestion-slash')].map(el => ({
              color: getComputedStyle(el).color, selected: el.closest('.meo-input-suggestion')!.getAttribute('aria-selected') === 'true' })),
            rows: [...document.querySelectorAll('.meo-suggestion-match')].map(el => {
              const row = el.closest('.meo-input-suggestion')!, background = getComputedStyle(row).backgroundColor;
              const selected = row.getAttribute('aria-selected') === 'true', popup = getComputedStyle(el.closest('.meo-input-suggestions')!);
              // Selected rows are transparent; their carrier is the popup gradient.
              const carrier = selected ? popup.backgroundImage.match(/rgb\([^)]+\)/)?.[0] : popup.backgroundColor;
              return { color: getComputedStyle(el).color, weight: getComputedStyle(el).fontWeight,
                background: background === 'rgba(0, 0, 0, 0)' ? carrier! : background, selected };
            }) };
        });
        assert.ok(matches.rows.some(row => row.selected) && matches.rows.some(row => !row.selected), `${profile.id}: selected and ordinary matched suggestions`);
        const ordinaryCarriers = [matches.normalBackground, matches.hoverBackground, ...matches.highContrast ? [] : matches.rows.filter(row => row.selected).map(row => row.background)];
        if (ordinaryCarriers.every(background => contrastRatio(matches.heading, background) >= 4.55)) {
          assert.equal(matches.normal, matches.heading, `${profile.id}: readable heading ink remains unchanged for ordinary and hovered matches`);
        }
        for (const row of matches.rows.filter(row => row.selected)) {
          if (contrastRatio(matches.heading, row.background) >= 4.55) assert.equal(matches.selected, matches.heading, `${profile.id}: readable heading ink remains unchanged for selected matches`);
          else if (contrastRatio(matches.heading, row.background) < 4.5) assert.notEqual(matches.selected, matches.heading, `${profile.id}: insufficient heading contrast is corrected on selection`);
        }
        const actualMatchInk = (selected: boolean) => matches.highContrast && selected ? matches.highContrastSelected : matches.normal;
        assert.ok(matches.rows.every(row => row.color === actualMatchInk(row.selected)), `${profile.id}: matches retain ordinary emphasis except for high-contrast selected foreground`);
        assert.ok(matches.rows.every(row => row.weight === '600'), `${profile.id}: matches keep their identifying weight`);
        assert.ok(matches.rows.every(row => contrastRatio(row.color, row.background) >= 4.5), `${profile.id}: ordinary and selected matches remain readable (${JSON.stringify(matches.rows.map(row => ({...row, contrast: contrastRatio(row.color, row.background)})))})`);
        assert.ok(matches.prefixes.length && matches.prefixes.every(prefix => prefix.color === actualMatchInk(prefix.selected)), `${profile.id}: prefixes and matches share their carrier role`);
        await page.hover('.meo-input-suggestion:not([aria-selected="true"]) .meo-suggestion-match');
        const hoveredMatch = await page.$eval('.meo-input-suggestion:hover .meo-suggestion-match', el => {
          const row = el.closest('.meo-input-suggestion')!, background = getComputedStyle(row).backgroundColor;
          const selected = row.getAttribute('aria-selected') === 'true', popup = getComputedStyle(el.closest('.meo-input-suggestions')!);
          const carrier = selected ? popup.backgroundImage.match(/rgb\([^)]+\)/)?.[0] : popup.backgroundColor;
          return { color: getComputedStyle(el).color, selected, background: background === 'rgba(0, 0, 0, 0)' ? carrier! : background };
        });
        assert.equal(hoveredMatch.color, actualMatchInk(hoveredMatch.selected), `${profile.id}: hover uses the actual selection's match ink`);
        assert.ok(contrastRatio(hoveredMatch.color, hoveredMatch.background) >= 4.5, `${profile.id}: hovered match remains readable on its real background (${JSON.stringify(hoveredMatch)})`);
        await page.mouse.move(10, 1000);
        await screenshot(profile.id + '-slash.png');
        await page.keyboard.press('Escape');
        await page.evaluate(() => (window as any).ThemeAcceptance.replaceText('# **标题** `代码`\n\n普通正文'));
        await page.waitForSelector('.meo-md-h1 .meo-md-marker-active');
        const headingMarkers = await page.evaluate(() => {
          const probe = document.createElement('span'); probe.style.color = 'var(--meo-semantic-markdownSyntax)'; document.body.append(probe);
          const syntax = getComputedStyle(probe).color; probe.remove();
          return { syntax, markers: [...document.querySelectorAll('.meo-md-h1 :is(.meo-md-marker, .meo-md-marker-active, .meo-md-code-marker, .meo-md-code-marker-active)')]
            .map(el => ({ text: el.textContent, color: getComputedStyle(el).color, fill: getComputedStyle(el).webkitTextFillColor })) };
        });
        assert.ok(headingMarkers.markers.some(marker => marker.text?.includes('#')), `${profile.id}: active heading hash is rendered`);
        assert.ok(headingMarkers.markers.every(marker => marker.color === headingMarkers.syntax && marker.fill === headingMarkers.syntax), `${profile.id}: heading syntax stays neutral, including text fill`);
        await screenshot(profile.id + '-heading-markers.png');
      }
      await page.click('button[data-mode="live"]');
      await page.waitForSelector('.cm-editor.meo-mode-live');
      await page.evaluate(text => {
        (window as any).ThemeAcceptance.replaceText(text);
        document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop = 0;
      }, outlineMarkdown);
      await page.waitForFunction(() => document.querySelectorAll('.outline-item').length >= 20 && !!document.querySelector('.outline-item.is-visible-first'));
      await page.mouse.move(700, 900);
      {
        const surfaces = await page.evaluate(() => {
          const read = (selector: string, property = 'backgroundColor') => {
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
            const context = canvas.getContext('2d')!;
            context.fillStyle = getComputedStyle(document.querySelector(selector)!).getPropertyValue(property === 'backgroundColor' ? 'background-color' : property);
            context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data];
          };
          const wrapper = document.querySelector<HTMLElement>('.editor-wrapper')!;
          const fixed = read('.outline-sidebar');
          const mode = wrapper.dataset.outlineMode;
          wrapper.dataset.outlineMode = 'floating';
          const floating = read('.outline-sidebar');
          wrapper.dataset.outlineMode = mode;
          const emphasis = document.createElement('span'); emphasis.style.color = 'var(--meo-ui-text-emphasis-content)'; document.body.append(emphasis);
          const emphasisColor = getComputedStyle(emphasis).color; emphasis.remove();
          return { fixed, floating, content: read('.editor-host'), toolbar: read('.mode-toolbar'), emphasisColor,
            activeChapterColor: getComputedStyle(document.querySelector('.outline-item.is-visible-first')!).color,
            track: read('.mode-group.segmented-control'), indicator: read('.mode-group .is-active .segmented-control-button-indicator'),
            activeChapter: read('.outline-item.is-visible-first'),
            selectedText: read('.mode-group .is-active', 'color'),
            selectedShadow: getComputedStyle(document.querySelector('.mode-group .is-active .segmented-control-button-indicator')!).boxShadow };
        });
        assert.deepEqual(surfaces.fixed, surfaces.content, `${profile.id}: outline and content backgrounds`);
        assert.deepEqual(surfaces.floating, surfaces.content, `${profile.id}: floating outline and content backgrounds`);
        assert.equal(surfaces.activeChapter[3], 0, `${profile.id}: current chapter uses the original transparent item background`);
        assert.equal(surfaces.activeChapterColor, surfaces.emphasisColor, `${profile.id}: current outline chapter shares content text emphasis`);
        const luminance = (color: number[]) => color.slice(0, 3).map(value => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
        const contrast = (left: number[], right: number[]) => { const a = luminance(left), b = luminance(right); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
        if (profile.kind.includes('contrast')) {
          assert.deepEqual(surfaces.track, surfaces.toolbar, `${profile.id}: high contrast keeps the shared native surface`);
          assert.ok(surfaces.selectedShadow.includes('rgb(243, 133, 24)') && surfaces.selectedShadow.includes('inset'),
            `${profile.id}: selected segment needs the explicit native contrast border`);
          assert.ok(contrast(surfaces.selectedText, surfaces.indicator) >= 4.5, `${profile.id}: native selection text remains readable`);
        } else {
          assert.ok(contrast(surfaces.track, surfaces.toolbar) >= 1.2, `${profile.id}: segmented track must stand apart from toolbar`);
        }
        assert.ok(contrast(surfaces.indicator, surfaces.track) >= 1.2, `${profile.id}: selected segment must stand apart from track`);
      }
      await screenshot(profile.id + '-outline-live.png');
      await page.hover('.outline-item.outline-level-3');
      {
        const hover = await page.$eval('.outline-item.outline-level-3:hover', el => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d')!;
          const read = (color: string) => {
            context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data];
          };
          const sidebar = el.closest('.outline-sidebar')!;
          const probe = document.createElement('span'); probe.style.color = 'var(--meo-outline-hover-background)'; sidebar.append(probe);
          const role = read(getComputedStyle(probe).color); probe.remove();
          return { actual: read(getComputedStyle(el).backgroundColor), role, adjacent: read(getComputedStyle(sidebar).backgroundColor) };
        });
        assert.deepEqual(hover.actual, hover.role, `${profile.id}: outline hover uses its adjacent document palette`);
        const difference = Math.max(...hover.actual.slice(0, 3).map((channel, index) => Math.abs(channel - hover.adjacent[index]!)));
        assert.ok(difference <= 21, `${profile.id}: outline hover remains subtle`);
        if (!profile.kind.includes('contrast')) assert.ok(difference > 0, `${profile.id}: outline hover remains visible`);
      }
      await screenshot(profile.id + '-outline-hover.png');
      await page.mouse.move(700, 900);
      await page.$eval('.outline-item.outline-level-3', el => (el as HTMLElement).focus());
      await page.keyboard.press('Tab');
      await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
      const outlineFocus = await page.evaluate(() => {
        const item = document.querySelector('.outline-item:focus-visible')!;
        const probe = document.createElement('span'); probe.style.color = 'var(--meo-ui-text-emphasis-content)'; document.body.append(probe);
        const expected = getComputedStyle(probe).color; probe.remove();
        return { focused: !!item, color: item && getComputedStyle(item).color, expected };
      });
      assert.ok(outlineFocus.focused && outlineFocus.color === outlineFocus.expected, `${profile.id}: keyboard outline focus shares text emphasis`);
      await page.click('button[data-mode="source"]');
      await page.waitForFunction(() => document.querySelector('.cm-editor.meo-mode-source .meo-source-token')?.textContent?.includes('产品说明') === true || [...document.querySelectorAll('.cm-editor.meo-mode-source .meo-source-token')].some(el => el.textContent?.includes('产品说明')));
      assert.equal(await page.$eval('.outline-sidebar', el => getComputedStyle(el).backgroundColor), await page.$eval('.editor-host', el => getComputedStyle(el).backgroundColor));
      await screenshot(profile.id + '-outline-source.png');
      await page.click('button[data-mode="preview"]');
      await page.waitForFunction(() => document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === 'preview' && document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('h1')?.textContent === '产品说明');
      const previewPalette = () => page.evaluate(() => {
        const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
        const doc = frame.contentDocument!;
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d')!;
        const normalize = (color: string) => {
          context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
          return `rgb(${[...context.getImageData(0, 0, 1, 1).data].slice(0, 3).join(', ')})`;
        };
        return { background: normalize(frame.contentWindow!.getComputedStyle(doc.body).backgroundColor),
          foreground: normalize(frame.contentWindow!.getComputedStyle(doc.querySelector('.meo-export-doc')!).color) };
      });
      assert.equal(await page.$eval('.outline-sidebar', el => getComputedStyle(el).backgroundColor), (await previewPalette()).background, `${profile.id}: outline follows the adjacent Preview background`);
      await screenshot(profile.id + '-outline-preview.png');
      if (profile.id === 'dark' || profile.id === 'light') {
        const previousBackground = await page.evaluate(() => { const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!; return frame.contentWindow!.getComputedStyle(frame.contentDocument!.body).backgroundColor; });
        await page.click(`[data-preview-appearance-choice="${profile.id === 'dark' ? 'light' : 'dark'}"]`);
        await page.waitForFunction(previous => {
          const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
          const color = frame.contentWindow?.getComputedStyle(frame.contentDocument!.body).backgroundColor;
          return color && color !== previous;
        }, {}, previousBackground);
        const oppositePalette = await previewPalette();
        assert.equal(await page.$eval('.outline-sidebar', el => getComputedStyle(el).backgroundColor), oppositePalette.background, 'Manual Preview appearance recolors the adjacent outline background');
        assert.equal(await page.$eval('.outline-header-label', el => getComputedStyle(el).color), oppositePalette.foreground, 'Readable Preview ink is retained in the outline');
        await screenshot(profile.id + '-outline-preview-opposite.png');
        await page.click('button[data-mode="live"]');
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.outline-sidebar')!).backgroundColor === getComputedStyle(document.querySelector('.editor-host')!).backgroundColor);
        assert.equal(await page.$eval('.outline-header-label', el => getComputedStyle(el).color), await page.$eval('.cm-content', el => getComputedStyle(el).color), 'Returning to Live restores the adjacent editor ink');
      }
    }
  }
  if (baseline) fs.writeFileSync(baselinePath, JSON.stringify(content, null, 2));
  else {
    fs.writeFileSync(path.join(output, 'content-observed.json'), JSON.stringify(content, null, 2));
    // These fixed fingerprints were captured from the pre-change commit. A
    // normal run must never refresh its oracle from the version under test.
    const expectedContent = JSON.parse(fs.readFileSync('scripts/fixtures/theme-content-baseline.json', 'utf8'));
    // Only the approved surface/action fields are restored. This fixture was
    // extracted after validating the original full snapshots against the fixed
    // hashes above; it is never generated from the implementation under test.
    const previousSurfaces = JSON.parse(fs.readFileSync('scripts/fixtures/theme-document-surface-before.json', 'utf8'));
    assert.deepEqual(Object.keys(content), Object.keys(expectedContent.hashes));
    for (const [profile, styles] of Object.entries(content)) {
      // Check approved changes explicitly, then restore only those attributes
      // for comparison with the immutable pre-change content fingerprints.
      const retainedStyles = structuredClone(styles);
      if (profile.endsWith(':live')) {
        const original = expectedContent.liveHeadingForegrounds[profile];
        assert.ok(original, `${profile}: missing original Live heading foreground`);
        for (const row of (retainedStyles as Record<string, string[][]>)['.meo-md-h1']!) {
          row[1] = row[3] = original;
        }
      }
      const restore = (rows: string[][], previous: [number, string][][]) => {
        assert.equal(rows.length, previous.length, `${profile}: surface migration must preserve content structure`);
        previous.forEach((fields, index) => fields.forEach(([field, value]) => { rows[index]![field] = value; }));
      };
      if (profile.endsWith(':live')) {
        for (const [selector, previous] of Object.entries(previousSurfaces[profile])) {
          restore((retainedStyles as Record<string, string[][]>)[selector]!, previous as [number, string][][]);
        }
      } else {
        restore(retainedStyles as string[][], previousSurfaces[profile]);
        // The 15px fixture keeps a readable container and derives code lines at 88%.
        // Restore only those approved font fields for the immutable color/content oracle.
        for (const { index, previousSize } of previewCodeFontRows[profile]!) {
          const row = (retainedStyles as string[][])[index]!;
          row[5] = previousSize;
        }
      }
      const fingerprint = createHash('sha256').update(JSON.stringify(retainedStyles)).digest('hex');
      assert.equal(fingerprint, expectedContent.hashes[profile], `${profile}: Live/Preview content styles differ from ${expectedContent.baseCommit}`);
    }
    await page.click('button[data-mode="source"]');
    await page.waitForSelector('.cm-editor.meo-mode-source');
    await page.evaluate(() => {
      const text = '# Pending theme\n\n' + '> Text **bold** `code`\n'.repeat(700);
      (window as any).ThemeAcceptance.replaceText(text);
      document.documentElement.style.setProperty('--vscode-radio-activeBackground', 'transparent');
      document.documentElement.style.setProperty('--vscode-editor-foreground', '#ccffdd');
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'vscodeCodeThemeChanged', appearance: 'dark', vscodeTheme: {
        name: 'Runtime theme', type: 'dark', colors: { 'editor.foreground': '#ccffdd' }, tokenColors: [{ scope: 'markup.heading', settings: { foreground: '#ff9933', fontStyle: 'bold' } }]
      } } }));
      (window as any).ThemeAcceptance.replaceText('# Final theme\n\nOnly the latest document may publish.');
    });
    await page.waitForFunction(() => [...document.querySelectorAll('.meo-source-token')].some(el => el.textContent?.includes('Final theme') && getComputedStyle(el).color === 'rgb(255, 153, 51)'));
    assert.notEqual(await page.evaluate(() => {
      const probe = document.createElement('span'); probe.style.background = 'var(--meo-ui-surface-selected)'; document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor; probe.remove(); return color;
    }), 'rgba(0, 0, 0, 0)', 'Derived selected UI remains visible independently of transparent native radio tokens');
    assert.notEqual(await page.$eval('.segmented-control-button.is-active .segmented-control-button-indicator', el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', 'Segmented controls keep a distinct surface even with a transparent native radio token');
    assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--vscode-editor-foreground')), '#ccffdd', 'Theme transitions must preserve native variables');
    await screenshot('runtime-theme-source.png');
    await page.evaluate(() => document.documentElement.style.removeProperty('--vscode-radio-activeBackground'));
    await screenshot('runtime-fallback-source.png');
  }
  assert.deepEqual(errors, []);
  console.log(baseline ? 'Captured content baseline and full-window screenshots.' : 'Theme inheritance: Source character colors/styles and Live/Preview preservation passed.');
} finally { reference.dispose(); await closeTestBrowser(browser); }
