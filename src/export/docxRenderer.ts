import * as fs from 'node:fs/promises';
import {
  Document,
  ExternalHyperlink,
  HeadingLevel,
  HighlightColor,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild
} from 'docx';
import { DomUtils, ElementType, parseDocument } from 'htmlparser2';
import type { Element } from 'domhandler';
import { imageSize } from 'image-size';
import type { UiLanguage } from '../foundation/uiLanguage';
import { materializeDocxBodyFromHtmlExport } from './pdfRenderer';

export type WriteDocxExportOptions = {
  readonly htmlDocument: string;
  readonly outputDocxPath: string;
  readonly title: string;
  readonly uiLanguage: UiLanguage;
  readonly includeTableOfContents: boolean;
  readonly browserExecutablePath?: string;
  readonly puppeteerRuntimeModulePath: string;
  readonly timeoutMs?: number;
};

type InlineStyle = {
  readonly bold?: boolean;
  readonly italics?: boolean;
  readonly strike?: boolean;
  readonly code?: boolean;
  readonly color?: string;
  readonly highlight?: boolean;
  readonly preserveWhitespace?: boolean;
};

type Block = Paragraph | Table;

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6
] as const;

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

  const blocks = await convertBlockChildren(root.children);
  const contentsLabel = options.uiLanguage === 'zh-CN' ? '目录' : 'Contents';
  const children = options.includeTableOfContents
    ? [
        new Paragraph({
          children: [new TextRun({ text: contentsLabel, bold: true, size: 30 })],
          spacing: { after: 180 }
        }),
        new TableOfContents(contentsLabel, {
          hyperlink: true,
          headingStyleRange: '1-6',
          beginDirty: true
        }),
        new Paragraph({ children: [], spacing: { after: 240 } }),
        ...blocks
      ]
    : blocks;

  const document = new Document({
    title: options.title,
    creator: 'MEO Enhanced',
    features: { updateFields: true },
    styles: {
      default: {
        document: {
          run: { font: 'Aptos', size: 22 },
          paragraph: { spacing: { line: 300, after: 120 } }
        }
      }
    },
    sections: [{
      properties: {
        page: {
          margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 }
        }
      },
      children
    }]
  });
  await fs.writeFile(options.outputDocxPath, await Packer.toBuffer(document));
}

function findExportRoot(html: string): Element | null {
  const document = parseDocument(html);
  return DomUtils.findOne((element) => (
    element.attribs?.id === 'meo-export-root'
    || classNames(element).includes('meo-export-doc')
  ), document.children, true) ?? null;
}

async function convertBlockChildren(nodes: readonly any[]): Promise<Block[]> {
  const blocks: Block[] = [];
  for (const node of nodes) {
    if (node.type === ElementType.Text && node.data.trim()) {
      blocks.push(new Paragraph({ children: textRuns(node.data.trim(), {}) }));
      continue;
    }
    if (!isElement(node)) continue;
    blocks.push(...await convertBlock(node));
  }
  return blocks;
}

