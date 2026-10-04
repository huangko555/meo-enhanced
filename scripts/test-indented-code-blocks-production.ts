import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';

const fixtures = [
  { name: 'multiline', source: '    通过右上角的设置按钮打开小\n    菜单点击“更多设置”打1\n    开完整设置窗口。', expected: '通过右上角的设置按钮打开小\n菜单点击“更多设置”打1\n开完整设置窗口。' },
  { name: 'single', source: '    单行代码内容', expected: '单行代码内容' },
  { name: 'wrapped', source: '    ' + '一条需要自动换行的代码内容'.repeat(12), expected: '一条需要自动换行的代码内容'.repeat(12) },
  { name: 'indent-and-blank', source: '      alpha\n\n        beta', expected: '  alpha\n\n    beta' },
  { name: 'tabs', source: '\t alpha\n\t\tbeta', expected: ' alpha\n\tbeta' },
  { name: 'quote', source: '>     alpha\n>\n>     beta', expected: 'alpha\n\nbeta' },
  { name: 'list', source: '- Parent\n\n      alpha\n      beta', expected: 'alpha\nbeta' },
  { name: 'literal-fences', source: '    ```\n    alpha\n    ```', expected: '```\nalpha\n```' },
  { name: 'plain-fence', source: '```\nalpha\n\nbeta\n```', expected: 'alpha\n\nbeta' }
];
const build = await Bun.build({
  entrypoints: ['scripts/test-code-block-line-numbers-entry.ts'], target: 'browser', format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const bundle = await build.outputs[0].text();
const browser = await launchTestBrowser();

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (let frame = 0; frame < 6; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
}

async function codeColors(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const colors = new Set<string>();
    for (const line of document.querySelectorAll('.meo-md-code-line-numbered')) {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.textContent?.trim() || text.parentElement!.closest('.meo-code-block-actions, .meo-code-language-label, .meo-md-marker, .meo-md-marker-active')) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        if (range.getClientRects().length) colors.add(getComputedStyle(text.parentElement!).color);
      }
    }
    return [...colors];
  });
}

