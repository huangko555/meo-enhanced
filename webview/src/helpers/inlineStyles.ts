import { EditorView } from '@codemirror/view';
import type { MarkdownConfig } from '@lezer/markdown';
import { matchInlineScript } from '../../../src/foundation/inlineScript';
import { darkDefaultLiveStrongForeground, markdownInlineStyles } from '../../../src/shared/markdownInlineStyles';
import { mathReflowBaseStyle } from '../../../src/shared/mathStyles';

// Override the inherited parsers while retaining their node types and highlight tags.
export const inlineScriptMarkdownExtension: MarkdownConfig = {
  parseInline: (['Subscript', 'Superscript'] as const).map((name) => ({
    name,
    parse(context, next, pos) {
      if (next !== (name === 'Subscript' ? 126 : 94)) return -1;
      const match = matchInlineScript(context.text, pos - context.offset, context.end - context.offset);
      if (!match) return -1;
      const to = match.to + context.offset;
      const mark = `${name}Mark`;
      return context.addElement(context.elt(name, pos, to, [
        context.elt(mark, pos, pos + 1),
        ...match.escapes.map((escape) => context.elt('Escape', escape.from + context.offset, escape.to + context.offset)),
        context.elt(mark, to - 1, to)
      ]));
    }
  }))
};

export const markdownInlineStyleTheme = EditorView.baseTheme({
  '& .meo-md-em': markdownInlineStyles.emphasis,
  '& .meo-md-strong': markdownInlineStyles.strong,
  ["html[data-editor-appearance='dark'] &.meo-mode-live " +
    ':is(.meo-md-strong:not(.meo-live-strong-coloring *), .meo-md-html-inline strong, .meo-md-html-inline b, .meo-md-html-content strong, .meo-md-html-content b)' +
    ':not(:is(.meo-md-strong, strong, b, .meo-md-heading-content, .meo-md-h1, .meo-md-h2, .meo-md-h3, .meo-md-h4, .meo-md-h5, .meo-md-h6, .meo-md-link, .meo-md-wiki-link, .meo-task-complete, .meo-task-dropped, h1, h2, h3, h4, h5, h6, a) *, ' +
    '.meo-md-link, .meo-md-wiki-link, .meo-task-complete, .meo-task-dropped)']: {
    color: `${darkDefaultLiveStrongForeground} !important`,
    WebkitTextFillColor: 'currentColor !important'
  },
  '& .meo-md-strike': markdownInlineStyles.strikethrough,
  '&.meo-mode-live .meo-md-subscript': markdownInlineStyles.subscript,
  '&.meo-mode-live .meo-md-superscript': markdownInlineStyles.superscript,
  '& .meo-md-math-display.meo-math-reflow .katex-display > .katex > .katex-html > .base': mathReflowBaseStyle
});
