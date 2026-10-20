import { ParseContext, type Language } from '@codemirror/language';
import { parseMixed, type Parser, type ParseWrapper } from '@lezer/common';
import { skipOffscreenMarkdownLanguage } from './markdownStructure';
import { markdownMixedFragments, rememberMarkdownMixedTree } from './backgroundMarkdownStructure';

/** Match Lezer Markdown's public parseCode semantics, declining offscreen hosts
 * before parseMixed materializes packed nodes and allocates inner parser jobs. */
export function markdownMixedLanguages(options: {
  readonly codeLanguage: (info: string) => Language | null;
  readonly htmlParser?: Parser;
}): { wrap: ParseWrapper } {
  const mixed = parseMixed((node, input) => {
    const code = node.name === 'FencedCode' || node.name === 'CodeBlock';
    const html = node.name === 'HTMLBlock' || node.name === 'HTMLTag' || node.name === 'CommentBlock';
    if (!code && !html) return null;
    const info = code ? node.node.getChild('CodeInfo') : null;
    const parser = code ? options.codeLanguage(info ? /^\S*/.exec(input.read(info.from, info.to))![0] : '')?.parser : options.htmlParser;
    if (!parser || skipOffscreenMarkdownLanguage(ParseContext.get(), node.from, node.to)) return null;
    if (code) return { parser, overlay: child => child.name === 'CodeText', bracketed: node.name === 'FencedCode' };
    // Direct children are Markdown container marks. The remaining source feeds
    // HTML, including script/style sublanguages, with its original coordinates.
    const ranges: Array<{ from: number; to: number }> = [];
    let from = node.from;
    for (let child = node.node.firstChild; child; child = child.nextSibling) {
      if (child.from > from) ranges.push({ from, to: child.from });
      from = child.to;
    }
    if (from < node.to) ranges.push({ from, to: node.to });
    return { parser, overlay: ranges };
  });
  return { wrap(inner, input, fragments, ranges) {
    const state = ParseContext.get()?.state;
    const parse = mixed(inner, input, state ? markdownMixedFragments(state, fragments) : fragments, ranges);
    return {
      get parsedPos() { return parse.parsedPos; }, get stoppedAt() { return parse.stoppedAt; },
      stopAt(position) { parse.stopAt(position); },
      advance() {
        const tree = parse.advance();
        if (tree && state) rememberMarkdownMixedTree(state, tree, parse.stoppedAt !== null);
        return tree;
      }
    };
  } };
}
