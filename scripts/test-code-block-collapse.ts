import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import {
  codeBlockCollapseExtensions,
  getCodeBlockCollapseSections,
  isCodeBlockCollapsed,
  setCodeBlockSearchTargetEffect
} from '../webview/src/helpers/codeBlockCollapse';

const longTypeScript = Array.from({ length: 13 }, (_, index) => `const line${index + 1} = ${index + 1};`).join('\n');
const longMermaid = Array.from({ length: 13 }, (_, index) => `A-->B${index + 1}`).join('\n');
const longMath = Array.from({ length: 13 }, (_, index) => `x_${index + 1}`).join('\n');
const longPlain = Array.from({ length: 13 }, (_, index) => `paragraph ${index + 1}`).join('\n');
const shortTypeScript = Array.from({ length: 12 }, (_, index) => `const short${index + 1} = true;`).join('\n');
const doc = [
  '```ts', longTypeScript, '```',
  '```mermaid', longMermaid, '```',
  '```math', longMath, '```',
  '```', longPlain, '```',
  '```js', shortTypeScript, '```'
].join('\n');

const state = EditorState.create({
  doc,
  extensions: [
    markdown({ base: markdownLanguage }),
    ...codeBlockCollapseExtensions()
  ]
});
const sections = getCodeBlockCollapseSections(state);

if (sections.length !== 1) {
  throw new Error(`Expected only the long typed code block to be collapsible, received ${sections.length}`);
}
const section = sections[0];
if (section.contentLineCount !== 13 || !isCodeBlockCollapsed(state, section)) {
  throw new Error('Long typed code block should default to a collapsed 12-line preview');
}

const expandedForHiddenSelection = state.update({
  selection: { anchor: section.collapseFrom },
  effects: setCodeBlockSearchTargetEffect.of({ from: section.collapseFrom, to: section.collapseFrom + 1 })
}).state;
const expandedSection = getCodeBlockCollapseSections(expandedForHiddenSelection)[0];
if (isCodeBlockCollapsed(expandedForHiddenSelection, expandedSection)) {
  throw new Error('A selection in hidden code must temporarily expand the code block');
}

const expandedForBoundaryMatch = state.update({
  selection: { anchor: section.previewEnd - 1, head: section.collapseFrom + 1 },
  effects: setCodeBlockSearchTargetEffect.of({ from: section.previewEnd - 1, to: section.collapseFrom + 1 })
}).state;
const boundarySection = getCodeBlockCollapseSections(expandedForBoundaryMatch)[0];
if (isCodeBlockCollapsed(expandedForBoundaryMatch, boundarySection)) {
  throw new Error('A search match spanning the preview boundary must expand the code block');
}

const clearedSearch = expandedForHiddenSelection.update({ effects: setCodeBlockSearchTargetEffect.of(null) }).state;
const clearedSection = getCodeBlockCollapseSections(clearedSearch)[0];
if (!isCodeBlockCollapsed(clearedSearch, clearedSection)) {
  throw new Error('Clearing search must restore a non-manually-expanded code block to collapsed state');
}

console.log('code block collapse checks passed');
