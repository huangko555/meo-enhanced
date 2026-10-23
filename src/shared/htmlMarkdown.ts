import MarkdownIt from 'markdown-it';
import { matchInlineHtmlCode } from './htmlPolicy';
import { installHighlightTransform } from './markdownHighlight';
import { installInlineScriptTransform } from './markdownInlineScript';
import { installPunctuationInlineTransform } from './markdownPunctuation';

// HTML blocks keep CommonMark's raw boundaries; inline HTML participates in the
// same text styles as ordinary prose. The caller sanitizes the generated HTML.
const markdown = new MarkdownIt({ html: true, linkify: true, breaks: true });
installHighlightTransform(markdown);
installInlineScriptTransform(markdown);
installPunctuationInlineTransform(markdown);
markdown.inline.ruler.before('html_inline', 'meo_literal_html_code', (state, silent) => {
  const match = matchInlineHtmlCode(state.src, state.pos, state.posMax);
  if (!match) return false;
  if (!silent) state.push('html_inline', '', 0).content = state.src.slice(state.pos, match.to);
  state.pos = match.to;
  return true;
});

export function renderHtmlMarkdown(source: string, inline = false): string {
  return inline ? markdown.renderInline(source) : markdown.render(source);
}
