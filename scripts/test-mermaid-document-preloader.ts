import assert from 'node:assert/strict';
import type { MermaidDiagramRenderRequest } from '../webview/src/application/mermaidDiagramRenderResources';
import { preloadMermaidDocumentBatch } from '../webview/src/helpers/mermaidDocumentPreloader';

const request = (index: number): MermaidDiagramRenderRequest => ({
  rawSource: `graph TD\nA${index}-->B${index}`,
  normalizedSource: `graph TD\nA${index}-->B${index}`,
  themeKey: 'dark',
  configKey: 'editor-v1',
  priority: 'normal'
});

const requests = Array.from({ length: 40 }, (_, index) => request(index));
const preloaded: string[] = [];
let refreshCount = 0;
await preloadMermaidDocumentBatch(
  {
    async preload(item) {
      preloaded.push(item.rawSource);
    }
  },
  requests,
  () => true,
  () => { refreshCount += 1; }
);
assert.equal(preloaded.length, requests.length);
assert.equal(
  refreshCount,
  1,
  'one Mermaid warm-up batch must never dispatch one whole-editor refresh per diagram'
);

await preloadMermaidDocumentBatch(
  { async preload() {} },
  [],
  () => true,
  () => { refreshCount += 1; }
);
assert.equal(refreshCount, 1, 'an empty warm-up batch must not request a refresh');

let cachedPreloadCount = 0;
await preloadMermaidDocumentBatch(
  {
    getCached: () => ({ ok: true, svg: '<svg/>' }),
    async preload() { cachedPreloadCount += 1; }
  },
  requests.slice(0, 2),
  () => true,
  () => { refreshCount += 1; }
);
assert.equal(cachedPreloadCount, 0, 'cached diagrams should not be warmed again');
assert.equal(refreshCount, 1, 'cached diagrams should not refresh the whole Live document');

await preloadMermaidDocumentBatch(
  {
    getCached: (item) => item.rawSource === requests[0]!.rawSource
      ? { ok: true, svg: '<svg/>' } : null,
    async preload() { cachedPreloadCount += 1; }
  },
  requests.slice(0, 2),
  () => true,
  () => { refreshCount += 1; }
);
assert.equal(cachedPreloadCount, 1, 'only an uncached diagram should be warmed');
assert.equal(refreshCount, 2, 'newly warmed diagrams still refresh mounted presentation');

let active = true;
let stoppedPreloadCount = 0;
await preloadMermaidDocumentBatch(
  {
    async preload() {
      stoppedPreloadCount += 1;
      active = false;
    }
  },
  requests,
  () => active,
  () => { refreshCount += 1; }
);
assert.equal(stoppedPreloadCount, 1);
assert.equal(refreshCount, 2, 'a disposed warm-up batch must not request a stale refresh');

let yielded = false;
let countBeforeInput = 0;
await preloadMermaidDocumentBatch({
  async preload() {
    countBeforeInput += 1;
    if (countBeforeInput === 1) setTimeout(() => { yielded = true; }, 0);
    else assert.ok(yielded, 'Input tasks must run between completed diagram preloads');
  }
}, requests.slice(0, 2), () => true, () => {});

console.log('Mermaid document preloader batch refresh contract passed');
