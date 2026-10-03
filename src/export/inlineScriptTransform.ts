import type MarkdownIt from 'markdown-it';
import { matchInlineScript } from '../foundation/inlineScript';

function tokenize(state: MarkdownIt.StateInline, silent: boolean): boolean {
  const match = matchInlineScript(state.src, state.pos, state.posMax);
  if (!match) return false;
  if (!silent) {
    const tag = match.kind === 'subscript' ? 'sub' : 'sup';
    const markup = state.src[state.pos];
    state.push(`${tag}_open`, tag, 1).markup = markup;
    state.push('text', '', 0).content = match.content;
    state.push(`${tag}_close`, tag, -1).markup = markup;
  }
  state.pos = match.to;
  return true;
}

export function installInlineScriptTransform(md: MarkdownIt): void {
  // Double tildes belong to strikethrough and must be consumed first.
  md.inline.ruler.after('strikethrough', 'meo_inline_script', tokenize);
}
