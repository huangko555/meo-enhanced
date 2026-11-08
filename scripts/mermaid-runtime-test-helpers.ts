import { createServer } from 'node:http';
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
