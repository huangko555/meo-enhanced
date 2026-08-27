import { assessLargeDocument } from '../src/application/largeDocumentPolicy';

export type LargeDocumentFixtureKind =
  | 'ordinary'
  | 'bytes-heavy'
  | 'lines-heavy'
  | 'rich-heavy'
  | 'composite';

export type LargeDocumentFixture = {
  readonly kind: LargeDocumentFixtureKind;
  readonly text: string;
};

export type LargeDocumentFixtureDescription = {
  readonly bytes: number;
  readonly lines: number;
  readonly rich: {
    readonly tables: number;
    readonly mermaid: number;
    readonly images: number;
    readonly math: number;
    readonly total: number;
  };
};

const transparentPixel =
  'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

const endMarker = (kind: LargeDocumentFixtureKind): string => `fixture:${kind}:end`;

const paragraphLines = (count: number, prefix: string): string[] => Array.from(
  { length: count },
  (_, index) => `${prefix} ${index} with stable Markdown text and **visible emphasis**.`
);

const richBundle = (index: number): string[] => [
  `| Metric ${index} | Value |`,
  '| --- | ---: |',
  `| item-${index} | ${index} |`,
  '',
  '```mermaid',
  `flowchart LR; A${index}[Start] --> B${index}[Finish]`,
  '```',
  '',
  `![pixel-${index}](${transparentPixel})`,
  '',
  '$$',
  `x_{${index}} = ${index}^2 + 1`,
  '$$',
  ''
];

const createFixture = (kind: LargeDocumentFixtureKind, lines: readonly string[]): LargeDocumentFixture => ({
  kind,
  text: [`# Large document ${kind}`, '', ...lines, endMarker(kind)].join('\n')
});

export function createLargeDocumentFixtures(): readonly LargeDocumentFixture[] {
  const ordinary = createFixture('ordinary', paragraphLines(240, 'ordinary paragraph'));
  const bytesHeavy = createFixture('bytes-heavy', Array.from(
    { length: 180 },
    (_, index) => `bytes-${index} ${'x'.repeat(1_800)}`
  ));
  const linesHeavy = createFixture('lines-heavy', Array.from(
    { length: 9_000 },
    (_, index) => `line-${index}`
  ));
  const richHeavy = createFixture('rich-heavy', Array.from(
    { length: 80 },
    (_, index) => richBundle(index)
  ).flat());
  const composite = createFixture('composite', [
    ...Array.from({ length: 100 }, (_, index) => `wide-${index} ${'y'.repeat(1_000)}`),
    ...paragraphLines(4_000, 'composite paragraph'),
    ...Array.from({ length: 40 }, (_, index) => richBundle(index)).flat()
  ]);
  return [ordinary, bytesHeavy, linesHeavy, richHeavy, composite];
}

export function describeLargeDocumentFixture(text: string): LargeDocumentFixtureDescription {
  const { dimensions } = assessLargeDocument(text);
  return {
    bytes: dimensions.bytes,
    lines: dimensions.lines,
    rich: {
      tables: dimensions.tables,
      mermaid: dimensions.mermaid,
      images: dimensions.images,
      math: dimensions.math,
      total: dimensions.richBlocks
    }
  };
}
