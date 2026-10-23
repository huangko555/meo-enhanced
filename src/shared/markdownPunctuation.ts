import type MarkdownIt from 'markdown-it';
import { inlineStyleDelimiter } from './punctuationInlineStyles';

export function installPunctuationInlineTransform(md: MarkdownIt): void {
  md.inline.ruler.before('strikethrough', 'meo_punctuation_styles', (state, silent) => {
    if (silent || !'*~'.includes(state.src[state.pos] ?? '')) return false;
    const delimiter = inlineStyleDelimiter(state.src, state.pos, state.posMax);
    if (!delimiter) return false;
    if (delimiter.marker === '~~' && delimiter.length !== 2) {
      state.push('text', '', 0).content = state.src.slice(state.pos, state.pos + delimiter.length);
      state.pos += delimiter.length;
      return true;
    }
    // Native postprocessors own nesting, split asterisk runs and the rule of three.
    // Two-character strike markers are one token and bypass that rule.
    const tokenSize = delimiter.marker === '*' ? 1 : 2;
    for (let index = 0; index < delimiter.length; index += tokenSize) {
      state.push('text', '', 0).content = delimiter.marker;
      state.delimiters.push({
        marker: state.src.charCodeAt(state.pos),
        length: tokenSize === 1 ? delimiter.length : 0,
        ['token']: state.tokens.length - 1, end: -1,
        open: delimiter.canOpen, close: delimiter.canClose
      });
    }
    state.pos += delimiter.length;
    return true;
  });
}
