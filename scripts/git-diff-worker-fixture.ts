import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'puppeteer-core';

let source: Promise<string> | undefined;

export async function installGitDiffWorker(page: Page, responseDelayMs = 0): Promise<void> {
  source ??= Bun.build({ entrypoints: [path.resolve(import.meta.dir, '../webview/src/helpers/gitDiffWorker.ts')],
    target: 'browser', format: 'iife', minify: true }).then(async build => {
    assert.ok(build.success, build.logs.map(String).join('\n'));
    assert.equal(build.outputs.length, 1, 'Webview workers must be self-contained');
    return build.outputs[0]!.text();
  });
  const code = await source;
  // Delay transport only to keep cancellation/race tests deterministic. The
  // production worker computation and editor remain unchanged.
  const delayed = responseDelayMs ? `const send = self.postMessage.bind(self);
    self.postMessage = (value) => setTimeout(() => send(value), ${responseDelayMs});\n${code}` : code;
  await page.evaluate(uri => { document.body.dataset.meoGitDiffWorkerSrc = uri; },
    `data:text/javascript;base64,${Buffer.from(delayed).toString('base64')}`);
}