async function convertBlock(element: Element): Promise<Block[]> {
  const tag = element.name.toLowerCase();
  const heading = /^h([1-6])$/.exec(tag);
  if (heading) {
    const level = Number.parseInt(heading[1] ?? '1', 10) - 1;
    return [new Paragraph({
      heading: HEADING_LEVELS[level] ?? HeadingLevel.HEADING_1,
      children: await convertInlineChildren(element.children),
      spacing: { before: level <= 1 ? 280 : 180, after: 100 }
    })];
  }
  if (tag === 'p') {
    return [new Paragraph({ children: await convertInlineChildren(element.children) })];
  }
  if (tag === 'pre') {
    return [new Paragraph({
      children: await convertInlineChildren(element.children, { code: true, preserveWhitespace: true }),
      shading: { fill: 'F6F8FA' },
      spacing: { before: 100, after: 160, line: 260 }
    })];
  }
  if (classNames(element).includes('meo-export-code-block-wrap')) {
    const pre = DomUtils.findOne((child) => child.name === 'pre', element.children, true);
    return pre ? convertBlock(pre) : [];
  }
  if (tag === 'blockquote') {
    return [new Paragraph({
      children: await convertInlineChildren(element.children, { italics: true }),
      indent: { left: 420 },
      shading: { fill: 'F6F8FA' }
    })];
  }
  if (tag === 'ul' || tag === 'ol') return convertList(element, tag === 'ol');
  if (tag === 'table') return [await convertTable(element)];
  if (tag === 'hr') return [new Paragraph({ thematicBreak: true })];
  if (tag === 'img') {
    const image = await convertImage(element);
    return [new Paragraph({ children: image ? [image] : textRuns(element.attribs.alt ?? '', {}) })];
  }
  if (classNames(element).includes('meo-table-scroll')) {
    const table = element.children.find((child: any) => isElement(child) && child.name === 'table');
    return table && isElement(table) ? [await convertTable(table)] : [];
  }
  if (classNames(element).some((name) => name.startsWith('meo-export-math'))) {
    return [new Paragraph({ children: textRuns(decodeSource(element) || DomUtils.getText(element), { code: true }) })];
  }
  if (classNames(element).includes('meo-export-mermaid')) {
    return [new Paragraph({ children: textRuns(decodeSource(element) || DomUtils.getText(element), { code: true }) })];
  }
  return convertBlockChildren(element.children);
}

async function convertList(list: Element, ordered: boolean, level = 0): Promise<Block[]> {
  const blocks: Block[] = [];
  const items = list.children.filter((child: any) => isElement(child) && child.name === 'li') as Element[];
  for (const [index, item] of items.entries()) {
    const inlineNodes = item.children.filter((child: any) => !isElement(child) || (child.name !== 'ul' && child.name !== 'ol'));
    const children = await convertInlineChildren(inlineNodes);
    if (ordered) children.unshift(new TextRun({ text: `${index + 1}. ` }));
    blocks.push(new Paragraph({
      children,
      ...(ordered ? { indent: { left: 360 + level * 300, hanging: 240 } } : { bullet: { level } })
    }));
    for (const nested of item.children.filter((child: any) => isElement(child) && (child.name === 'ul' || child.name === 'ol')) as Element[]) {
      blocks.push(...await convertList(nested, nested.name === 'ol', Math.min(level + 1, 8)));
    }
  }
  return blocks;
}

async function convertTable(table: Element): Promise<Table> {
  const rowElements = DomUtils.findAll((element) => element.name === 'tr', table.children);
  const rows: TableRow[] = [];
  for (const row of rowElements) {
    const cells = row.children.filter((child: any) => isElement(child) && (child.name === 'th' || child.name === 'td')) as Element[];
    rows.push(new TableRow({
      children: await Promise.all(cells.map(async (cell) => {
        const hasBlockContent = cell.children.some((child: any) => (
          isElement(child) && ['p', 'ul', 'ol', 'pre', 'blockquote', 'table'].includes(child.name)
        ));
        const cellChildren = hasBlockContent
          ? await convertBlockChildren(cell.children)
          : [new Paragraph({ children: await convertInlineChildren(cell.children) })];
        return new TableCell({
          children: cellChildren,
          ...(cell.name === 'th' ? { shading: { fill: 'EDEFF2' } } : {})
        });
      }))
    }));
  }
  return new Table({
    rows: rows.length > 0 ? rows : [new TableRow({ children: [new TableCell({ children: [new Paragraph('')] })] })],
    width: { size: 100, type: WidthType.PERCENTAGE }
  });
}

