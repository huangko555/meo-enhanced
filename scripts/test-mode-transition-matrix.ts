import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

type Mode = 'live' | 'source' | 'preview';
const svg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="90"><rect width="240" height="90" fill="#3275bd"/></svg>');
const cases = [
  { name: 'paragraph', selector: '.cm-line', markdown: 'Ordinary **bold**, *italic*, ~~strike~~ and [link](https://example.com).\n\nAnother paragraph with `inline code`.' },
  { name: 'table', selector: '.meo-md-html-table-shell', markdown: '| Scenario | Description | Result |\n| --- | --- | --- |\n| One | **Bold** and `code` | Long wrapped content with several words |\n| Two | [Link](https://example.com) | Mixed *italic* text |\n| Three | More text | Last cell |' },
  { name: 'code', selector: '.cm-line.meo-md-code-block', markdown: '```typescript\nfunction render(value: string) {\n  return value.repeat(8);\n}\n```\n\n`inline code` after the block.' },
  { name: 'mermaid', selector: '.meo-mermaid-block', markdown: '```mermaid\nflowchart LR\n  A[Start] --> B[Rendered diagram]\n  B --> C[Done]\n```' },
  { name: 'mermaid-error', selector: '.meo-mermaid-block', markdown: '```mermaid\nFAIL_RENDER\n```' },
  { name: 'image', selector: '.meo-md-image', markdown: `![blue rectangle](${svg})\n\nImage caption and adjacent paragraph.` },
  { name: 'math', selector: '.meo-md-math-fenced-display', markdown: '$$\n\\frac{a^2+b^2}{c^2}=1\n$$\n\nInline math $x^2+y^2$ follows.' },
  { name: 'html', selector: '.meo-md-html-block', markdown: '<details open><summary>Expanded detail</summary><p>Nested HTML content</p></details>\n\n> Quoted **text** with `code`.' },
  { name: 'list', selector: '.meo-md-list-marker', markdown: '- Parent item\n  - Nested item\n    - Deep item\n- Second item\n\n1. First ordered\n2. Second ordered' }
] as const;
const sequences: readonly (readonly Mode[])[] = [
  ['live', 'source', 'preview', 'live', 'source', 'preview'],
  ['preview', 'source', 'live', 'preview', 'source', 'live']
];

