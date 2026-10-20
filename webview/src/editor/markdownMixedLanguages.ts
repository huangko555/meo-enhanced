import { ParseContext, type Language } from '@codemirror/language';
import { parseMixed, TreeFragment, type PartialParse, type Parser, type ParseWrapper } from '@lezer/common';
import { clipMarkdownMixedFragments, isCompleteMarkdownStructure, markdownLanguageViewport,
  skipOffscreenMarkdownLanguage, type MarkdownLanguageViewport } from './markdownStructure';
import { backgroundMarkdownLanguageHosts, markdownMixedFragments, rememberMarkdownMixedTree } from './backgroundMarkdownStructure';
import { markdownLanguageHostRanges } from './markdownLanguageHosts';

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
    const context = ParseContext.get(), state = context?.state;
    const scoped = markdownLanguageViewport(context);
    let viewport: MarkdownLanguageViewport | undefined;
    let parse: PartialParse | undefined = scoped ? undefined
      : mixed(inner, input, state ? markdownMixedFragments(state, fragments) : fragments, ranges);
    return {
      get parsedPos() { return parse?.parsedPos ?? 0; }, get stoppedAt() { return parse ? parse.stoppedAt : inner.stoppedAt; },
      stopAt(position) { (parse ?? inner).stopAt(position); },
      advance() {
        if (!parse) {
          const outer = inner.advance();
          if (!outer) return null;
          let reusable = state ? markdownMixedFragments(state, fragments) : fragments;
          const current = ParseContext.get();
          if (current && state && current.state.doc === state.doc && isCompleteMarkdownStructure(outer, input.length)
            && ranges.length === 1 && ranges[0]!.from === 0 && ranges[0]!.to === input.length) {
            viewport = markdownLanguageViewport(current);
            if (viewport) {
              // Inner-language fragments refer to their complete host. Clipping
              // inside a giant code/HTML block would discard its LR reuse.
              const visible = viewport;
              let from = viewport.from, to = viewport.to;
              const includeHost = (hostFrom: number, hostTo: number) => {
                if (hostTo > visible.from && hostFrom < visible.to) {
                  from = Math.min(from, hostFrom); to = Math.max(to, hostTo);
                } else current.skipUntilInView(hostFrom, hostTo);
              };
              const packed = backgroundMarkdownLanguageHosts(state, outer);
              if (packed) for (let index = 0; index < packed.length; index += 2) includeHost(packed[index]!, packed[index + 1]!);
              else for (const host of markdownLanguageHostRanges(outer)) includeHost(host.from, host.to);
              viewport = { from, to };
              reusable = clipMarkdownMixedFragments(reusable, viewport);
              // parseMixed's public fragment contract skips identical subtrees.
              // Outside this viewport only the outer Markdown is required; mark
              // it skipped so entering that source requests its real grammar.
              if (viewport.from > 0) {
                reusable = [new TreeFragment(0, viewport.from, outer, 0), ...reusable];
              }
              if (viewport.to < input.length) {
                reusable = [...reusable, new TreeFragment(viewport.to, input.length, outer, 0)];
              }
            }
          }
          parse = mixed({ get parsedPos() { return inner.parsedPos; }, get stoppedAt() { return inner.stoppedAt; },
            stopAt(position) { inner.stopAt(position); }, advance: () => outer }, input, reusable, ranges);
          if (inner.stoppedAt !== null) parse.stopAt(inner.stoppedAt);
        }
        const tree = parse.advance();
        if (tree && state) rememberMarkdownMixedTree(state, tree, parse.stoppedAt !== null, viewport);
        return tree;
      }
    };
  } };
}
