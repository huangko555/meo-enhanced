import { buildOutlineTree, findVisibleHeadingIndexes, type OutlineHeading } from '../webview/src/helpers/outline';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { extractHeadings } from '../webview/src/helpers/markdownSyntax';

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
