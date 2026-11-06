import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'puppeteer-core';

const dist = path.resolve(import.meta.dir, '../webview/dist');
let origin: string | undefined;
let ready: Promise<string> | undefined;

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

async function assetOrigin(): Promise<string> {
  ready ??= new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const asset = origin && readMermaidTestAsset(new URL(request.url!, origin).href, origin);
      response.writeHead(asset ? 200 : 404, { 'Content-Type': 'text/javascript', 'Access-Control-Allow-Origin': '*' });
      response.end(asset || 'Missing Mermaid asset');
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('Missing Mermaid fixture address')); return; }
      origin = `http://127.0.0.1:${address.port}/`;
      server.unref();
      resolve(origin);
    });
  });
  return ready;
}

export async function installPackagedMermaid(page: Page): Promise<void> {
  await page.addScriptTag({ url: new URL('mermaid.min.js', await assetOrigin()).href });
  await page.evaluate(() => (window as typeof window & { __MEO_MERMAID_READY__: Promise<unknown> }).__MEO_MERMAID_READY__);
}
