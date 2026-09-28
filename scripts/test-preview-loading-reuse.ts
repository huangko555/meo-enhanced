import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const build = await Bun.build({
  entrypoints: ['scripts/test-preview-mermaid-runtime-entry.ts'],
  target: 'browser', format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  for (const scenario of ['reuse', 'replace', 'force', 'failed', 'dispose']) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    const releases: Array<() => Promise<void>> = [];
    let holdStyles = true;
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (request.url() !== 'https://preview-load.test/held.css') {
        void request.continue();
        return;
      }
      const release = () => request.respond({ status: 200, contentType: 'text/css', body: '' });
      if (holdStyles) releases.push(release);
      else void release();
    });
    await page.setContent('<!doctype html><body></body>');
    await page.addScriptTag({ content: await build.outputs[0]!.text() });
    const request = async (text: string, force = false) => page.evaluate(({ text, force }) => {
      const scope = window as any;
      void scope.__previewController.requestRender(text, { force });
      return scope.__previewMessages.filter((m: any) => m.type === 'requestPreviewRender').length;
    }, { text, force });
    const respond = async (index: number, text: string, failure = false) => {
      const value = exportRuntime.renderPreviewDocument({ markdownText: text,
        sourceDocumentPath: 'C:/tmp/preview-load.md', uiLanguage: 'en' });
      // Hold srcdoc's load event after the actual Host response has completed.
      value.html += '<link rel="stylesheet" href="https://preview-load.test/held.css">';
      return page.evaluate(({ index, value, failure }) => {
        const scope = window as any;
        const message = scope.__previewMessages.filter((m: any) => m.type === 'requestPreviewRender')[index];
        return scope.__previewController.acceptRenderResponse({ type: 'previewRenderResult',
          requestId: message.requestId, result: failure
            ? { ok: false, error: { code: 'operation-failed', message: 'fixture failure' } }
            : { ok: true, value } });
      }, { index, value, failure });
    };
    assert.equal(await request('# Initial document'), 1);
    if (scenario === 'failed') {
      await respond(0, '# Initial document', true);
      assert.equal(await request('# Initial document'), 2, 'A failed Host response must remain retryable');
      await respond(1, '# Initial document');
    } else {
      await respond(0, '# Initial document');
    }
    await page.waitForFunction(() => (window as any).__previewController.host.querySelector('iframe').contentDocument
      ?.querySelector('main.meo-export-doc')?.textContent?.includes('Initial document'));
    assert.equal(await page.evaluate(() => (window as any).__previewRenderedAt ?? null), null,
      'The stylesheet gate must hold frame initialization, not just delay the Host');
    let expected = 'Initial document';
    if (scenario === 'replace' || scenario === 'force') {
      const next = scenario === 'replace' ? '# Replacement document' : '# Initial document';
      assert.equal(await request(next, scenario === 'force'), 2, 'Changed text and forced refresh must render');
      await respond(1, next);
      assert.equal(await respond(0, '# Initial document'), false, 'A retired response must not replace the latest frame');
      expected = scenario === 'replace' ? 'Replacement document' : expected;
    } else if (scenario === 'dispose') {
      await page.evaluate(() => (window as any).__previewController.dispose());
      assert.equal(await request('# Initial document'), 1, 'Disposed surfaces must not request more work');
    } else {
      assert.equal(await request('# Initial document'), scenario === 'failed' ? 2 : 1,
        'Activation during iframe loading must reuse the accepted presentation');
    }
    holdStyles = false;
    await Promise.all(releases.map(release => release()));
    if (scenario === 'dispose') {
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(await page.evaluate(() => (window as any).__previewRenderedAt ?? null), null);
    } else {
      await page.waitForFunction(expected => Boolean((window as any).__previewRenderedAt)
        && (window as any).__previewController.host.querySelector('iframe').contentDocument
          ?.querySelector('main.meo-export-doc')?.textContent?.includes(expected), {}, expected);
      const before = await page.evaluate(() => (window as any).__previewMessages.length);
      await request(`# ${expected}`);
      assert.equal(await page.evaluate(() => (window as any).__previewMessages.length), before,
        'Ready presentation reuse must still avoid a Host request');
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Preview pending-frame reuse, replacement, force, retry and disposal checks passed');
} catch (error) { primaryError = error; }
finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