try {
  for (const theme of ['dark', 'light'] as const) {
    for (const fixture of fixtures) {
      const page = await browser.newPage();
      try {
        const context = `${theme}/${fixture.name}`;
        const payloadLines = fixture.expected.split('\n').filter(line => line.trim());
        const uiLanguage = fixture.name === 'wrapped' || theme === 'dark' ? 'zh-CN' : 'en';
        const foreground = theme === 'dark' ? '#e6edf3' : '#24292f';
        const text = '# 设置界面预览\n\n' + fixture.source + '\n\n尾部与 `行内代码`';
        await page.setViewport({ width: 520, height: 720 });
        await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app" class="editor-host"></div>');
        await page.addStyleTag({ path: 'webview/src/styles.css' });
        await page.addStyleTag({ content: `:root{
          --meo-background:${theme === 'dark' ? '#24292e' : '#ffffff'};
          --meo-foreground:${foreground};--vscode-editor-foreground:${foreground};
          --meo-token-foreground-color:${foreground};--meo-token-monospace-color:#79c0ff;
          --meo-code-background:${theme === 'dark' ? '#1b2024' : '#f6f8fa'};
          --meo-inline-code-background:${theme === 'dark' ? '#1b2024' : '#f6f8fa'};
          --meo-semantic-codeCopyForeground:${theme === 'dark' ? '#79c0ff' : '#0969da'};
          --meo-semantic-codeCopyBackground:transparent;
          --meo-semantic-codeLanguageLabelForeground:#8b949e;--meo-semantic-codeLanguageLabelBackground:transparent;
          --meo-semantic-mutedForeground:#8b949e;--meo-line-number-foreground:#8b949e;
          --meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-text:system-ui;--meo-font-text-weight:400;
          --vscode-editor-font-family:monospace;--vscode-editor-font-size:18px;--vscode-editor-line-height:26px;
        }` });
        await page.addScriptTag({ content: bundle });
        await page.evaluate(({ text, uiLanguage, needle }) => {
          const scope = window as any;
          scope.__copiedCode = null;
          // Observe the production copy payload at the external clipboard boundary.
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
            async writeText(value: string) { scope.__copiedCode = value; }
          } });
          scope.__editor = scope.CodeBlockLineNumbersHarness.createEditor({
            parent: document.getElementById('app')!, text, uiLanguage, initialMode: 'live', onApplyChanges() {}
          });
          scope.__editor.view.dispatch({ selection: { anchor: text.indexOf(needle) + 2 } });
          scope.__editor.view.focus();
        }, { text, uiLanguage, needle: payloadLines[Math.min(1, payloadLines.length - 1)].trim() });
        await settle(page);
        assert.equal((await codeColors(page)).length, 1, context + ': active and inactive plain code colors');
        assert.equal(await page.$eval('.meo-md-inline-code', element => getComputedStyle(element).color),
          theme === 'dark' ? 'rgb(230, 237, 243)' : 'rgb(36, 41, 47)', context + ': inline code keeps its own presentation');
        await page.keyboard.type('x');
        await settle(page);
        assert.equal((await codeColors(page)).length, 1, context + ': colors after typing');
        await page.keyboard.down('Control');
        await page.keyboard.press('z');
        await page.keyboard.up('Control');
        await settle(page);
        assert.equal(await page.evaluate(() => (window as any).__editor.view.state.doc.toString()), text, context + ': undo retains original source');
        assert.equal(await page.$$eval('.meo-select-all-code-btn', elements => elements.length), 1, context + ': one select button');
        assert.equal(await page.$$eval('.meo-copy-code-btn', elements => elements.length), 1, context + ': one copy button');
        await page.hover('.meo-md-code-line-numbered');
        await settle(page);
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.meo-code-block-actions')!).opacity === '1', { timeout: 2000 });
        const layout = await page.evaluate(() => {
          const actions = document.querySelector<HTMLElement>('.meo-code-block-actions')!;
          const line = actions.closest('.cm-line')!;
          const box = actions.getBoundingClientRect();
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          let overlap = false;
          for (let text = walker.nextNode(); text; text = walker.nextNode()) {
            if (!text.textContent?.trim() || text.parentElement!.closest('.meo-code-block-actions, .meo-code-language-label')) continue;
            const range = document.createRange();
            range.selectNodeContents(text);
            overlap ||= [...range.getClientRects()].some(rect => rect.left < box.right && rect.right > box.left && rect.top < box.bottom && rect.bottom > box.top);
          }
          return { overlap, opacity: getComputedStyle(actions).opacity,
            numbers: Array.from(document.querySelectorAll<HTMLElement>('.meo-md-code-line-numbered')).map(row => row.dataset.meoCodeLineNumber) };
        });
        assert.equal(layout.overlap, false, context + ': actions do not cover content');
        assert.equal(layout.opacity, '1', context + ': hover reveals actions');
        assert.deepEqual(layout.numbers, fixture.expected.split('\n').map((_, index) => String(index + 1)), context + ': visual space has no code line number');
        const alignment = await page.evaluate(needle => {
          const view = (window as any).__editor.view;
          const first = document.querySelector<HTMLElement>('.meo-md-code-line-numbered')!;
          const lineNumber = view.state.doc.lineAt(view.posAtDOM(first)).number;
          const marker = Array.from(view.scrollDOM.querySelectorAll('.cm-gutters > .cm-lineNumbers > .cm-gutterElement') as NodeListOf<HTMLElement>)
            .find(element => getComputedStyle(element).visibility !== 'hidden' && element.textContent?.trim() === String(lineNumber))!;
          const markerRange = document.createRange();
          markerRange.selectNodeContents(marker);
          const walker = document.createTreeWalker(first, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode as Text;
            const index = node.data.indexOf(needle);
            if (index < 0) continue;
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + 1);
            const textBox = range.getBoundingClientRect();
            const markerBox = markerRange.getBoundingClientRect();
            return Math.abs((markerBox.top + markerBox.bottom) / 2 - (textBox.top + textBox.bottom) / 2);
          }
          throw new Error('First payload text not found');
        }, fixture.expected.split('\n')[0].trim());
        assert.ok(alignment <= 2, context + ': outer document number follows the first text baseline: ' + alignment);
        const label = await page.evaluate(() => {
          const element = document.querySelector<HTMLElement>('.meo-md-indented-code-block-start .meo-code-language-label');
          if (!element) return null;
          const box = element.getBoundingClientRect();
          const actions = document.querySelector('.meo-code-block-actions')!.getBoundingClientRect();
          return { text: element.textContent, role: element.getAttribute('role'), pointer: getComputedStyle(element).pointerEvents,
            topOffset: Math.abs(box.top - actions.top),
            overlapsActions: box.right > actions.left && box.left < actions.right && box.top < actions.bottom && box.bottom > actions.top };
        });
        if (fixture.name === 'plain-fence') {
          assert.equal(label, null, context + ': fenced blocks retain their language label');
        } else {
          assert.equal(label?.text, uiLanguage === 'zh-CN' ? '缩进代码块' : 'Indented code block', context + ': explanatory label');
          assert.equal(label.role, null, context + ': label is not a button');
          assert.equal(label.pointer, 'none', context + ': label does not intercept editing');
          assert.equal(label.overlapsActions, false, context + ': label and actions stay apart');
          assert.ok(label.topOffset <= 1, context + ': label shares the existing language toolbar row');
        }
        const screenshotDir = process.env.MEO_CODE_BLOCK_SCREENSHOT_DIR;
        if (screenshotDir && fixture.name === 'multiline') {
          fs.mkdirSync(screenshotDir, { recursive: true });
          await page.screenshot({ path: path.join(screenshotDir, `${theme}.png`) });
        }
        if (fixture.name === 'single') {
          await page.focus('.meo-select-all-code-btn');
          await page.keyboard.press('Enter');
        } else {
          await page.click('.meo-select-all-code-btn');
        }
        const selection = await page.evaluate(() => {
          const view = (window as any).__editor.view;
          return { from: view.state.selection.main.from, to: view.state.selection.main.to,
            text: view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) };
        });
        assert.ok(payloadLines.every(line => selection.text.includes(line)), context + ': all content lines selected');
        assert.ok(!selection.text.includes('尾部') && !selection.text.includes('设置界面预览'), context + ': selection stays inside block');
        assert.equal(selection.from, text.indexOf(payloadLines[0]), context + ': selection begins with first payload');
        assert.equal(selection.to, text.lastIndexOf(payloadLines[payloadLines.length - 1]) + payloadLines[payloadLines.length - 1].length, context + ': selection ends with last payload');
        await page.hover('.meo-md-code-line-numbered');
        await page.click('.meo-copy-code-btn');
        assert.equal(await page.evaluate(() => (window as any).__copiedCode), fixture.expected, context + ': complete copy without structural prefixes');
        if (fixture.name === 'multiline') {
          await page.evaluate(language => (window as any).__editor.setUiLanguage(language), uiLanguage === 'zh-CN' ? 'en' : 'zh-CN');
          await settle(page);
          assert.equal(await page.$eval('.meo-md-indented-code-block-start .meo-code-language-label', element => element.textContent), uiLanguage === 'zh-CN' ? 'Indented code block' : '缩进代码块', context + ': localized label after language switch');
          await page.evaluate(() => (window as any).__editor.setMode('source'));
          await settle(page);
          assert.equal(await page.$('.meo-md-indented-code-block-start .meo-code-language-label'), null, context + ': label belongs only to Live');
        }
      } finally { await page.close(); }
    }
  }
  console.log('Live plain-code colors, complete selection/copy, single-line actions and wrapped layouts passed (18 fixtures)');
} finally { await browser.close(); }
