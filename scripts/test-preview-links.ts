import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-preview-links-'));
const build = await Bun.build({
  entrypoints: [path.join(repoRoot, 'scripts', 'test-preview-mermaid-runtime-entry.ts')],
  outdir: tempDir,
  target: 'browser',
  format: 'iife',
  external: ['mermaid']
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><body></body>');
  await page.addScriptTag({ path: path.join(tempDir, 'test-preview-mermaid-runtime-entry.js') });
  await page.evaluate(() => {
    const controller = (window as any).__previewController;
    const messages = (window as any).__previewMessages as Array<{ type?: string; requestId?: string }>;
    const html = [
      '<div class="meo-export-doc">',
      '<a id="external" href="https://example.com/">External</a>',
      '<a id="ticket" href="https://docs.example.com/issues">Ticket</a>',
      '<a id="theme" href="./docs/theming.md">Guide</a>',
      '<a id="changelog" href="CHANGELOG.md">Changelog</a>',
      '<a id="license" href="LICENSE">License</a>',
      '<a id="fragment" href="#target">Fragment</a>',
      '<h2 id="target">Target</h2>',
      '</div>'
    ].join('');
    for (let round = 0; round < 3; round += 1) {
      controller.preload(`README links ${round}`);
      const requestId = messages.findLast((message) => message.type === 'requestPreviewRender')?.requestId;
      controller.handleRendered({
        type: 'previewRendered',
        requestId,
        hasMermaid: false,
        styles: { dark: '', light: '' },
        html
      });
    }
    controller.setVisible(true);
  });
  await page.waitForFunction(() => Boolean(
    document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.getElementById('license')
  ));
  const clickPoint = await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const link = frame.contentDocument!.getElementById('changelog')!;
    const frameRect = frame.getBoundingClientRect();
    const linkRect = link.getBoundingClientRect();
    return {
      x: frameRect.left + linkRect.left + linkRect.width / 2,
      y: frameRect.top + linkRect.top + linkRect.height / 2
    };
  });
  await page.evaluate(() => {
    ((window as any).__previewMessages as unknown[]).length = 0;
  });
  await page.mouse.click(clickPoint.x, clickPoint.y);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const trustedClickResult = await page.evaluate(() => {
    const messages = (window as any).__previewMessages as Array<{
      type?: string;
      href?: string;
      source?: string;
    }>;
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const link = frame.contentDocument?.getElementById('changelog') as HTMLAnchorElement | null;
    return {
      messages: messages.map(({ type, href, source }) => ({ type, href, source })),
      documentPresent: Boolean(frame.contentDocument?.querySelector('.meo-export-doc')),
      nativeHref: link?.getAttribute('href') ?? null,
      brokeredHref: link?.dataset.meoPreviewHref ?? null,
      role: link?.getAttribute('role') ?? null,
      tabIndex: link?.tabIndex ?? -1,
      cursor: link ? frame.contentWindow?.getComputedStyle(link).cursor ?? null : null
    };
  });
  if (
    trustedClickResult.messages.length !== 1 ||
    trustedClickResult.messages[0]?.type !== 'openLink' ||
    trustedClickResult.messages[0]?.href !== 'CHANGELOG.md' ||
    trustedClickResult.messages[0]?.source !== 'preview' ||
    !trustedClickResult.documentPresent ||
    trustedClickResult.nativeHref !== null ||
    trustedClickResult.brokeredHref !== 'CHANGELOG.md' ||
    trustedClickResult.role !== 'link' ||
    trustedClickResult.tabIndex !== 0 ||
    trustedClickResult.cursor !== 'pointer'
  ) {
    throw new Error(`Trusted Preview link click was not intercepted: ${JSON.stringify(trustedClickResult)}`);
  }

  const modifiedClickPoint = await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const link = frame.contentDocument!.getElementById('external')!;
    const frameRect = frame.getBoundingClientRect();
    const linkRect = link.getBoundingClientRect();
    ((window as any).__previewMessages as unknown[]).length = 0;
    return {
      x: frameRect.left + linkRect.left + linkRect.width / 2,
      y: frameRect.top + linkRect.top + linkRect.height / 2
    };
  });
  await page.keyboard.down('Control');
  await page.mouse.click(modifiedClickPoint.x, modifiedClickPoint.y);
  await page.keyboard.up('Control');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const modifiedClickResult = await page.evaluate(() => ({
    messages: (window as any).__previewMessages,
    documentPresent: Boolean(
      document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('.meo-export-doc')
    )
  }));
  if (
    modifiedClickResult.messages.length !== 1 ||
    modifiedClickResult.messages[0]?.href !== 'https://example.com/' ||
    modifiedClickResult.messages[0]?.source !== 'preview' ||
    !modifiedClickResult.documentPresent
  ) {
    throw new Error(`Modified Preview link click was not intercepted: ${JSON.stringify(modifiedClickResult)}`);
  }

  const result = await page.evaluate(async () => {
    const messages = (window as any).__previewMessages as Array<{
      type?: string;
      href?: string;
      source?: string;
    }>;
    messages.length = 0;
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const frameDocument = frame.contentDocument!;
    for (const id of ['external', 'ticket', 'theme', 'changelog', 'license', 'fragment']) {
      frameDocument.getElementById(id)!.click();
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return {
      messages: messages.map(({ type, href, source }) => ({ type, href, source })),
      documentPresent: Boolean(frame.contentDocument?.querySelector('.meo-export-doc')),
      linkCount: frame.contentDocument?.querySelectorAll('a').length ?? 0
    };
  });
  const expectedHrefs = [
    'https://example.com/',
    'https://docs.example.com/issues',
    './docs/theming.md',
    'CHANGELOG.md',
    'LICENSE'
  ];
  const actualHrefs = result.messages
    .filter((message) => message.type === 'openLink')
    .map((message) => message.href);
  const previewSources = result.messages
    .filter((message) => message.type === 'openLink')
    .map((message) => message.source);
  if (
    JSON.stringify(actualHrefs) !== JSON.stringify(expectedHrefs) ||
    previewSources.some((source) => source !== 'preview') ||
    !result.documentPresent ||
    result.linkCount !== 6
  ) {
    throw new Error(`Preview link click routing was inconsistent: ${JSON.stringify(result)}`);
  }
} finally {
  await browser.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('Preview link checks passed');
