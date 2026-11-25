import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'puppeteer-core';

const dist = path.resolve(import.meta.dir, '../webview/dist');
let origin: string | undefined;
let ready: Promise<string> | undefined;

/** Bounded fixture evidence for a packaged-runtime load failure. */
export interface MermaidRuntimeInstallObservation {
  readonly stage: 'server-creating' | 'server-listening' | 'server-reused' | 'server-request' | 'server-response' | 'server-error' | 'script-loading';
  readonly origin?: string;
  readonly url?: string;
  readonly status?: number;
  readonly contentType?: string;
  readonly error?: string;
}

export interface PackagedMermaidInstallOptions {
  readonly observe?: (observation: MermaidRuntimeInstallObservation) => void;
}

/** Serve the same local asset graph used by the installed extension. */
export function readMermaidTestAsset(url: string, base: string): Buffer | undefined {
  if (!url.startsWith(base)) return undefined;
  const name = decodeURIComponent(new URL(url).pathname.slice(new URL(base).pathname.length));
  const file = path.resolve(dist, name);
  return file.startsWith(dist + path.sep) && existsSync(file) && statSync(file).isFile()
    ? readFileSync(file) : undefined;
}

export function isMermaidTestRequest(url: string): boolean {
  return origin !== undefined && url.startsWith(origin);
}

async function assetOrigin(options?: PackagedMermaidInstallOptions): Promise<string> {
  const observe = (observation: MermaidRuntimeInstallObservation) => options?.observe?.(observation);
  if (origin !== undefined) {
    observe({ stage: 'server-reused', origin });
    return origin;
  }
  ready ??= new Promise((resolve, reject) => {
    observe({ stage: 'server-creating' });
    const server = createServer((request, response) => {
      const currentOrigin = origin;
      const url = currentOrigin ? new URL(request.url ?? '/', currentOrigin).href : undefined;
      const asset = currentOrigin && url ? readMermaidTestAsset(url, currentOrigin) : undefined;
      const status = asset ? 200 : 404;
      const contentType = 'text/javascript';
      observe({ stage: 'server-request', origin, url, status, contentType });
      response.writeHead(status, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
      response.end(asset || 'Missing Mermaid asset');
      observe({ stage: 'server-response', origin, url, status, contentType });
    });
    server.on('error', error => {
      observe({ stage: 'server-error', error: String(error) });
      reject(error);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('Missing Mermaid fixture address')); return; }
      origin = `http://127.0.0.1:${address.port}/`;
      observe({ stage: 'server-listening', origin });
      server.unref();
      resolve(origin);
    });
  });
  const resolvedOrigin = await ready;
  observe({ stage: 'server-reused', origin: resolvedOrigin });
  return resolvedOrigin;
}

export async function installPackagedMermaid(page: Page, options?: PackagedMermaidInstallOptions): Promise<void> {
  const assetUrl = new URL('mermaid.min.js', await assetOrigin(options)).href;
  options?.observe?.({ stage: 'script-loading', origin, url: assetUrl });
  await page.addScriptTag({ url: assetUrl });
  await page.evaluate(() => (window as typeof window & { __MEO_MERMAID_READY__: Promise<unknown> }).__MEO_MERMAID_READY__);
}