async function convertInlineChildren(nodes: readonly any[], inherited: InlineStyle = {}): Promise<ParagraphChild[]> {
  const children: ParagraphChild[] = [];
  for (const node of nodes) {
    if (node.type === ElementType.Text) {
      children.push(...textRuns(node.data, inherited));
      continue;
    }
    if (!isElement(node)) continue;
    const tag = node.name.toLowerCase();
    if (tag === 'br') {
      children.push(new TextRun({ break: 1 }));
      continue;
    }
    if (tag === 'img') {
      const image = await convertImage(node);
      if (image) children.push(image);
      else children.push(...textRuns(node.attribs.alt ?? '', inherited));
      continue;
    }
    if (tag === 'a') {
      const linkChildren = await convertInlineChildren(node.children, {
        ...inherited,
        color: inherited.color ?? '0563C1'
      });
      children.push(new ExternalHyperlink({ children: linkChildren, link: node.attribs.href ?? '' }));
      continue;
    }
    if (classNames(node).some((name) => name.startsWith('meo-export-math-inline'))) {
      children.push(...textRuns(decodeSource(node) || DomUtils.getText(node), { ...inherited, code: true }));
      continue;
    }
    const style: InlineStyle = {
      ...inherited,
      ...(tag === 'strong' || tag === 'b' ? { bold: true } : {}),
      ...(tag === 'em' || tag === 'i' ? { italics: true } : {}),
      ...(tag === 's' || tag === 'del' ? { strike: true } : {}),
      ...(tag === 'code' ? { code: true, preserveWhitespace: true } : {}),
      ...(tag === 'mark' ? { highlight: true } : {}),
      ...(extractColor(node.attribs.style) ? { color: extractColor(node.attribs.style)! } : {})
    };
    children.push(...await convertInlineChildren(node.children, style));
  }
  return children;
}

function textRuns(rawText: string, style: InlineStyle): TextRun[] {
  const normalized = style.preserveWhitespace ? rawText.replace(/\r\n/g, '\n') : rawText.replace(/\s+/g, ' ');
  if (!normalized) return [];
  return normalized.split('\n').flatMap((text, index) => [
    ...(index > 0 ? [new TextRun({ break: 1 })] : []),
    ...(text ? [new TextRun({
      text,
      bold: style.bold,
      italics: style.italics,
      strike: style.strike,
      color: style.color,
      font: style.code ? 'Consolas' : undefined,
      size: style.code ? 19 : undefined,
      highlight: style.highlight ? HighlightColor.YELLOW : undefined,
      ...(style.code ? { shading: { fill: 'EEF1F4' } } : {})
    })] : [])
  ]);
}

async function convertImage(element: Element): Promise<ImageRun | null> {
  const match = /^data:image\/(png|jpe?g|gif|bmp);base64,([a-z0-9+/=]+)$/i.exec(element.attribs.src ?? '');
  if (!match?.[1] || !match[2]) return null;
  const data = Buffer.from(match[2], 'base64');
  const measured = imageSize(data);
  const naturalWidth = measured.width || 560;
  const naturalHeight = measured.height || 315;
  const scale = Math.min(1, 560 / naturalWidth, 720 / naturalHeight);
  const mime = match[1].toLowerCase();
  return new ImageRun({
    type: mime === 'jpeg' ? 'jpg' : mime as 'png' | 'jpg' | 'gif' | 'bmp',
    data,
    transformation: {
      width: Math.max(1, Math.round(naturalWidth * scale)),
      height: Math.max(1, Math.round(naturalHeight * scale))
    }
  });
}

function extractColor(style: string | undefined): string | null {
  const match = /(?:^|;)\s*color\s*:\s*#([0-9a-f]{6})(?:\s*!important)?/i.exec(style ?? '');
  return match?.[1]?.toUpperCase() ?? null;
}

function decodeSource(element: Element): string {
  const encoded = element.attribs['data-source-b64'];
  if (!encoded) return '';
  try {
    return Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function classNames(element: Element): string[] {
  return (element.attribs.class ?? '').split(/\s+/).filter(Boolean);
}

function isElement(node: any): node is Element {
  return node?.type === ElementType.Tag || node?.type === ElementType.Script || node?.type === ElementType.Style;
}
