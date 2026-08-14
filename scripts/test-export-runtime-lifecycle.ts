import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeHtmlExport } from '../src/export/htmlExport';
import { renderPdfFromHtmlExport } from '../src/export/pdfRenderer';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-export-runtime-contract-'));
const runtimePath = path.join(fixtureRoot, 'fake-puppeteer.mjs');
const logPath = path.join(fixtureRoot, 'events.log');
fs.writeFileSync(runtimePath, `
import fs from 'node:fs';
const log = (event) => fs.appendFileSync(process.env.MEO_EXPORT_TEST_LOG, event + '\\n');
const fail = (stage) => {
  if (process.env.MEO_EXPORT_TEST_FAIL_STAGE === stage) throw new Error(stage + ' failed');
};
export default {
  async launch() {
    log('launch');
    fail('launch');
    return {
      async newPage() {
        log('newPage');
        fail('newPage');
        return {
          setDefaultNavigationTimeout() {},
          setDefaultTimeout() {},
          async emulateMediaType() {},
          async goto(url) { log('goto:' + url); fail('goto'); },
          async waitForFunction() { log('wait'); fail('wait'); },
          async setViewport() {},
          async evaluate(fn) {
            const source = String(fn);
            if (source.includes('__MEO_EXPORT_ERROR__')) {
              return process.env.MEO_EXPORT_TEST_PAGE_ERROR || null;
            }
            if (source.includes('meo-export-math-fenced-display')) return [];
            return undefined;
          },
          async pdf() { log('pdf'); fail('action'); }
        };
      },
      async close() {
        log('close');
        if (process.env.MEO_EXPORT_TEST_CLEANUP_FAIL === 'true') throw new Error('close failed');
        fail('close');
      }
    };
  }
};
`, 'utf8');

process.env.MEO_EXPORT_TEST_LOG = logPath;

const tempDirectories = () => new Set(
  fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('meo-export-'))
);

const run = async (options: { failStage?: string; pageError?: string; cleanupFail?: boolean } = {}) => {
  process.env.MEO_EXPORT_TEST_FAIL_STAGE = options.failStage ?? '';
  process.env.MEO_EXPORT_TEST_PAGE_ERROR = options.pageError ?? '';
  process.env.MEO_EXPORT_TEST_CLEANUP_FAIL = options.cleanupFail ? 'true' : '';
  fs.writeFileSync(logPath, '', 'utf8');
  const before = tempDirectories();
  let error: unknown;
  try {
    await renderPdfFromHtmlExport({
      htmlDocument: '<!doctype html><html><body>fixture</body></html>',
      outputPdfPath: path.join(fixtureRoot, 'output.pdf'),
      browserExecutablePath: process.execPath,
      puppeteerRuntimeModulePath: runtimePath,
      timeoutMs: 1000
    });
  } catch (caught) {
    error = caught;
  }
  const after = tempDirectories();
  assert.deepEqual([...after].filter((name) => !before.has(name)), [], 'headless export must remove its temporary directory');
  return {
    error,
    events: fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
  };
};

try {
  const htmlOutputPath = path.join(fixtureRoot, 'mermaid.html');
  await writeHtmlExport({
    htmlDocument: '<!doctype html><html><body><pre class="mermaid">graph TD; A-->B</pre></body></html>',
    outputHtmlPath: htmlOutputPath
  });
  assert.match(fs.readFileSync(htmlOutputPath, 'utf8'), /class="mermaid"/);

  const success = await run();
  assert.equal(success.error, undefined);
  assert.equal(success.events.at(-1), 'close');

  for (const stage of ['launch', 'newPage', 'goto', 'wait', 'action']) {
    const result = await run({ failStage: stage });
    assert.equal((result.error as Error | undefined)?.message, `${stage} failed`);
    assert.equal(result.events.includes('close'), stage !== 'launch');
  }

  const pageFailure = await run({ pageError: 'page runtime failed' });
  assert.equal((pageFailure.error as Error | undefined)?.message, 'Export render failed: page runtime failed');
  assert.equal(pageFailure.events.at(-1), 'close');

  const cleanupFailure = await run({ cleanupFail: true });
  assert.equal((cleanupFailure.error as Error | undefined)?.message, 'close failed');

  const primaryFailure = await run({ failStage: 'action', cleanupFail: true });
  assert.equal((primaryFailure.error as Error | undefined)?.message, 'action failed');

  console.log('Export runtime lifecycle checks passed');
} finally {
  delete process.env.MEO_EXPORT_TEST_LOG;
  delete process.env.MEO_EXPORT_TEST_FAIL_STAGE;
  delete process.env.MEO_EXPORT_TEST_PAGE_ERROR;
  delete process.env.MEO_EXPORT_TEST_CLEANUP_FAIL;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
