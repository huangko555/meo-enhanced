const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-extension-installed-'));
const installedEntryPath = path.join(installRoot, 'extension.js');
const originalLoad = Module._load;

async function main() {
let worker;
try {
  fs.copyFileSync(path.join(__dirname, '..', 'dist', 'extension.js'), installedEntryPath);
  // VS Code supplies this external module; every other dependency must be bundled.
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  const extension = require(installedEntryPath);
  assert.equal(typeof extension.activate, 'function');
  console.log('Installed extension entry loads in Node without development dependencies.');
  const workerPath = path.join(installRoot, 'preview-render-worker.js');
  fs.copyFileSync(path.join(__dirname, '..', 'dist', 'preview-render-worker.js'), workerPath);
  worker = new Worker(workerPath);
  const request = (id, options, operation = {}) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Installed Preview worker timed out')); }, 15000);
    const cleanup = () => { clearTimeout(timeout); worker.off('message', receive); worker.off('error', fail); };
    const receive = result => { if (result.id === id) { cleanup(); resolve(result); } };
    const fail = error => { cleanup(); reject(error); };
    worker.on('message', receive); worker.on('error', fail);
    worker.postMessage({ id, kind: 'render', ...(options === undefined ? {} : { options }), ...operation });
  });
  let heartbeats = 0;
  const heartbeat = setInterval(() => { heartbeats += 1; }, 5);
  let result;
  try {
    result = await request(1, { markdownText: '# Background Preview\n\n' + '```js\nconst value = 42;\n```\n\n'.repeat(1000),
      sourceDocumentPath: '/fixture/sample.md', uiLanguage: 'en' });
  } finally { clearInterval(heartbeat); }
  assert.equal(result.id, 1);
  assert.ok(result.value.html.includes('Background Preview'));
  assert.ok(heartbeats > 3, 'expensive Preview rendering must leave the Host event loop responsive');
  const failure = await request(2, { markdownText: '', sourceDocumentPath: '/fixture/sample.md', uiLanguage: 'en',
    preset: 'default', presetDefinition: { id: 'github-readme' } });
  assert.match(failure.error, /preset/);
  const alertTypes = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'];
  const resumed = await request(3, { markdownText: '**after failure**\n\n'
    + alertTypes.map(type => `> [!${type}]\n> Alert content.\n\n`).join(''),
    sourceDocumentPath: '/fixture/sample.md', uiLanguage: 'en' });
  assert.ok(resumed.value.html.includes('<strong>after failure</strong>'));
  for (const type of alertTypes) assert.ok(resumed.value.html.includes(`meo-export-alert-${type.toLowerCase()}`));
  assert.equal((resumed.value.html.match(/<svg\b/g) ?? []).length, alertTypes.length,
    'all five alert icons must survive the installed Node bundle');
  const opened = await request(4, { markdownText: '# Window\n\n' + '```js\nconst value = 42;\n```\n\n'.repeat(1000),
    sourceDocumentPath: '/fixture/window.md', uiLanguage: 'en' }, { kind: 'open', owner: 'panel-a', documentId: 'window-1', anchorLine: 1 });
  assert.equal(opened.value.html, '');
  assert.equal(opened.value.document.blocks.length, 1001);
  assert.ok(opened.value.document.chunks.length <= 12);
  const op = operation => ({ kind: 'document', owner: 'panel-a', documentId: 'window-1', operation });
  const tail = await request(5, undefined, op({ kind: 'blocks', indices: [1000] }));
  assert.equal(tail.value.chunks.length, 1);
  assert.equal(tail.value.chunks[0].index, 1000);
  const found = await request(6, undefined, op({ kind: 'search', query: 'value', wholeWord: true, caseSensitive: false, selectIndex: 999 }));
  assert.equal(found.value.total, 1000);
  assert.equal(found.value.active.block, 1000);
  const foreign = await request(7, undefined, { ...op({ kind: 'blocks', indices: [0] }), owner: 'panel-b' });
  assert.match(foreign.error, /expired/);
  await request(8, undefined, { kind: 'release', owner: 'panel-a' });
  const expired = await request(9, undefined, op({ kind: 'blocks', indices: [0] }));
  assert.match(expired.error, /expired/);
  console.log('Installed Preview worker renders in Node, isolates CPU work and survives a rejected request.');
  console.log('Preview documents render requested blocks, search offscreen content and isolate/release owners.');
} finally {
  Module._load = originalLoad;
  await worker?.terminate();
  fs.rmSync(installRoot, { recursive: true, force: true });
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
