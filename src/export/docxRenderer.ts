import * as fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { DomUtils, parseDocument } from 'htmlparser2';
import { Element } from 'domhandler';
import JSZip from 'jszip';
import type { UiLanguage } from '../foundation/uiLanguage';
import { materializeDocxBodyFromHtmlExport } from './pdfRenderer';

export type WriteDocxExportOptions = {
  readonly htmlDocument: string;
  readonly outputDocxPath: string;
  readonly title: string;
  readonly uiLanguage: UiLanguage;
  readonly includeTableOfContents: boolean;
  readonly docxRuntimeModulePath: string;
  readonly browserExecutablePath?: string;
  readonly puppeteerRuntimeModulePath: string;
  readonly timeoutMs?: number;
};

type TocEntry = {
  readonly id: string;
  readonly level: number;
  readonly text: string;
};

const TOC_BEGIN_BOOKMARK = 'meo_toc_begin';
const TOC_END_BOOKMARK = 'meo_toc_end';
let docxRuntimePromise: Promise<DocxRuntimeModule> | null = null;

type DocxRuntimeModule = {
  readonly convertHtmlToDocx: (html: string, options: {
    readonly pageSize: 'a4';
    readonly lang: string;
    readonly metadata: { readonly title: string; readonly creator: string };
    readonly tocHtml?: string;
    readonly onWarning: null;
  }) => Promise<Buffer>;
};

export async function writeDocxExport(options: WriteDocxExportOptions): Promise<void> {
  const stagedRoot = findExportRoot(options.htmlDocument);
  if (!stagedRoot) throw new Error('Word export could not find the rendered document body.');

  const needsMaterialization = DomUtils.findOne((element) => (
    (element.name === 'img' && !/^data:image\/(?:png|jpe?g|gif|bmp);base64,/i.test(element.attribs.src ?? ''))
    || classNames(element).includes('meo-export-mermaid')
    || classNames(element).includes('meo-export-math-display')
  ), stagedRoot.children, true) !== null;
  const bodyHtml = needsMaterialization
    ? await materializeDocxBodyFromHtmlExport({
        htmlDocument: options.htmlDocument,
        browserExecutablePath: options.browserExecutablePath,
        puppeteerRuntimeModulePath: options.puppeteerRuntimeModulePath,
        timeoutMs: options.timeoutMs
      })
    : options.htmlDocument;
  const root = findExportRoot(bodyHtml);
  if (!root) throw new Error('Word export could not find the rendered document body.');

  normalizeCodeBlocks(root);
  const headings = prepareHeadingBookmarks(root);
  const includeTableOfContents = options.includeTableOfContents && headings.length > 0;
  const contentsLabel = options.uiLanguage === 'zh-CN' ? '目录' : 'Contents';
  const { convertHtmlToDocx } = await loadDocxRuntime(options.docxRuntimeModulePath);
  const generated = await convertHtmlToDocx(DomUtils.getInnerHTML(root), {
    pageSize: 'a4',
    lang: options.uiLanguage === 'zh-CN' ? 'zh-CN' : 'en-US',
    metadata: {
      title: options.title,
      creator: 'MEO Enhanced'
    },
    ...(includeTableOfContents ? { tocHtml: buildTableOfContentsHtml(contentsLabel, headings) } : {}),
    onWarning: null
  });
  const output = includeTableOfContents ? await markVisibleContentsAsNativeToc(generated) : generated;
  await fs.writeFile(options.outputDocxPath, output);
}

async function loadDocxRuntime(modulePath: string): Promise<DocxRuntimeModule> {
  if (!docxRuntimePromise) {
    docxRuntimePromise = import(pathToFileURL(modulePath).href).then((loaded) => {
      let candidate: unknown = loaded;
      for (let depth = 0; depth < 5; depth += 1) {
        if (
          candidate
          && typeof candidate === 'object'
          && 'convertHtmlToDocx' in candidate
          && typeof candidate.convertHtmlToDocx === 'function'
        ) {
          return candidate as DocxRuntimeModule;
        }
        if (!candidate || typeof candidate !== 'object' || !('default' in candidate)) break;
        candidate = candidate.default;
      }
      throw new Error('Bundled Word conversion runtime did not expose convertHtmlToDocx.');
    });
  }
  return docxRuntimePromise;
}

function normalizeCodeBlocks(root: Element): void {
  const wrappers = DomUtils.findAll((element) => (
    classNames(element).includes('meo-export-code-block-wrap')
  ), root.children);
  for (const wrapper of wrappers) {
    const label = wrapper.children.find((child): child is Element => (
      isElement(child) && classNames(child).includes('meo-export-code-language-label')
    ));
    if (label) DomUtils.removeElement(label);
    const pre = DomUtils.findOne((element) => element.name === 'pre', wrapper.children, true);
    if (!pre) continue;
    const code = DomUtils.findOne((element) => element.name === 'code', pre.children, true);
    if (code) {
      const lines = DomUtils.findAll((element) => (
        classNames(element).includes('meo-export-code-line')
      ), code.children);
      for (const line of lines.slice(0, -1)) {
        DomUtils.appendChild(line, new Element('br', {}, []));
      }
    }
    pre.name = 'p';
    pre.attribs.style = [
      pre.attribs.style,
      'font-family:Consolas,monospace',
      'background-color:#f6f8fa',
      'white-space:pre-wrap',
      'padding:8pt'
    ].filter(Boolean).join(';');
  }
}

