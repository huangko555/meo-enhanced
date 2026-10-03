import { EditorView } from '@codemirror/view';
import type { MarkdownConfig } from '@lezer/markdown';
import { matchInlineScript } from '../../../src/foundation/inlineScript';
import { markdownInlineStyles } from '../../../src/shared/markdownInlineStyles';

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
  '& .meo-md-strike': markdownInlineStyles.strikethrough,
  '&.meo-mode-live .meo-md-subscript': markdownInlineStyles.subscript,
  '&.meo-mode-live .meo-md-superscript': markdownInlineStyles.superscript
});
