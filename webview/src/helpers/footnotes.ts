import { documentLines } from './documentLines';
import { EditorState, type ChangeDesc } from '@codemirror/state';
import type { MarkdownConfig } from '@lezer/markdown';
import { parseFrontmatter, isInsideFrontmatter } from './frontmatter';
import { currentSyntaxTree, resolvedSyntaxTree } from './markdownSyntax';
import { hasSameLiveMarkdownSyntax } from './livePresentationSyntax';
import { collectInlineFootnoteMarkerRanges } from './inlineFootnotes';
import { language } from '@codemirror/language';
import type { Parser, Tree } from '@lezer/common';
import type { FootnoteReference, FootnoteDefinition, FootnoteContinuationLine, ParsedFootnotes } from '../../../src/foundation/markdownDocumentContext';
import { readDocumentTextProjection } from '../application/documentTextProjection';
import { footnoteReferenceKey, mapFootnoteSourcePositions, type FootnoteContainerProjection } from '../../../src/foundation/markdownContextCoordinates';
export type { FootnoteReference, FootnoteDefinition, FootnoteContinuationLine, ParsedFootnotes } from '../../../src/foundation/markdownDocumentContext';
export { footnoteReferenceKey } from '../../../src/foundation/markdownContextCoordinates';

interface ProtectedRange {
  from: number;
  to: number;
}

const footnoteCache = new WeakMap<object, { tree: ReturnType<typeof resolvedSyntaxTree>; parsed: ParsedFootnotes;
  tabSize: number; verified?: { parser: Parser | null } }>();

export function adoptFootnoteContext(doc: EditorState['doc'], tree: Tree, tabSize: number,
  parsed: ParsedFootnotes, parser: Parser | null): void {
  footnoteCache.set(doc, { tree, tabSize, parsed, verified: { parser } });
}
const definitionMarkerPattern = /^[ \t]{0,3}\[\^([^\]\r\n]+)\]:(?:[ \t]|$)/;
const footnoteCompositeMarkerPattern = /^\[\^([^\]\r\n]+)\]:(?:[ \t]|$)/;
const footnoteContinuationIndent = 4;

export const footnoteMarkdownExtension: MarkdownConfig = {
  defineNodes: [{
    name: 'FootnoteDefinition',
    block: true,
    composite(_context, line, indent) {
      if (line.pos === line.text.length) return true;
      if (line.indent < line.baseIndent + indent) return false;
      line.moveBaseColumn(line.baseIndent + indent);
      return true;
    }
  }],
  parseBlock: [{
    name: 'FootnoteDefinition',
    before: 'IndentedCode',
    parse(context, line) {
      const marker = footnoteCompositeMarkerPattern.exec(line.text.slice(line.pos));
      if (!marker) return false;
      const contentFrom = line.pos + marker[0].length;
      context.startComposite('FootnoteDefinition', line.pos, footnoteContinuationIndent);
      line.moveBase(contentFrom);
      return null;
    }
  }]
};