function findExportRoot(html: string): Element | null {
  const document = parseDocument(html);
  return DomUtils.findOne((element) => (
    element.attribs?.id === 'meo-export-root'
    || classNames(element).includes('meo-export-doc')
  ), document.children, true) ?? null;
}

function prepareHeadingBookmarks(root: Element): TocEntry[] {
  const headings = DomUtils.findAll((element) => /^h[1-6]$/i.test(element.name), root.children);
  const usedIds = new Set<string>();
  return headings.flatMap((heading, index) => {
    const text = DomUtils.textContent(heading).replace(/\s+/g, ' ').trim();
    if (!text) return [];
    const existingId = heading.attribs.id?.trim();
    let id = existingId || `meo-heading-${index + 1}`;
    if (usedIds.has(id)) id = `meo-heading-${index + 1}`;
    usedIds.add(id);
    heading.attribs.id = id;
    return [{
      id,
      level: Number.parseInt(heading.name.slice(1), 10),
      text
    }];
  });
}

function buildTableOfContentsHtml(label: string, entries: readonly TocEntry[]): string {
  const links = entries.map((entry, index) => {
    const indentation = Math.max(0, entry.level - 1) * 0.28;
    const beginMarker = index === 0 ? `<span id="${TOC_BEGIN_BOOKMARK}"></span>` : '';
    const endMarker = index === entries.length - 1 ? `<span id="${TOC_END_BOOKMARK}"></span>` : '';
    return `<p style="margin-left:${indentation}in;margin-top:0;margin-bottom:4pt">`
      + beginMarker
      + `<a href="#${escapeHtmlAttribute(entry.id)}">${escapeHtml(entry.text)}</a>`
      + `${endMarker}</p>`;
  }).join('');
  return `<p><strong>${escapeHtml(label)}</strong></p>${links}`;
}

async function markVisibleContentsAsNativeToc(buffer: Buffer): Promise<Buffer> {
  const archive = await JSZip.loadAsync(buffer);
  const documentEntry = archive.file('word/document.xml');
  const settingsEntry = archive.file('word/settings.xml');
  if (!documentEntry || !settingsEntry) throw new Error('Word export produced an incomplete DOCX package.');

  const documentXml = await documentEntry.async('string');
  const beginIndex = documentXml.indexOf(`w:name="${TOC_BEGIN_BOOKMARK}"`);
  const endIndex = documentXml.indexOf(`w:name="${TOC_END_BOOKMARK}"`);
  if (beginIndex < 0 || endIndex < 0 || beginIndex >= endIndex) {
    throw new Error('Word export could not cache the generated table of contents.');
  }
  const beginBookmarkStart = documentXml.lastIndexOf('<w:bookmarkStart', beginIndex);
  const endBookmarkStartEnd = documentXml.indexOf('/>', endIndex) + 2;
  const endBookmarkEnd = documentXml.indexOf('/>', endBookmarkStartEnd) + 2;
  if (beginBookmarkStart < 0 || endBookmarkEnd < 2) {
    throw new Error('Word export could not locate the table-of-contents field boundaries.');
  }
  const fieldBegin = '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>'
    + '<w:r><w:instrText xml:space="preserve"> TOC \\h \\o "1-6" \\z \\u </w:instrText></w:r>'
    + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>';
  const fieldEnd = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
  const withBegin = documentXml.slice(0, beginBookmarkStart)
    + fieldBegin
    + documentXml.slice(beginBookmarkStart);
  const shiftedEndBookmarkEnd = endBookmarkEnd + fieldBegin.length;
  const withField = withBegin.slice(0, shiftedEndBookmarkEnd)
    + fieldEnd
    + withBegin.slice(shiftedEndBookmarkEnd);
  archive.file('word/document.xml', withField);

  const settingsXml = await settingsEntry.async('string');
  if (!/<w:updateFields\b/.test(settingsXml)) {
    archive.file('word/settings.xml', settingsXml.replace(
      '</w:settings>',
      '<w:updateFields w:val="true"/></w:settings>'
    ));
  }
  return archive.generateAsync({ type: 'nodebuffer' });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value);
}

function classNames(element: Element): string[] {
  return (element.attribs.class ?? '').split(/\s+/).filter(Boolean);
}

function isElement(node: unknown): node is Element {
  return typeof node === 'object' && node !== null && 'name' in node && 'attribs' in node;
}
