import type { FootnoteReference, MarkdownDetailsBlock, MarkdownSourceFacts, ParsedFootnotes } from './markdownDocumentContext';

/** Positions only. Editor/parser implementations supply their own change map. */
type PositionMapping = { readonly empty: boolean; mapPos(position: number, association?: number): number };
export type FootnoteContainerProjection = { before: { from: number; to: number }; after: { from: number; to: number } };

export function footnoteReferenceKey(from: number, to: number): string { return `${from}:${to}`; }

/** Call only after proving unchanged labels, references and protected membership. */
export function mapFootnoteSourcePositions(previous: ParsedFootnotes, changes: Pick<PositionMapping, 'mapPos'>,
  container?: FootnoteContainerProjection): ParsedFootnotes {
  const position = (value: number) => changes.mapPos(value, 1), end = (value: number) => changes.mapPos(value, -1);
  const definitions = previous.definitions.map(definition => ({ ...definition,
    markerFrom: position(definition.markerFrom), markerTo: end(definition.markerTo),
    colonFrom: position(definition.colonFrom), colonTo: end(definition.colonTo),
    contentFrom: changes.mapPos(definition.contentFrom, -1), contentTo: position(definition.contentTo),
    lineFrom: position(definition.lineFrom), lineTo: position(definition.lineTo),
    firstReferenceFrom: definition.firstReferenceFrom === null ? null : position(definition.firstReferenceFrom),
    continuationLines: definition.continuationLines.map(line => ({ ...line, from: position(line.from), to: position(line.to),
      hideIndentFrom: line.hideIndentFrom === null ? null : position(line.hideIndentFrom),
      hideIndentTo: line.hideIndentTo === null ? null : end(line.hideIndentTo) }))
  }));
  const definitionMap = new Map(previous.definitions.map((definition, index) => [definition, definitions[index]]));
  const references = previous.references.map(reference => ({ ...reference,
    from: position(reference.from), to: end(reference.to), containerFrom: position(reference.containerFrom), containerTo: end(reference.containerTo),
    ...(container && reference.containerFrom === container.before.from && reference.containerTo === container.before.to
      ? { containerFrom: container.after.from, containerTo: container.after.to } : {}),
    definition: reference.definition ? definitionMap.get(reference.definition)! : null
  }));
  const referencesByContainerKey = new Map<string, FootnoteReference[]>();
  for (const reference of references) {
    const key = footnoteReferenceKey(reference.containerFrom, reference.containerTo);
    const entries = referencesByContainerKey.get(key) ?? [];
    entries.push(reference); referencesByContainerKey.set(key, entries);
  }
  return { definitions, references, referencesByContainerKey, numberByLabel: previous.numberByLabel };
}

/** Map an unchanged fact set after a caller-owned semantic/revision proof. */
export function mapMarkdownContextCoordinates(before: MarkdownSourceFacts, changes: PositionMapping): MarkdownSourceFacts {
  if (changes.empty) return { footnotes: before.footnotes, code: before.code, blocks: before.blocks };
  const from = (position: number) => changes.mapPos(position, 1), to = (position: number) => changes.mapPos(position, -1);
  const mapDetails = (block: MarkdownDetailsBlock): MarkdownDetailsBlock => ({ ...block,
    anchorFrom: from(block.anchorFrom), anchorTo: to(block.anchorTo), summaryFrom: from(block.summaryFrom), summaryTo: to(block.summaryTo),
    lineFrom: from(block.lineFrom), lineTo: to(block.lineTo), sectionFrom: from(block.sectionFrom), sectionTo: to(block.sectionTo),
    bodyFrom: from(block.bodyFrom), bodyTo: to(block.bodyTo), closingFrom: from(block.closingFrom), closingTo: to(block.closingTo) });
  return { footnotes: mapFootnoteSourcePositions(before.footnotes, changes),
    code: before.code.map(fence => ({ ...fence, anchor: from(fence.anchor), start: from(fence.start), end: to(fence.end),
      endLineFrom: from(fence.endLineFrom), contentFrom: from(fence.contentFrom), contentTo: to(fence.contentTo) })),
    blocks: before.blocks && {
      blocks: before.blocks.blocks.map(item => item.htmlFrom === undefined ? item : ({ ...item, htmlFrom: from(item.htmlFrom) })),
      literals: before.blocks.literals.map(range => ({ ...range, from: from(range.from), to: to(range.to),
        ...(range.htmlCode ? { htmlCode: { from: from(range.htmlCode.from), to: to(range.htmlCode.to) } } : {}) })),
      math: before.blocks.math.map(range => ({ ...range, from: from(range.from), to: to(range.to),
        ...(range.fenceSource ? { fenceSource: { ...range.fenceSource, from: from(range.fenceSource.from) } } : {}) })),
      details: before.blocks.details.map(mapDetails)
    } };
}
