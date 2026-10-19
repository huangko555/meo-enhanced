import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'puppeteer-core';

let source: Promise<string> | undefined;

export async function installGitDiffWorker(page: Page, responseDelayMs = 0, elapsedTimeMs = 0): Promise<void> {
  source ??= Bun.build({ entrypoints: [path.resolve(import.meta.dir, '../webview/src/helpers/gitDiffWorker.ts')],
    target: 'browser', format: 'iife', minify: true }).then(async build => {
    assert.ok(build.success, build.logs.map(String).join('\n'));
    assert.equal(build.outputs.length, 1, 'Webview workers must be self-contained');
    return build.outputs[0]!.text();
  });
  const compiled = await source;
  // Advance the algorithm's elapsed-time clock once after request ingress. This
  // reproduces slow line preparation without sleeping or throttling the UI.
  const code = elapsedTimeMs ? `let ticks = 0;
    self.addEventListener('message', () => { ticks = 0; });
    Date.now = () => ticks++ === 0 ? 0 : ${elapsedTimeMs};\n${compiled}` : compiled;
  // Delay transport only to keep cancellation/race tests deterministic. The
  // production worker computation and editor remain unchanged.
  const delayed = responseDelayMs ? `const send = self.postMessage.bind(self);
    self.postMessage = (value) => setTimeout(() => send(value), ${responseDelayMs});\n${code}` : code;
  await page.evaluate(uri => { document.body.dataset.meoGitDiffWorkerSrc = uri; },
    `data:text/javascript;base64,${Buffer.from(delayed).toString('base64')}`);
}