export function normalizeFootnoteLabel(rawLabel: string): string {
  return String(rawLabel ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function parseFootnotes(state: EditorState): ParsedFootnotes {
  // References and protected code ranges depend on the parser's progress as
  // well as the text. A partial result must not become a complete projection.
  const entry = footnoteCache.get(state.doc);
  const parser = state.facet(language)?.parser ?? null;
  const cached = entry?.tabSize === state.tabSize && (!entry.verified || entry.verified.parser === parser) ? entry : undefined;
  // A worker result or a proven local edit owns this exact document/grammar.
  // Embedded language publication cannot invalidate those source facts.
  // Ordinary partial caches still resolve the parse and cannot hide late notes.
  if (cached?.verified) return cached.parsed;
  // The read-only worker context has no language field. Ordinary editor states
  // retain the existing syntax-resolution contract used by local edit proofs.
  if (!cached && !parser && !readDocumentTextProjection(state.doc).includes('[^')) {
    const parsed: ParsedFootnotes = { references: [], definitions: [], numberByLabel: new Map(), referencesByContainerKey: new Map() };
    footnoteCache.set(state.doc, { tree: currentSyntaxTree(state), tabSize: state.tabSize, parsed,
      verified: { parser } });
    return parsed;
  }
  const tree = resolvedSyntaxTree(state);
  if (cached && (cached.tree === tree || hasSameLiveMarkdownSyntax(cached.tree, tree))) {
    if (cached.tree !== tree) footnoteCache.set(state.doc, { tree, tabSize: state.tabSize, parsed: cached.parsed });
    return cached.parsed;
  }

  const frontmatter = parseFrontmatter(state);
  const protectedRanges = collectProtectedRanges(state, tree);
  const definitions = collectDefinitions(state, frontmatter, protectedRanges);
  const definitionMarkerToByFrom = new Map<number, number>();
  const primaryDefinitions = new Map<string, FootnoteDefinition>();

  for (const definition of definitions) {
    definitionMarkerToByFrom.set(definition.markerFrom, definition.markerTo);
    if (!definition.isPrimary) {
      continue;
    }
    primaryDefinitions.set(definition.normalizedLabel, definition);
  }

  const references = collectReferences(state, tree, frontmatter, protectedRanges, primaryDefinitions, definitionMarkerToByFrom);
  const numberByLabel = new Map<string, number>();
  let nextNumber = 1;

  for (const reference of references) {
    if (!reference.definition) {
      continue;
    }

    let footnoteNumber = numberByLabel.get(reference.normalizedLabel);
    if (!footnoteNumber) {
      footnoteNumber = nextNumber;
      nextNumber += 1;
      numberByLabel.set(reference.normalizedLabel, footnoteNumber);
    }

    reference.number = footnoteNumber;
  }

  for (const definition of definitions) {
    if (!definition.isPrimary) {
      continue;
    }
    definition.number = numberByLabel.get(definition.normalizedLabel) ?? null;
  }

  const firstReferenceByLabel = new Map<string, number>();
  for (const reference of references) {
    if (!reference.definition || firstReferenceByLabel.has(reference.normalizedLabel)) {
      continue;
    }
    firstReferenceByLabel.set(reference.normalizedLabel, reference.from);
  }

  for (const definition of definitions) {
    if (!definition.isPrimary) {
      continue;
    }
    definition.firstReferenceFrom = firstReferenceByLabel.get(definition.normalizedLabel) ?? null;
  }

  const referencesByContainerKey = new Map<string, FootnoteReference[]>();
  for (const reference of references) {
    const containerKey = footnoteReferenceKey(reference.containerFrom, reference.containerTo);
    const containerRefs = referencesByContainerKey.get(containerKey);
    if (containerRefs) {
      containerRefs.push(reference);
      continue;
    }
    referencesByContainerKey.set(containerKey, [reference]);
  }

  const parsed: ParsedFootnotes = {
    references,
    definitions,
    numberByLabel,
    referencesByContainerKey
  };

  footnoteCache.set(state.doc, { tree, tabSize: state.tabSize, parsed });
  return parsed;
}

/** Only after proving unchanged labels, references and protected membership.
 * Numbering stays global. A changed continuation gets fresh local line metadata. */
export function projectUnchangedFootnotes(before: EditorState, state: EditorState, changes: ChangeDesc,
  options: { editedDefinition?: FootnoteDefinition; container?: FootnoteContainerProjection } = {}): boolean {
  if (before.tabSize !== state.tabSize || before.facet(language)?.parser !== state.facet(language)?.parser) return false;
  const previous = parseFootnotes(before), parsed = mapFootnoteSourcePositions(previous, changes, options.container);
  const { editedDefinition } = options;
  if (editedDefinition) {
    const index = previous.definitions.indexOf(editedDefinition);
    if (index < 0) return false;
    const mapped = parsed.definitions[index];
    const line = state.doc.lineAt(mapped.lineFrom).number;
    const rebuilt = collectDefinitions(state, parseFrontmatter(state), [], { fromLine: line, toLine: line })[0];
    if (!rebuilt || rebuilt.normalizedLabel !== mapped.normalizedLabel || rebuilt.lineTo !== mapped.lineTo) return false;
    const replacement = { ...rebuilt, number: mapped.number, firstReferenceFrom: mapped.firstReferenceFrom, isPrimary: mapped.isPrimary };
    parsed.definitions[index] = replacement;
    for (const reference of parsed.references) if (reference.definition === mapped) reference.definition = replacement;
  }
  footnoteCache.set(state.doc, { tree: currentSyntaxTree(state), tabSize: state.tabSize,
    verified: { parser: state.facet(language)?.parser ?? null }, parsed });
  return true;
}

function collectProtectedRanges(state: EditorState, tree: any): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];

  tree.iterate({
    enter(node: any) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        ranges.push({ from: node.from, to: node.to });
      }
    }
  });

  ranges.sort((a, b) => a.from - b.from);
  return ranges;
}

