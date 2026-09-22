import * as fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { DomUtils, parseDocument } from 'htmlparser2';
import { Element, Text, type ChildNode } from 'domhandler';
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
  readonly level: number;
  readonly text: string;
  readonly bookmarkName: string;
  readonly headingMarker: string;
  readonly tocMarker: string;
};

const wordBodyFonts = '<w:rFonts w:ascii="DengXian" w:hAnsi="DengXian" w:eastAsia="等线" w:cs="DengXian"/>';

let docxRuntimePromise: Promise<DocxRuntimeModule> | null = null;

type DocxRuntimeModule = {
  readonly convertHtmlToDocx: (html: string, options: {
    readonly lang: string;
    readonly title: string;
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
  const documentHtml = needsMaterialization
    ? replaceExportRoot(
        options.htmlDocument,
        await materializeDocxBodyFromHtmlExport({
          htmlDocument: options.htmlDocument,
          browserExecutablePath: options.browserExecutablePath,
          puppeteerRuntimeModulePath: options.puppeteerRuntimeModulePath,
          timeoutMs: options.timeoutMs
        })
      )
    : options.htmlDocument;

  const document = parseDocument(documentHtml);
  const root = findExportRootInNodes(document.children);
  if (!root) throw new Error('Word export could not prepare the rendered document body.');

  removeExecutableContent(document.children);
  normalizeCodeBlocks(root);
  normalizeFrontmatter(root);
  normalizeTables(root);
  const headings = options.includeTableOfContents ? prepareHeadingBookmarks(root) : [];
  const includeTableOfContents = headings.length > 0;
  if (includeTableOfContents) {
    prependTableOfContents(root, options.uiLanguage === 'zh-CN' ? '目录' : 'Contents', headings);
  }

  const { convertHtmlToDocx } = await loadDocxRuntime(options.docxRuntimeModulePath);
  const generated = await convertHtmlToDocx(DomUtils.getOuterHTML(document), {
    lang: options.uiLanguage === 'zh-CN' ? 'zh-CN' : 'en-US',
    title: options.title
  });
  const output = await finalizeWordDocument(generated, headings);
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

function replaceExportRoot(originalHtml: string, replacementRootHtml: string): string {
  const document = parseDocument(originalHtml);
  const originalRoot = findExportRootInNodes(document.children);
  const replacementRoot = findExportRoot(replacementRootHtml);
  if (!originalRoot || !replacementRoot) {
    throw new Error('Word export could not merge materialized document content.');
  }
  DomUtils.replaceElement(originalRoot, replacementRoot);
  return DomUtils.getOuterHTML(document);
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
    removeClassNames(pre, ['meo-export-code-block']);
    pre.attribs.style = appendInlineStyles(pre.attribs.style, [
      'font-family:Consolas,monospace',
      'font-size:10pt',
      'line-height:1.3',
      'text-align:left',
      'background-color:#f6f8fa',
      'white-space:pre-wrap',
      'padding:8pt'
    ]);

    const code = DomUtils.findOne((element) => element.name === 'code', pre.children, true);
    if (!code) continue;
    delete code.attribs.class;
    code.attribs.style = appendInlineStyles(code.attribs.style, [
      'font-family:Consolas,monospace',
      'font-size:10pt',
      'line-height:1.3',
      'white-space:pre-wrap'
    ]);

    const lines = DomUtils.findAll((element) => (
      classNames(element).includes('meo-export-code-line')
    ), code.children);
    for (const [index, line] of lines.entries()) {
      const lineNumber = DomUtils.findOne((element) => (
        classNames(element).includes('meo-export-code-line-number')
      ), line.children, true);
      if (lineNumber) DomUtils.removeElement(lineNumber);
      removeClassNames(line, ['meo-export-code-line']);
      line.attribs.style = appendInlineStyles(line.attribs.style, [
        'display:inline',
        'font-family:Consolas,monospace',
        'font-size:10pt',
        'line-height:1.3',
        'white-space:pre-wrap'
      ]);
      const source = DomUtils.findOne((element) => (
        classNames(element).includes('meo-export-code-line-source')
      ), line.children, true);
      if (source) {
        removeClassNames(source, ['meo-export-code-line-source']);
        source.attribs.style = appendInlineStyles(source.attribs.style, [
          'display:inline',
          'font-family:Consolas,monospace',
          'font-size:10pt',
          'line-height:1.3',
          'white-space:pre-wrap'
        ]);
      }
      if (index < lines.length - 1) DomUtils.appendChild(line, new Element('br', {}, []));
    }
  }
}

function normalizeFrontmatter(root: Element): void {
  const sections = DomUtils.findAll((element) => (
    classNames(element).includes('meo-export-frontmatter')
  ), root.children);
  for (const section of sections) {
    const header = DomUtils.findOne((element) => (
      classNames(element).includes('meo-export-frontmatter-header')
    ), section.children, true);
    const label = header ? DomUtils.textContent(header).replace(/\s+/g, ' ').trim() : 'Properties';
    const lines = section.children.filter((child): child is Element => (
      isElement(child) && classNames(child).includes('meo-export-frontmatter-line')
    ));
    const rows = lines.map((line) => {
      if (classNames(line).includes('is-property')) {
        const key = DomUtils.findOne((element) => (
          classNames(element).includes('meo-export-frontmatter-key-cell')
        ), line.children, true);
        const value = DomUtils.findOne((element) => (
          classNames(element).includes('meo-export-frontmatter-value-group')
        ), line.children, true);
        if (key && value) {
          return `<tr><td>${DomUtils.getInnerHTML(key)}</td><td>${DomUtils.getInnerHTML(value)}</td></tr>`;
        }
      }
      return `<tr><td colspan="2">${DomUtils.getInnerHTML(line)}</td></tr>`;
    }).join('');
    const fragment = parseDocument(
      `<table class="meo-docx-frontmatter"><thead><tr><th colspan="2">${escapeHtml(label || 'Properties')}</th></tr></thead>`
        + `<tbody>${rows}</tbody></table>`
    );
    const table = fragment.children.find(isElement);
    if (table) DomUtils.replaceElement(section, table);
  }
}

function appendInlineStyles(current: string | undefined, additions: readonly string[]): string {
  return [current, ...additions].filter(Boolean).join(';');
}

function removeClassNames(element: Element, names: readonly string[]): void {
  const filtered = classNames(element).filter((name) => !names.includes(name));
  if (filtered.length > 0) element.attribs.class = filtered.join(' ');
  else delete element.attribs.class;
}

function removeExecutableContent(nodes: ChildNode[]): void {
  const scripts = DomUtils.findAll((element) => element.name === 'script', nodes);
  for (const script of scripts) DomUtils.removeElement(script);
}

function normalizeTables(root: Element): void {
  const tables = DomUtils.findAll((element) => element.name === 'table', root.children);
  for (const table of tables) {
    table.attribs.style = appendInlineStyles(table.attribs.style, [
      'width:100%',
      'border-collapse:collapse',
      'table-layout:auto',
      'margin-bottom:12pt'
    ]);
    const cells = DomUtils.findAll((element) => element.name === 'th' || element.name === 'td', table.children);
    for (const cell of cells) {
      cell.attribs.style = appendInlineStyles(cell.attribs.style, [
        'border:1px solid #d0d7de',
        'padding:5pt 7pt',
        'text-align:left',
        'vertical-align:top'
      ]);
      if (cell.name === 'th') {
        cell.attribs.style = appendInlineStyles(cell.attribs.style, [
          'background-color:#f6f8fa',
          'font-weight:700'
        ]);
      }
    }
  }
}

function findExportRoot(html: string): Element | null {
  return findExportRootInNodes(parseDocument(html).children);
}

function findExportRootInNodes(nodes: ChildNode[]): Element | null {
  return DomUtils.findOne((element) => (
    element.attribs?.id === 'meo-export-root'
    || classNames(element).includes('meo-export-doc')
  ), nodes, true) ?? null;
}

function prepareHeadingBookmarks(root: Element): TocEntry[] {
  const headings = DomUtils.findAll((element) => /^h[1-6]$/i.test(element.name), root.children);
  return headings.flatMap((heading, index) => {
    const text = DomUtils.textContent(heading).replace(/\s+/g, ' ').trim();
    if (!text) return [];
    const entryNumber = index + 1;
    const entry = {
      level: Number.parseInt(heading.name.slice(1), 10),
      text,
      bookmarkName: `meo_heading_${entryNumber}`,
      headingMarker: `MEOHEADINGMARKER${entryNumber}`,
      tocMarker: `MEOTOCENTRYMARKER${entryNumber}`
    };
    DomUtils.prependChild(heading, markerSpan(entry.headingMarker));
    return [entry];
  });
}

function prependTableOfContents(root: Element, label: string, entries: readonly TocEntry[]): void {
  const links = entries.map((entry) => {
    return '<p>'
      + `<span style="font-size:1px;color:#ffffff">${entry.tocMarker}</span>`
      + `${escapeHtml(entry.text)}</p>`;
  }).join('');
  const fragment = parseDocument(
    `<div class="meo-docx-toc">`
      + `<p style="font-size:20pt;font-weight:700;margin-top:0;margin-bottom:12pt">${escapeHtml(label)}</p>`
      + links
      + '<div class="page-break"></div>'
      + '</div>'
  );
  const toc = fragment.children.find(isElement);
  if (!toc) throw new Error('Word export could not construct the table of contents.');
  DomUtils.prependChild(root, toc);
}

function markerSpan(marker: string): Element {
  return new Element('span', { style: 'font-size:1px;color:#ffffff' }, [new Text(marker)]);
}

async function finalizeWordDocument(buffer: Buffer, entries: readonly TocEntry[]): Promise<Buffer> {
  const archive = await JSZip.loadAsync(buffer);
  const documentEntry = archive.file('word/document.xml');
  const settingsEntry = archive.file('word/settings.xml');
  const stylesEntry = archive.file('word/styles.xml');
  if (!documentEntry || !settingsEntry || !stylesEntry) {
    throw new Error('Word export produced an incomplete DOCX package.');
  }

  if (entries.length > 0) {
    let documentXml = await documentEntry.async('string');
    for (const [index, entry] of entries.entries()) {
      documentXml = replaceParagraphContainingMarker(documentXml, entry.headingMarker, (paragraph) => {
        const withoutMarker = removeMarkerRun(paragraph, entry.headingMarker);
        const bookmarkId = 1000 + index;
        return insertAroundParagraphContent(
          withoutMarker,
          `<w:bookmarkStart w:id="${bookmarkId}" w:name="${entry.bookmarkName}"/>`,
          `<w:bookmarkEnd w:id="${bookmarkId}"/>`
        );
      });
    }

    for (const [index, entry] of entries.entries()) {
      documentXml = replaceParagraphContainingMarker(documentXml, entry.tocMarker, (paragraph) => {
        const styledParagraph = applyParagraphStyle(
          removeMarkerRun(paragraph, entry.tocMarker),
          `TOC${entry.level}`
        );
        return wrapParagraphContent(styledParagraph, (content) => {
          const fieldBegin = index === 0
            ? '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>'
              + '<w:r><w:instrText xml:space="preserve"> TOC \\h \\o "1-6" \\z \\u </w:instrText></w:r>'
              + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
            : '';
          const fieldEnd = index === entries.length - 1
            ? '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
            : '';
          return fieldBegin
            + `<w:hyperlink w:anchor="${entry.bookmarkName}" w:history="1">`
              + content
              + '<w:r><w:tab/></w:r>'
              + '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>'
              + `<w:r><w:instrText xml:space="preserve"> PAGEREF ${entry.bookmarkName} \\h </w:instrText></w:r>`
              + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
              + '<w:r><w:t>1</w:t></w:r>'
              + '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
              + '</w:hyperlink>'
            + fieldEnd;
        });
      });
    }
    archive.file('word/document.xml', documentXml);

    const settingsXml = await settingsEntry.async('string');
    if (!/<w:updateFields\b/.test(settingsXml)) {
      archive.file('word/settings.xml', settingsXml.replace(
        '</w:settings>',
        '<w:updateFields w:val="true"/></w:settings>'
      ));
    }
  }

  const normalizedStylesXml = normalizeWordBodyFonts(await stylesEntry.async('string'));
  const stylesXml = (entries.length > 0
    ? addWordTableOfContentsStyles(normalizedStylesXml)
    : normalizedStylesXml).replace(
    /<w:style\b[^>]*w:styleId="Heading[1-6]"[\s\S]*?<\/w:style>/g,
    (style) => style.replace(/\s*<w:(?:keepNext|keepLines)(?:\s[^>]*)?\/>/g, '')
  );
  archive.file('word/styles.xml', stylesXml);
  return archive.generateAsync({ type: 'nodebuffer' });
}

function addWordTableOfContentsStyles(stylesXml: string): string {
  const styles = Array.from({ length: 6 }, (_, index) => {
    const level = index + 1;
    const leftIndent = index * 440;
    return `<w:style w:type="paragraph" w:styleId="TOC${level}">`
      + `<w:name w:val="toc ${level}"/>`
      + '<w:basedOn w:val="Normal"/>'
      + '<w:next w:val="Normal"/>'
      + '<w:autoRedefine/>'
      + '<w:uiPriority w:val="39"/>'
      + '<w:unhideWhenUsed/>'
      + '<w:pPr>'
        + '<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9638"/></w:tabs>'
        + '<w:spacing w:after="80" w:line="276" w:lineRule="auto"/>'
        + `<w:ind w:left="${leftIndent}"/>`
      + '</w:pPr>'
      + '<w:rPr>'
        + wordBodyFonts
        + '<w:color w:val="000000"/>'
        + '<w:noProof/>'
        + '<w:sz w:val="22"/>'
        + '<w:szCs w:val="22"/>'
      + '</w:rPr>'
      + '</w:style>';
  }).join('');
  if (!stylesXml.includes('</w:styles>')) {
    throw new Error('Word export could not add table of contents styles.');
  }
  return stylesXml.replace('</w:styles>', `${styles}</w:styles>`);
}

function normalizeWordBodyFonts(stylesXml: string): string {
  const defaultsPattern = /<w:docDefaults\b[^>]*>[\s\S]*?<\/w:docDefaults>/;
  const defaults = defaultsPattern.exec(stylesXml)?.[0];
  if (!defaults) throw new Error('Word export did not provide document default styles.');

  const fontPattern = /<w:rFonts\b[^>]*(?:\/>|>[\s\S]*?<\/w:rFonts>)/;
  const normalizedDefaults = fontPattern.test(defaults)
    ? defaults.replace(fontPattern, wordBodyFonts)
    : defaults.replace(/<w:rPr\b[^>]*>/, (runProperties) => `${runProperties}${wordBodyFonts}`);
  if (normalizedDefaults === defaults && !fontPattern.test(normalizedDefaults)) {
    throw new Error('Word export could not set the document default font.');
  }
  return stylesXml.replace(defaultsPattern, normalizedDefaults);
}

function applyParagraphStyle(paragraph: string, styleId: string): string {
  const paragraphProperties = /<w:pPr(?:\s[^>]*)?>[\s\S]*?<\/w:pPr>/;
  if (paragraphProperties.test(paragraph)) {
    return paragraph.replace(paragraphProperties, (properties) => {
      if (/<w:pStyle\b/.test(properties)) {
        return properties.replace(/<w:pStyle\b[^>]*(?:\/>|>[\s\S]*?<\/w:pStyle>)/, `<w:pStyle w:val="${styleId}"/>`);
      }
      const propertiesOpenEnd = properties.indexOf('>') + 1;
      return properties.slice(0, propertiesOpenEnd)
        + `<w:pStyle w:val="${styleId}"/>`
        + properties.slice(propertiesOpenEnd);
    });
  }

  const paragraphOpenEnd = paragraph.indexOf('>') + 1;
  if (paragraphOpenEnd <= 0) {
    throw new Error('Word export encountered an invalid table of contents paragraph.');
  }
  return paragraph.slice(0, paragraphOpenEnd)
    + `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>`
    + paragraph.slice(paragraphOpenEnd);
}

function replaceParagraphContainingMarker(
  xml: string,
  marker: string,
  transform: (paragraph: string) => string
): string {
  const paragraphs = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  for (const match of xml.matchAll(paragraphs)) {
    if (!match[0].includes(marker) || match.index === undefined) continue;
    return xml.slice(0, match.index) + transform(match[0]) + xml.slice(match.index + match[0].length);
  }
  throw new Error(`Word export could not locate generated marker ${marker}.`);
}

function removeMarkerRun(paragraph: string, marker: string): string {
  const runs = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g;
  for (const match of paragraph.matchAll(runs)) {
    if (!match[0].includes(marker) || match.index === undefined) continue;
    return paragraph.slice(0, match.index) + paragraph.slice(match.index + match[0].length);
  }
  throw new Error(`Word export could not remove generated marker ${marker}.`);
}

function insertAroundParagraphContent(paragraph: string, before: string, after: string): string {
  return wrapParagraphContent(paragraph, (content) => before + content + after);
}

function wrapParagraphContent(paragraph: string, transform: (content: string) => string): string {
  const paragraphOpenEnd = paragraph.indexOf('>') + 1;
  const propertiesEnd = paragraph.indexOf('</w:pPr>');
  const contentStart = propertiesEnd >= 0 ? propertiesEnd + '</w:pPr>'.length : paragraphOpenEnd;
  const contentEnd = paragraph.lastIndexOf('</w:p>');
  if (paragraphOpenEnd <= 0 || contentEnd < contentStart) {
    throw new Error('Word export encountered an invalid paragraph while constructing the table of contents.');
  }
  return paragraph.slice(0, contentStart)
    + transform(paragraph.slice(contentStart, contentEnd))
    + paragraph.slice(contentEnd);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function classNames(element: Element): string[] {
  return (element.attribs.class ?? '').split(/\s+/).filter(Boolean);
}

function isElement(node: ChildNode): node is Element {
  return node.type === 'tag' || node.type === 'script' || node.type === 'style';
}
