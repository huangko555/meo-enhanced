import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import { installModeLoadingReadiness } from './mode-loading-readiness';

const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 600 });
  await page.setContent(`<!doctype html><style>
    .editor-host,.preview-host{display:block;width:640px;height:320px}
    .preview-host[hidden],.editor-loading[hidden],.preview-loading[hidden],.preview-status[hidden]{display:none}
    .preview-frame{width:640px;height:320px}
  </style><main id="app" data-mode="source">
    <div class="mode-toolbar"><button data-mode="source" aria-selected="true">Source</button><button data-mode="preview" aria-selected="false">Preview</button></div>
    <section class="editor-host" inert aria-busy="true"><div class="cm-content">Large document</div></section>
    <div class="editor-loading">Loading source</div>
    <section class="preview-host" hidden inert aria-busy="true"><iframe class="preview-frame"></iframe></section>
    <div class="preview-loading">Loading preview</div><div class="preview-status" hidden>Ready</div>
  </main>`);
  await page.evaluate(installModeLoadingReadiness);
  const source = await page.evaluate(() => (window as any).__modeLoadingReadiness('source', 'Large document'));
  assert.deepEqual(source, { content: true, interactive: false }, 'Visible content must not be called interactive while its real host is blocked');

  const sourceFrames = await page.evaluate(async () => {
    const scope = window as any;
    const frames: any[] = [];
    await new Promise<void>(resolve => requestAnimationFrame(() => {
      frames.push({ at: performance.now(), state: scope.__modeLoadingReadiness('source', 'Large document') });
      const host = document.querySelector<HTMLElement>('.editor-host')!;
      host.inert = false; host.removeAttribute('aria-busy');
      document.querySelector<HTMLElement>('.editor-loading')!.hidden = true;
      requestAnimationFrame(() => {
        frames.push({ at: performance.now(), state: scope.__modeLoadingReadiness('source', 'Large document') });
        resolve();
      });
    }));
    return frames;
  });
  assert.deepEqual(sourceFrames.map(frame => frame.state), [
    { content: true, interactive: false }, { content: true, interactive: true }
  ], 'The shared RAF samples first content before and then after Source becomes interactive');
  assert.ok(sourceFrames[1]!.at >= sourceFrames[0]!.at);

  const inherited = await page.evaluate(() => {
    const root = document.getElementById('app')!;
    root.inert = true;
    const blocked = (window as any).__modeLoadingReadiness('source', 'Large document');
    root.inert = false;
    const side = document.querySelector<HTMLElement>('.preview-host')!;
    side.hidden = false;
    const sidePending = (window as any).__modeLoadingReadiness('source', 'Large document');
    side.hidden = true;
    const host = document.querySelector<HTMLElement>('.editor-host')!;
    host.setAttribute('aria-busy', 'true');
    const busyOnly = (window as any).__modeLoadingReadiness('source', 'Large document');
    host.removeAttribute('aria-busy');
    host.setAttribute('data-preview-cover', '');
    const previewCover = (window as any).__modeLoadingReadiness('source', 'Large document');
    host.removeAttribute('data-preview-cover');
    return { blocked, sidePending, busyOnly, previewCover };
  });
  assert.deepEqual(inherited.blocked, { content: true, interactive: false }, 'An inert parent still blocks the real content host');
  assert.deepEqual(inherited.sidePending, { content: true, interactive: true }, 'Pending visible side Preview must not delay Source input');
  assert.deepEqual(inherited.busyOnly, { content: true, interactive: false }, 'A busy host cannot be admitted even after its inert and loader flags clear');
  assert.deepEqual(inherited.previewCover, { content: true, interactive: false }, 'The transition cover still blocks Source pointer input after its other loading flags clear');

  await page.evaluate(async () => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    frame.srcdoc = '<main class="meo-export-doc">Large document</main>';
    await new Promise<void>(resolve => { frame.onload = () => resolve(); });
    document.getElementById('app')!.dataset.mode = 'preview';
    document.querySelector<HTMLButtonElement>('button[data-mode="source"]')!.setAttribute('aria-selected', 'false');
    document.querySelector<HTMLButtonElement>('button[data-mode="preview"]')!.setAttribute('aria-selected', 'true');
    const preview = document.querySelector<HTMLElement>('.preview-host')!;
    preview.hidden = false; preview.inert = true; preview.setAttribute('aria-busy', 'true');
    frame.contentDocument!.documentElement.inert = true;
  });
  const previewFrames = await page.evaluate(async () => {
    const scope = window as any;
    const frames: any[] = [];
    await new Promise<void>(resolve => requestAnimationFrame(() => {
      frames.push({ at: performance.now(), state: scope.__modeLoadingReadiness('preview', 'Large document') });
      const preview = document.querySelector<HTMLElement>('.preview-host')!;
      preview.inert = false; preview.removeAttribute('aria-busy');
      document.querySelector<HTMLElement>('.preview-loading')!.hidden = true;
      document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.documentElement.inert = false;
      requestAnimationFrame(() => {
        frames.push({ at: performance.now(), state: scope.__modeLoadingReadiness('preview', 'Large document') });
        resolve();
      });
    }));
    return frames;
  });
  assert.deepEqual(previewFrames.map(frame => frame.state), [
    { content: true, interactive: false }, { content: true, interactive: true }
  ], 'Preview content must wait for its actual host, loading cover and iframe document to be interactive');
  assert.ok(previewFrames[1]!.at >= previewFrames[0]!.at);
  console.log('Mode readiness contract passed');
} catch (error) { primaryError = error; throw error; }
finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
