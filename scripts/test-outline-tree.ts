import { buildOutlineTree, findVisibleHeadingIndexes, type OutlineHeading } from '../webview/src/helpers/outline';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { extractHeadings } from '../webview/src/helpers/markdownSyntax';
import {
  DEFAULT_OUTLINE_WIDTH,
  MAX_OUTLINE_WIDTH,
  MIN_OUTLINE_WIDTH,
  normalizeOutlineWidth
} from '../src/shared/outlineWidth';

if (normalizeOutlineWidth(Number.NaN) !== DEFAULT_OUTLINE_WIDTH) throw new Error('Invalid outline width must use the default');
if (normalizeOutlineWidth(MIN_OUTLINE_WIDTH - 1) !== MIN_OUTLINE_WIDTH) throw new Error('Outline width minimum was not enforced');
if (normalizeOutlineWidth(MAX_OUTLINE_WIDTH + 1) !== MAX_OUTLINE_WIDTH) throw new Error('Outline width maximum was not enforced');
if (normalizeOutlineWidth(300.6) !== 301) throw new Error('Outline width was not rounded');

const headings: OutlineHeading[] = [
  { text: 'Root', level: 1, from: 0, line: 1 },
  { text: 'Skipped level', level: 3, from: 10, line: 2 },
  { text: 'Nested', level: 4, from: 20, line: 3 },
  { text: 'Root', level: 1, from: 30, line: 4 }
];

const { roots, nodeByIndex } = buildOutlineTree(headings);

if (roots.length !== 2) throw new Error(`Expected 2 roots, received ${roots.length}`);
if (roots[0].children[0]?.heading.text !== 'Skipped level') throw new Error('Skipped heading level lost its parent');
if (roots[0].children[0]?.children[0]?.heading.text !== 'Nested') throw new Error('Nested heading tree is incorrect');
if (nodeByIndex.get(2)?.depth !== 2) throw new Error('Nested heading depth is incorrect');
if (roots[0].key === roots[1].key) throw new Error('Duplicate sibling headings must receive distinct keys');
const visibilityHeadings: OutlineHeading[] = [
  { text: 'First', level: 1, from: 0, line: 1 },
  { text: 'Second', level: 1, from: 100, line: 11 },
  { text: 'Third', level: 1, from: 200, line: 21 }
];
const substantialContent = findVisibleHeadingIndexes(visibilityHeadings, { from: 120, to: 180, fromLine: 13, toLine: 18 });
if (substantialContent.length !== 1 || substantialContent[0] !== 1) {
  throw new Error(`Four visible section lines should keep its heading visible: ${substantialContent.join(',')}`);
}
const oneVisibleLine = findVisibleHeadingIndexes(visibilityHeadings, { from: 190, to: 199, fromLine: 20, toLine: 20 });
if (oneVisibleLine.length !== 0) throw new Error('A single visible section line must not activate its heading');
const visibleHeadingLine = findVisibleHeadingIndexes(visibilityHeadings, { from: 100, to: 110, fromLine: 11, toLine: 11 });
if (visibleHeadingLine.length !== 1 || visibleHeadingLine[0] !== 1) {
  throw new Error('A heading line inside the viewport must always be visible');
}

const richState = EditorState.create({
  doc: '# **Bold** and *italic* with ~~deleted~~',
  extensions: [markdown({ base: markdownLanguage })]
});
const richHeading = extractHeadings(richState)[0];
if (richHeading.text !== 'Bold and italic with deleted') throw new Error(`Unexpected rich heading text: ${richHeading.text}`);
if (!richHeading.inlineSegments?.some((segment) => segment.text === 'Bold' && segment.strong)) throw new Error('Bold heading style was not preserved');
if (!richHeading.inlineSegments?.some((segment) => segment.text === 'italic' && segment.emphasis)) throw new Error('Italic heading style was not preserved');
if (!richHeading.inlineSegments?.some((segment) => segment.text === 'deleted' && segment.strikethrough)) throw new Error('Strikethrough heading style was not preserved');

console.log('outline tree checks passed');

const setextState = EditorState.create({
  doc: '**Bold** and *italic*\ncontinued\n---\n\nRoot\n===',
  extensions: [markdown({ base: markdownLanguage })]
});
const setextHeadings = extractHeadings(setextState);
if (JSON.stringify(setextHeadings.map(({ level, text }) => ({ level, text }))) !== JSON.stringify([
  { level: 2, text: 'Bold and italic continued' }, { level: 1, text: 'Root' }
])) throw new Error('Setext outline must omit underline syntax and normalize multiline text');
if (!setextHeadings[0].inlineSegments?.some(segment => segment.text === 'Bold' && segment.strong)) throw new Error('Setext heading inline formatting was lost');
const emptyHeading = extractHeadings(EditorState.create({ doc: '# #', extensions: [markdown({ base: markdownLanguage })] }))[0];
if (emptyHeading.text !== '' || emptyHeading.inlineSegments?.length) throw new Error('An empty ATX heading must keep an empty content range');

// Outline discovery needs block structure, not every token in unrelated prose
// or embedded languages. Keep real nested headings and rich heading text.
const prose = Array.from({ length: 600 }, (_, index) =>
  `Paragraph ${index}. ${'**bold** [link](https://example.test) and `code` with *emphasis*. '.repeat(12)}\n\n`).join('');
const indexedText = '# **Root**\n\n' + prose + '> ## Quoted\n\n- ### Nested\n\nSetext\n---\n\n```markdown\n# Literal code\n```\n';
const indexedState = EditorState.create({ doc: indexedText, extensions: [markdown({ base: markdownLanguage })] });
const indexedTree = markdownLanguage.parser.parse(indexedText);
let visited = 0;
const observedTree = Object.create(indexedTree);
observedTree.iterate = (spec: Parameters<typeof indexedTree.iterate>[0]) => indexedTree.iterate({ ...spec,
  enter(node) { visited++; return spec.enter?.(node); }
});
const indexedHeadings = extractHeadings(indexedState, observedTree);
if (JSON.stringify(indexedHeadings.map(heading => heading.text)) !== JSON.stringify(['Root', 'Quoted', 'Nested', 'Setext']))
  throw Error('Indexed outline lost nested headings or included fenced Markdown');
if (!indexedHeadings[0].inlineSegments?.some(segment => segment.strong && segment.text === 'Root'))
  throw Error('Indexed outline must retain authoritative inline heading styles');
if (visited >= 2_000) throw Error(`Outline discovery traversed unrelated inline content: ${visited} nodes`);
console.log(`Outline discovery is bounded by block structure: ${visited} outer nodes`);