function collectDefinitions(
  state: EditorState,
  frontmatter: ReturnType<typeof parseFrontmatter>,
  protectedRanges: ProtectedRange[],
  scope?: { fromLine: number; toLine: number }
): FootnoteDefinition[] {
  const definitions: FootnoteDefinition[] = [];
  const seenLabels = new Set<string>();

  let scannedThrough = 0;
  for (const line of documentLines(state.doc, scope?.fromLine, scope?.toLine)) {
    const lineNo = line.number;
    if (lineNo <= scannedThrough) continue;
    const markerMatch = definitionMarkerPattern.exec(line.text);
    if (!markerMatch) continue;
    if (isInsideFrontmatter(frontmatter, line.from) || isInsideProtectedRange(line.from, protectedRanges)) {
      continue;
    }

    const label = markerMatch[1];
    const normalizedLabel = normalizeFootnoteLabel(label);
    if (!normalizedLabel) {
      continue;
    }

    const markerText = markerMatch[0];
    const colonOffset = markerText.lastIndexOf(':');
    let endLineNo = lineNo;
    const continuationLines: FootnoteContinuationLine[] = [];

    while (endLineNo < state.doc.lines) {
      const nextLine = state.doc.line(endLineNo + 1);
      if (isInsideFrontmatter(frontmatter, nextLine.from)) {
        break;
      }
      if (definitionMarkerPattern.test(nextLine.text)) {
        break;
      }
      if (!nextLine.text.trim()) {
        continuationLines.push({
          from: nextLine.from,
          to: nextLine.to,
          hideIndentFrom: null,
          hideIndentTo: null,
          extraIndentColumns: 0
        });
        endLineNo += 1;
        continue;
      }

      const continuationIndent = measureContinuationIndent(nextLine.text);
      if (!continuationIndent) {
        break;
      }

      continuationLines.push({
        from: nextLine.from,
        to: nextLine.to,
        hideIndentFrom: nextLine.from,
        hideIndentTo: nextLine.from + continuationIndent.chars,
        extraIndentColumns: continuationIndent.extraIndentColumns
      });
      endLineNo += 1;
    }

    const contentFrom = line.from + markerText.length;
    const endLine = state.doc.line(endLineNo);
    const definition: FootnoteDefinition = {
      label,
      normalizedLabel,
      markerFrom: line.from + markerText.indexOf('[^'),
      markerTo: line.from + markerText.length,
      colonFrom: line.from + colonOffset,
      colonTo: line.from + colonOffset + 1,
      contentFrom,
      contentTo: line.to,
      lineFrom: line.from,
      lineTo: endLine.to,
      number: null,
      firstReferenceFrom: null,
      continuationLines,
      isPrimary: !seenLabels.has(normalizedLabel)
    };

    definitions.push(definition);
    seenLabels.add(normalizedLabel);
    scannedThrough = endLineNo;
  }

  return definitions;
}

function collectReferences(
  state: EditorState,
  tree: any,
  frontmatter: ReturnType<typeof parseFrontmatter>,
  protectedRanges: ProtectedRange[],
  definitions: Map<string, FootnoteDefinition>,
  definitionMarkerToByFrom: Map<number, number>
): FootnoteReference[] {
  const references: FootnoteReference[] = [];

  tree.iterate({
    enter(node: any) {
      if (node.name !== 'Link') {
        return;
      }
      if (isInsideFrontmatter(frontmatter, node.from) || isInsideProtectedRange(node.from, protectedRanges)) {
        return;
      }

      if (findChildNode(node, 'URL')) {
        return;
      }
      if (isDefinitionMarkerNode(node.from, node.to, definitionMarkerToByFrom)) {
        return;
      }

      const rawText = state.doc.sliceString(node.from, node.to);
      const markerRanges = collectInlineFootnoteMarkerRanges(rawText);
      if (!markerRanges.length) {
        return;
      }

      for (const markerRange of markerRanges) {
        const normalizedLabel = normalizeFootnoteLabel(markerRange.label);
        if (!normalizedLabel) {
          continue;
        }
        const definition = definitions.get(normalizedLabel);
        if (!definition) {
          continue;
        }

        references.push({
          from: node.from + markerRange.fromOffset,
          to: node.from + markerRange.toOffset,
          containerFrom: node.from,
          containerTo: node.to,
          label: markerRange.label,
          normalizedLabel,
          number: null,
          definition
        });
      }
    }
  });

  return references;
}

function isDefinitionMarkerNode(from: number, to: number, definitionMarkerToByFrom: Map<number, number>): boolean {
  const markerTo = definitionMarkerToByFrom.get(from);
  return markerTo !== undefined && to <= markerTo;
}

function measureContinuationIndent(lineText: string): { chars: number; extraIndentColumns: number } | null {
  let visibleIndent = 0;
  let chars = 0;

  while (chars < lineText.length) {
    const ch = lineText[chars];
    if (ch === ' ') {
      visibleIndent += 1;
      chars += 1;
    } else if (ch === '\t') {
      visibleIndent += 4 - (visibleIndent % 4);
      chars += 1;
    } else {
      break;
    }
  }

  if (visibleIndent < 2) {
    return null;
  }

  return {
    chars,
    // Four columns are the Markdown continuation baseline. Keep accepting two
    // columns for compatibility, but don't render valid four-space source as
    // an extra visual indent in Live mode.
    extraIndentColumns: Math.max(0, visibleIndent - footnoteContinuationIndent)
  };
}

function isInsideProtectedRange(pos: number, ranges: ProtectedRange[]): boolean {
  for (const range of ranges) {
    if (pos < range.from) {
      return false;
    }
    if (pos >= range.from && pos < range.to) {
      return true;
    }
  }
  return false;
}

function findChildNode(node: any, name: string): any {
  const syntaxNode = node?.node ?? node;
  if (!syntaxNode?.firstChild) {
    return null;
  }

  for (let child = syntaxNode.firstChild; child; child = child.nextSibling) {
    if (child.name === name) {
      return child;
    }
  }

  return null;
}
