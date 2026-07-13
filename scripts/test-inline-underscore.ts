import { collectInlineMarkdownSyntaxRanges } from '../webview/src/liveMode';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdownTagField } from '../webview/src/helpers/tags';

const intrawordText = 'hu_jjd #hu_jjd #123_dkkg';
const intrawordRanges = collectInlineMarkdownSyntaxRanges(intrawordText);
if (intrawordRanges.some((range) => intrawordText.slice(range.from, range.to) === '_')) {
  throw new Error(`Intraword underscores were treated as Markdown syntax: ${JSON.stringify(intrawordRanges)}`);
}

const emphasisText = '_italic_ and *emphasis*';
const emphasisMarkers = collectInlineMarkdownSyntaxRanges(emphasisText)
  .map((range) => emphasisText.slice(range.from, range.to));
if (emphasisMarkers.filter((marker) => marker === '_').length !== 2) {
  throw new Error(`Underscore emphasis markers were not preserved: ${JSON.stringify(emphasisMarkers)}`);
}

const tagState = EditorState.create({ doc: '#123_dkkg', extensions: [markdownTagField] });
const outerTagDecorations = tagState.facet(EditorView.outerDecorations);
const tagRanges: Array<{ from: number; to: number }> = [];
for (const decorations of outerTagDecorations) {
  decorations.between(0, tagState.doc.length, (from, to) => tagRanges.push({ from, to }));
}
if (tagRanges.length !== 1 || tagRanges[0].from !== 0 || tagRanges[0].to !== tagState.doc.length) {
  throw new Error(`Tag decoration was not kept as one outer range: ${JSON.stringify(tagRanges)}`);
}

console.log('inline underscore checks passed');