export async function assertMermaidLabelLayout(
  scope: Pick<Page, '$$eval'>,
  selector: string,
  samples: readonly { readonly labels: readonly string[]; readonly width?: number;
    readonly singleLine?: readonly string[]; readonly wrapped?: readonly string[]; readonly intactWords?: readonly string[];
    readonly centered?: readonly string[]; readonly manualBreaks?: readonly string[]; readonly paragraphCount?: number }[],
  surface: string
): Promise<void> {
  const layouts = await scope.$$eval(selector, (diagrams, samples) => diagrams.map((diagram, index) => {
    const sample = samples[index]!;
    const labels = [...diagram.querySelectorAll('foreignObject > div > :is(.nodeLabel, .edgeLabel)')];
    return sample.labels.map(text => {
      const label = labels.find(label => label.textContent === text);
      if (!label) return { text, missing: true };
      const doc = label.ownerDocument;
      const view = doc.defaultView!;
      const boundary = label.closest('foreignObject')!.getBoundingClientRect();
      const range = doc.createRange();
      range.selectNodeContents(label);
      const glyphs = range.getBoundingClientRect();
      const tolerance = 0.5;
      const clipped = glyphs.height === 0 || glyphs.width === 0
        || glyphs.left < boundary.left - tolerance || glyphs.right > boundary.right + tolerance
        || glyphs.top < boundary.top - tolerance || glyphs.bottom > boundary.bottom + tolerance;
      const paragraphs = label.querySelectorAll(':scope > p');
      const paragraph = paragraphs[0]!;
      const textNodes = doc.createTreeWalker(label, NodeFilter.SHOW_TEXT);
      const splitWords: string[] = [];
      const lines = new Map<number, { left: number; right: number }>();
      while (textNodes.nextNode()) {
        const node = textNodes.currentNode;
        if (sample.centered?.includes(text)) {
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) {
            if (!rect.width) continue;
            const line = lines.get(rect.top);
            lines.set(rect.top, { left: Math.min(rect.left, line?.left ?? rect.left), right: Math.max(rect.right, line?.right ?? rect.right) });
          }
        }
        for (const word of sample.intactWords ?? []) {
          const start = node.textContent?.indexOf(word) ?? -1;
          if (start < 0) continue;
          range.setStart(node, start);
          range.setEnd(node, start + word.length);
          if (range.getClientRects().length > 1) splitWords.push(word);
        }
      }
      const lineOffsets = [...lines.values()].map(({ left, right }) => (left + right - boundary.left - boundary.right) / 2);
      return { text, clipped, width: parseFloat(view.getComputedStyle(label.parentElement!).width), isNode: label.classList.contains('nodeLabel'),
        wraps: paragraphs.length > 1 || paragraph.getBoundingClientRect().height > parseFloat(view.getComputedStyle(paragraph).lineHeight) * 1.5,
        paragraphCount: paragraphs.length, manualBreak: label.querySelector('br') !== null,
        splitWords, lineOffsets,
        glyphs: glyphs.toJSON(), boundary: boundary.toJSON() };
    });
  }), samples);
  assert.equal(layouts.length, samples.length, `${surface}: every label sample must render`);
  for (const [index, labels] of layouts.entries()) {
    for (const label of labels) {
      assert.ok(!label.missing && !label.clipped, `${surface}: label outside the rendered box ${JSON.stringify(label)}`);
      const sample = samples[index]!;
      assert.deepEqual(label.splitWords, [], `${surface}: a word is split across lines in ${label.text}`);
      if (sample.singleLine?.includes(label.text)) assert.ok(!label.wraps, `${surface}: ${label.text} must fit on one line`);
      if (sample.wrapped?.includes(label.text)) assert.ok(label.wraps, `${surface}: ${label.text} must wrap`);
      if (sample.paragraphCount !== undefined) assert.equal(label.paragraphCount, sample.paragraphCount, `${surface}: preserve separate paragraphs`);
      if (sample.manualBreaks?.includes(label.text)) assert.ok(label.manualBreak, `${surface}: preserve the author's line break`);
      if (sample.centered?.includes(label.text)) {
        assert.ok(label.lineOffsets.length && label.lineOffsets.every(offset => Math.abs(offset) < 1),
          `${surface}: each line of ${label.text} must remain centered. Horizontal offsets: ${label.lineOffsets.map(offset => offset.toFixed(2)).join(', ')}px`);
      }
      const width = sample.width;
      if (width !== undefined && label.isNode) {
        assert.equal(label.width, width, `${surface}: the author's wrapping width applies`);
        assert.ok(label.wraps, `${surface}: the label wraps at the author's width`);
      }
    }
  }
}