const build = await Bun.build({
  entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'],
  target: 'browser', format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  const durations: Array<{ content: string; split: boolean; mode: Mode; ms: number }> = [];
  for (const scenario of cases) {
    for (const split of [false, true]) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1500, height: 900 });
      await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
      await page.addStyleTag({ path: 'webview/src/styles.css' });
      await page.evaluate(() => {
        (window as any).mermaid = {
          initialize() {},
          async render(_id: string, source: string) {
            await new Promise(resolve => setTimeout(resolve, 20));
            if (source.includes('FAIL_RENDER')) throw new Error('Expected diagram failure');
            return { svg: '<svg width="400" height="120" viewBox="0 0 400 120"><rect width="400" height="120" fill="#3275bd"/></svg>' };
          }
        };
      });
      await page.exposeFunction('__renderMatrixPreview', async (message: any) => {
        if (message.type !== 'requestPreviewRender') return null;
        return {
          type: 'previewRenderResult', requestId: message.requestId,
          result: { ok: true, value: exportRuntime.renderPreviewDocument({
            markdownText: message.text,
            sourceDocumentPath: 'C:/tmp/mode-matrix.md',
            uiLanguage: message.uiLanguage,
            styleEnvironment: message.environment
          }) }
        };
      });
      await page.addScriptTag({ content: `window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){window.__renderMatrixPreview(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
      await page.addScriptTag({ content: await build.outputs[0]!.text() });
      const text = `# Viewport ${scenario.name}\n\n${scenario.markdown}\n\n## Following section\n\nFollowing content.`;
      await page.evaluate(text => {
        window.dispatchEvent(new MessageEvent('message', { data: {
          type: 'init', documentId: 'file:///mode-matrix.md', text, version: 1,
          savedRevision: { version: 1, text }, diagnostics: [], mode: 'live', uiLanguage: 'en',
          sourceLineNumbers: 'on', previewAppearance: 'dark', previewFontFamily: '', previewSourceColoring: true,
          editorAppearance: 'dark', editorFontSizeMode: 'auto', editorFontSize: 14,
          gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
          diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
          contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
          outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
          restoreReadingPositionOnOpen: false, vscodeTheme: null
        } }));
      }, text);
      await page.waitForFunction(() => document.querySelector<HTMLElement>('.cm-editor.meo-mode-live')
        && !document.querySelector<HTMLElement>('.editor-wrapper')?.classList.contains('meo-preload-editor-shell'));
      if (scenario.name.startsWith('mermaid')) {
        await page.waitForFunction(() => {
          const block = document.querySelector<HTMLElement>('.meo-mermaid-block');
          return block && !block.hasAttribute('aria-busy')
            && Boolean(block.querySelector('.meo-mermaid-svg-wrapper, .meo-mermaid-fallback'));
        });
      }
      if (split) {
        await page.evaluate(() => document.querySelector<HTMLButtonElement>('button[data-mode="source"]')!.click());
        await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'source');
        await page.click('.source-preview-button');
        await page.waitForFunction(() => document.querySelector('.editor-surface')?.hasAttribute('data-source-preview'));
        await page.evaluate(() => document.querySelector<HTMLButtonElement>('button[data-mode="live"]')!.click());
        await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'live');
      }
      for (const sequence of sequences) {
        for (const mode of sequence) {
          const observation = await page.evaluate(async ({ target, selector }: { target: Mode; selector: string }) => {
            const root = document.querySelector<HTMLElement>('#app')!;
            const editor = document.querySelector<HTMLElement>('.editor-host')!;
            const preview = document.querySelector<HTMLElement>('.preview-host')!;
            const surface = document.querySelector<HTMLElement>('.editor-surface')!;
            const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
            const start = performance.now();
            let firstReadyMs: number | null = null;
            const frames: Array<{ blank: boolean; ready: boolean; top: number | null; featureTop: number | null; featureHeight: number | null; busy: string | null; svg: boolean; split: boolean }> = [];
            document.querySelector<HTMLButtonElement>(`button[data-mode="${target}"]`)!.click();
            await new Promise<void>((resolve, reject) => {
              let afterReady = 0;
              const sample = () => {
                const rect = scroller.getBoundingClientRect();
                const heading = Array.from(scroller.querySelectorAll<HTMLElement>('.cm-line'))
                  .find(line => line.textContent?.includes('Viewport '));
                const headingRect = heading?.getBoundingClientRect();
                const feature = target === 'live' ? scroller.querySelector<HTMLElement>(selector) : null;
                const featureRect = feature?.getBoundingClientRect();
                const editorContent = Array.from(scroller.querySelectorAll<HTMLElement>('.cm-line'))
                  .some(line => { const lineRect = line.getBoundingClientRect();
                    return lineRect.height > 0 && lineRect.bottom >= rect.top && lineRect.top <= rect.bottom; });
                const previewContent = Boolean(preview.querySelector<HTMLIFrameElement>('.preview-frame')
                  ?.contentDocument?.body.textContent?.trim());
                const previewReady = document.querySelector<HTMLElement>('.preview-status')?.hidden === true;
                const ready = root.dataset.mode === target && (target === 'preview'
                  ? !preview.hidden && previewReady
                  : !editor.hidden && !editor.inert && (target !== 'live' || preview.hidden)
                    && (target !== 'source' || !surface.hasAttribute('data-source-preview') || previewReady));
                if (ready && firstReadyMs === null) firstReadyMs = performance.now() - start;
                frames.push({
                  blank: (editor.hidden || !editorContent) && (preview.hidden || !previewContent),
                  ready, top: !editor.hidden && headingRect ? headingRect.top : null,
                  featureTop: !editor.hidden ? featureRect?.top ?? null : null,
                  featureHeight: !editor.hidden ? featureRect?.height ?? null : null,
                  busy: feature?.getAttribute('aria-busy') ?? null,
                  svg: Boolean(feature?.querySelector('svg')),
                  split: surface.hasAttribute('data-source-preview')
                });
                if (ready) afterReady += 1;
                if (afterReady >= 6) resolve();
                else if (performance.now() - start > 1200) reject(new Error(`mode ${target} did not settle`));
                else requestAnimationFrame(sample);
              };
              requestAnimationFrame(sample);
            });
            return { ms: Math.round(firstReadyMs ?? performance.now() - start), frames };
          }, { target: mode, selector: scenario.selector });
          const label = `${scenario.name}/${split ? 'split' : 'single'}/${mode}`;
          assert.ok(observation.frames.every(frame => !frame.blank), `${label}: blank frame`);
          const visible = observation.frames.filter(frame => frame.ready);
          assert.ok(visible.length >= 6, `${label}: mode did not settle`);
          assert.equal(visible[0]!.split, mode === 'source' && split, `${label}: Source split state`);
          const tops = visible.map(frame => frame.top).filter((top): top is number => top !== null);
          if (mode !== 'preview') {
            assert.ok(tops.length > 0, `${label}: heading missing from editor viewport`);
            assert.ok(tops.every(top => Math.abs(top - tops[0]!) <= 2), `${label}: visible content moved: ${tops}`);
          }
          if (mode === 'live') {
            const featureVisible = await page.evaluate(selector => {
              const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
              const viewport = scroller.getBoundingClientRect();
              return Array.from(scroller.querySelectorAll<HTMLElement>(selector)).some(element => {
                const rect = element.getBoundingClientRect();
                return rect.height > 0 && rect.bottom >= viewport.top && rect.top <= viewport.bottom;
              });
            }, scenario.selector);
            assert.ok(featureVisible, `${label}: special content absent from Live viewport`);
          }
          if (mode === 'source' && split) {
            const previewHasSection = await page.evaluate(() => Boolean(
              document.querySelector<HTMLIFrameElement>('.preview-frame')
                ?.contentDocument?.body.textContent?.includes('Viewport ')
            ));
            assert.ok(previewHasSection, `${label}: Source split preview missing document content`);
          }
          if (mode === 'live') {
            const rects = visible.map(frame => [frame.featureTop, frame.featureHeight] as const);
            assert.ok(rects[0]![0] !== null && rects[0]![1] !== null, `${label}: rendered feature missing on first revealed frame`);
            assert.ok(rects.every(([top, height]) => top !== null && height !== null
              && Math.abs(top - rects[0]![0]!) <= 2 && Math.abs(height - rects[0]![1]!) <= 2),
            `${label}: rendered feature moved after reveal: ${JSON.stringify(visible)}`);
          }
          durations.push({ content: scenario.name, split, mode, ms: observation.ms });
        }
      }
      await page.close();
    }
  }
  const sorted = durations.map(item => item.ms).sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  console.log(`Mode matrix: ${durations.length} switches, p95 ${p95} ms, max ${sorted.at(-1)} ms`);
  assert.ok(p95 < 300, `mode switching p95 exceeded 300 ms: ${p95}`);
} catch (error) {
  primaryError = error;
} finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
