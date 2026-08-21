import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-source-mermaid-lifecycle-'));

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-preview-mermaid-runtime-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 700, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app,#app2{height:100%;margin:0}</style><div id="app"></div><div id="app2"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#fff;--meo-foreground:#111;--meo-code-background:#f4f4f4;--meo-surface-background:#fff;--meo-font-live:Arial;--meo-font-live-size:16px;--meo-font-source:monospace;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px;--vscode-editor-line-height:20px}'
    });
    await page.evaluate(() => {
      type PendingRender = {
        readonly source: string;
        resolve(value: { readonly svg: string }): void;
      };
      const testWindow = window as typeof window & {
        mermaid?: unknown;
        __mermaidCalls?: string[];
        __mermaidPending?: PendingRender[];
        __mermaidActive?: number;
        __mermaidMaxActive?: number;
        __resolveMermaid?: (source: string, marker: string) => boolean;
      };
      testWindow.__mermaidCalls = [];
      testWindow.__mermaidPending = [];
      testWindow.__mermaidActive = 0;
      testWindow.__mermaidMaxActive = 0;
      testWindow.mermaid = {
        initialize() {},
        render(_renderId: string, source: string) {
          testWindow.__mermaidCalls!.push(source);
          testWindow.__mermaidActive! += 1;
          testWindow.__mermaidMaxActive = Math.max(
            testWindow.__mermaidMaxActive!,
            testWindow.__mermaidActive!
          );
          return new Promise<{ readonly svg: string }>((resolve) => {
            testWindow.__mermaidPending!.push({
              source,
              resolve(value) {
                testWindow.__mermaidActive! -= 1;
                resolve(value);
              }
            });
          });
        }
      };
      testWindow.__resolveMermaid = (source, marker) => {
        const index = testWindow.__mermaidPending!.findIndex((entry) => entry.source === source);
        if (index < 0) return false;
        const [pending] = testWindow.__mermaidPending!.splice(index, 1);
        pending!.resolve({ svg: `<svg data-marker="${marker}" width="160" height="80"></svg>` });
        return true;
      };
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const initialSource = 'graph TD\nSOURCE_INITIAL-->PENDING';
    const initialText = `\`\`\`mermaid\n${initialSource}\n\`\`\`\n\nordinary source text`;
    await page.evaluate((text) => {
      const testWindow = window as typeof window & { __createSharedMermaidEditor?: (options: any) => any };
      const editor = testWindow.__createSharedMermaidEditor?.({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'source',
        onApplyChanges() {}
      });
      if (!editor) throw new Error('Shared Mermaid Editor factory is unavailable');
      (testWindow as typeof testWindow & { __sourceMermaidEditor?: any }).__sourceMermaidEditor = editor;
      editor.view.focus();
      editor.view.dispatch({ selection: { anchor: 4 } });
    }, initialText);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const initialSourceState = await page.evaluate(() => {
      const testWindow = window as typeof window & {
        __sourceMermaidEditor?: any;
        __mermaidCalls?: string[];
      };
      const editor = testWindow.__sourceMermaidEditor;
      return {
        calls: testWindow.__mermaidCalls?.length ?? -1,
        text: editor.view.state.doc.toString(),
        selection: editor.view.state.selection.main.head,
        focused: editor.view.hasFocus,
        mermaidDom: document.querySelectorAll('#app .cm-editor .meo-mermaid-block').length
      };
    });
    assert.deepEqual(initialSourceState, {
      calls: 0,
      text: initialText,
      selection: 4,
      focused: true,
      mermaidDom: 0
    });

    await page.evaluate(() => {
      (window as typeof window & { __sourceMermaidEditor?: any }).__sourceMermaidEditor.setMode('live');
    });
    await page.waitForFunction((source) => (
      (window as typeof window & { __mermaidCalls?: string[] }).__mermaidCalls?.includes(source)
    ), {}, initialSource);

    const sharedEditorCallCount = await page.evaluate(({ text, source }) => {
      const testWindow = window as typeof window & {
        __createSharedMermaidEditor?: (options: any) => any;
        __mermaidCalls?: string[];
        __secondMermaidEditor?: any;
      };
      testWindow.__secondMermaidEditor = testWindow.__createSharedMermaidEditor?.({
        parent: document.getElementById('app2')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
      if (!testWindow.__secondMermaidEditor) throw new Error('Second shared Mermaid Editor was not created');
      return testWindow.__mermaidCalls?.filter((entry) => entry === source).length ?? -1;
    }, { text: initialText, source: initialSource });
    assert.equal(sharedEditorCallCount, 1, 'two Editor groups with the same key must share one physical render');

    const previewSource = 'flowchart LR\nPreview-->Continues';
    const previewHtml = `<div class="meo-export-page" data-source-line="1"><div class="meo-export-mermaid" data-source-b64="${Buffer.from(previewSource).toString('base64')}"></div></div>`;
    await page.evaluate(({ text, html }) => {
      const testWindow = window as typeof window & {
        __previewController?: any;
        __previewMessages?: Array<{ type?: string; requestId?: string }>;
      };
      testWindow.__previewController.requestRender(text);
      const requestId = testWindow.__previewMessages
        ?.findLast((message) => message.type === 'requestPreviewRender')?.requestId;
      if (!requestId) throw new Error('Preview request was not created');
      testWindow.__previewController.acceptRenderResponse({
        type: 'previewRenderResult',
        requestId,
        result: {
          ok: true,
          value: {
            html,
            hasMermaid: true,
            styles: {
              light: ':root{--meo-mermaid-background:#fff;--meo-mermaid-node-background:#eee;--meo-mermaid-foreground:#111;--meo-mermaid-border:#555;--meo-mermaid-line:#555}',
              dark: ':root{--meo-mermaid-background:#222;--meo-mermaid-node-background:#333;--meo-mermaid-foreground:#eee;--meo-mermaid-border:#aaa;--meo-mermaid-line:#aaa}'
            }
          }
        }
      });
    }, { text: previewSource, html: previewHtml });
    await page.waitForFunction(() => (
      ((window as typeof window & { __previewMermaidRequests?: number }).__previewMermaidRequests ?? 0) >= 1
    ));

    const sourceAfterPendingLive = await page.evaluate(() => {
      const editor = (window as typeof window & { __sourceMermaidEditor?: any }).__sourceMermaidEditor;
      editor.setMode('source');
      return {
        selection: editor.view.state.selection.main.head,
        focused: editor.view.hasFocus,
        mermaidDom: document.querySelectorAll('#app .cm-editor .meo-mermaid-block').length
      };
    });
    assert.deepEqual(sourceAfterPendingLive, { selection: 4, focused: true, mermaidDom: 0 });

    await page.evaluate((source) => {
      const resolved = (window as typeof window & {
        __resolveMermaid?: (source: string, marker: string) => boolean;
      }).__resolveMermaid?.(source, 'stale-live');
      if (!resolved) throw new Error('Pending Live Mermaid render was not found');
    }, initialSource);
    await page.waitForFunction((source) => (
      (window as typeof window & { __mermaidCalls?: string[] }).__mermaidCalls?.includes(source)
    ), {}, previewSource);
    await page.evaluate((source) => {
      const resolved = (window as typeof window & {
        __resolveMermaid?: (source: string, marker: string) => boolean;
      }).__resolveMermaid?.(source, 'preview-current');
      if (!resolved) throw new Error('Preview Mermaid render was not found');
    }, previewSource);
    await page.waitForFunction(() => Boolean(
      document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
        ?.querySelector('svg[data-marker="preview-current"]')
    ));
    const sharedConsumerResult = await page.evaluate(() => ({
      sourceOldVisible: Boolean(document.querySelector('#app .cm-editor svg[data-marker="stale-live"]')),
      sourceLiveDom: document.querySelectorAll('#app .cm-editor .meo-mermaid-block').length,
      secondEditorVisible: Boolean(document.querySelector('#app2 .cm-editor svg[data-marker="stale-live"]')),
      previewVisible: Boolean(document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
        ?.querySelector('svg[data-marker="preview-current"]'))
    }));
    assert.deepEqual(sharedConsumerResult, {
      sourceOldVisible: false,
      sourceLiveDom: 0,
      secondEditorVisible: true,
      previewVisible: true
    });

    const callsBeforeCachedReturn = await page.evaluate((source) => (
      (window as typeof window & { __mermaidCalls?: string[] }).__mermaidCalls
        ?.filter((entry) => entry === source).length ?? -1
    ), initialSource);
    await page.evaluate(() => {
      (window as typeof window & { __sourceMermaidEditor?: any }).__sourceMermaidEditor.setMode('live');
    });
    await page.waitForSelector('#app .cm-editor svg[data-marker="stale-live"]');
    const cachedReturnResult = await page.evaluate((source) => {
      const testWindow = window as typeof window & {
        __mermaidCalls?: string[];
        __secondMermaidEditor?: any;
      };
      const calls = testWindow.__mermaidCalls?.filter((entry) => entry === source).length ?? -1;
      testWindow.__secondMermaidEditor.destroy();
      testWindow.__secondMermaidEditor = null;
      return {
        calls,
        latestVisible: Boolean(document.querySelector('#app .cm-editor svg[data-marker="stale-live"]'))
      };
    }, initialSource);
    assert.deepEqual(cachedReturnResult, {
      calls: callsBeforeCachedReturn,
      latestVisible: true
    }, 'the surviving Editor group must populate Pool cache for a Source→Live return');

    const slowOldSource = 'graph TD\nSLOW_OLD-->STALE';
    const latestSource = 'graph TD\nLATEST-->VISIBLE';
    await page.evaluate(({ slowOld, latest }) => {
      const editor = (window as typeof window & { __sourceMermaidEditor?: any }).__sourceMermaidEditor;
      editor.setText(`\`\`\`mermaid\n${slowOld}\n\`\`\``);
      editor.setMode('live');
      editor.setMode('source');
      editor.setText(`\`\`\`mermaid\n${latest}\n\`\`\``);
      editor.view.focus();
      editor.view.dispatch({ selection: { anchor: 4 } });
      editor.setMode('live');
    }, { slowOld: slowOldSource, latest: latestSource });
    await page.waitForFunction((source) => (
      (window as typeof window & { __mermaidCalls?: string[] }).__mermaidCalls?.includes(source)
    ), {}, slowOldSource);
    await page.evaluate((source) => {
      const resolved = (window as typeof window & {
        __resolveMermaid?: (source: string, marker: string) => boolean;
      }).__resolveMermaid?.(source, 'rapid-old');
      if (!resolved) throw new Error('Rapid old Mermaid render was not found');
    }, slowOldSource);
    await page.waitForFunction((source) => (
      (window as typeof window & { __mermaidCalls?: string[] }).__mermaidCalls?.includes(source)
    ), {}, latestSource);
    await page.evaluate((source) => {
      const resolved = (window as typeof window & {
        __resolveMermaid?: (source: string, marker: string) => boolean;
      }).__resolveMermaid?.(source, 'rapid-latest');
      if (!resolved) throw new Error('Rapid latest Mermaid render was not found');
    }, latestSource);
    await page.waitForSelector('.cm-editor svg[data-marker="rapid-latest"]');
    const rapidResult = await page.evaluate(() => {
      const testWindow = window as typeof window & {
        __sourceMermaidEditor?: any;
        __mermaidMaxActive?: number;
      };
      const editor = testWindow.__sourceMermaidEditor;
      return {
        latestVisible: Boolean(document.querySelector('.cm-editor svg[data-marker="rapid-latest"]')),
        oldVisible: Boolean(document.querySelector('.cm-editor svg[data-marker="rapid-old"]')),
        text: editor.view.state.doc.toString(),
        selection: editor.view.state.selection.main.head,
        focused: editor.view.hasFocus,
        maxActive: testWindow.__mermaidMaxActive
      };
    });
    assert.deepEqual(rapidResult, {
      latestVisible: true,
      oldVisible: false,
      text: `\`\`\`mermaid\n${latestSource}\n\`\`\``,
      selection: 4,
      focused: true,
      maxActive: 1
    });

    const destroySource = 'graph TD\nDESTROY-->PENDING';
    await page.evaluate((source) => {
      const editor = (window as typeof window & { __sourceMermaidEditor?: any }).__sourceMermaidEditor;
      editor.setText(`\`\`\`mermaid\n${source}\n\`\`\``);
    }, destroySource);
    await page.waitForFunction((source) => (
      (window as typeof window & { __mermaidCalls?: string[] }).__mermaidCalls?.includes(source)
    ), {}, destroySource);
    await page.evaluate((source) => {
      const testWindow = window as typeof window & {
        __sourceMermaidEditor?: any;
        __resolveMermaid?: (source: string, marker: string) => boolean;
      };
      testWindow.__sourceMermaidEditor.destroy();
      if (!testWindow.__resolveMermaid?.(source, 'destroyed')) {
        throw new Error('Destroy-pending Mermaid render was not found');
      }
    }, destroySource);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(await page.evaluate(() => ({
      editors: document.querySelectorAll('.cm-editor').length,
      liveMermaid: document.querySelectorAll('.cm-editor .meo-mermaid-block').length
    })), { editors: 0, liveMermaid: 0 });

    console.log('Source Mermaid shared-consumer production lifecycle passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
