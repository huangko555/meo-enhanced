import MarkdownIt from 'markdown-it';
import { collectLatexMathRanges, renderLatexMathToHtml } from './math';

type MathInlineChunkPart = {
  token: any;
  from: number;
  to: number;
  text: string;
};

function createInlineTextToken(TokenCons: any, content: string): any {
  return createInlineContentToken(TokenCons, 'text', content);
}

function createInlineContentToken(TokenCons: any, type: string, content: string): any {
  const token = new TokenCons(type, '', 0);
  token.content = content;
  return token;
}

function createInlineSoftbreakToken(TokenCons: any): any {
  return new TokenCons('softbreak', 'br', 0);
}

function isMathInlineTextToken(token: any): boolean {
  return token?.type === 'text' || token?.type === 'text_special' || token?.type === 'softbreak' || token?.type === 'hardbreak';
}

function appendPlainRawSliceTokens(
  target: any[],
  source: string,
  from: number,
  to: number,
  TokenCons: any
): void {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return;
  }

  const slice = source.slice(from, to);
  if (!slice) {
    return;
  }

  const normalized = slice.replace(/\r\n?/g, '\n');
  const segments = normalized.split('\n');

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] ?? '';
    if (segment) {
      target.push(createInlineTextToken(TokenCons, segment));
    }
    if (i < segments.length - 1) {
      target.push(createInlineSoftbreakToken(TokenCons));
    }
  }
}

function renderMathFromRawInlineContent(
  source: string,
  TokenCons: any,
  onRenderedMath?: () => void
): { changed: boolean; children: any[] } {
  if (!source || !source.includes('$')) {
    return { changed: false, children: [] };
  }

  const mathRanges = collectLatexMathRanges(source);
  if (!mathRanges.length) {
    return { changed: false, children: [] };
  }

  if (mathRanges.length === 1 && mathRanges[0].from === 0 && mathRanges[0].to === source.length) {
    const fullMath = mathRanges[0];
    const renderedMath = renderLatexMathToHtml(fullMath.content, fullMath.mode);
    if (!renderedMath) {
      return { changed: false, children: [] };
    }
    const htmlNode = new TokenCons('html_inline', '', 0);
    htmlNode.meta = { ...(htmlNode.meta ?? {}), meoTrustedHtml: true };
    const fencedClass = fullMath.mode === 'display' && fullMath.fencedDisplay ? ' meo-export-math-fenced-display' : '';
    htmlNode.content = [
      `<span class="meo-export-math meo-export-math-${fullMath.mode}${fencedClass}">`,
      renderedMath,
      '</span>'
    ].join('');
    onRenderedMath?.();
    return { changed: true, children: [htmlNode] };
  }

  const output: any[] = [];
  let cursor = 0;

  for (const mathRange of mathRanges) {
    if (mathRange.from > cursor) {
      appendPlainRawSliceTokens(output, source, cursor, mathRange.from, TokenCons);
    }

    const renderedMath = renderLatexMathToHtml(mathRange.content, mathRange.mode);
    if (!renderedMath) {
      appendPlainRawSliceTokens(output, source, mathRange.from, mathRange.to, TokenCons);
      cursor = mathRange.to;
      continue;
    }

    const htmlNode = new TokenCons('html_inline', '', 0);
    htmlNode.meta = { ...(htmlNode.meta ?? {}), meoTrustedHtml: true };
    const fencedClass = mathRange.mode === 'display' && mathRange.fencedDisplay ? ' meo-export-math-fenced-display' : '';
    htmlNode.content = [
      `<span class="meo-export-math meo-export-math-${mathRange.mode}${fencedClass}">`,
      renderedMath,
      '</span>'
    ].join('');
    output.push(htmlNode);
    onRenderedMath?.();
    cursor = mathRange.to;
  }

  if (cursor < source.length) {
    appendPlainRawSliceTokens(output, source, cursor, source.length, TokenCons);
  }

  return { changed: true, children: output };
}

function appendMathChunkPlainSlice(
  target: any[],
  parts: ReadonlyArray<MathInlineChunkPart>,
  from: number,
  to: number,
  TokenCons: any
): void {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return;
  }

  for (const part of parts) {
    if (part.to <= from || part.from >= to) {
      continue;
    }

    const sliceFrom = Math.max(from, part.from) - part.from;
    const sliceTo = Math.min(to, part.to) - part.from;
    if (sliceTo <= sliceFrom) {
      continue;
    }

    if (part.token.type === 'text' || part.token.type === 'text_special') {
      const textSlice = part.text.slice(sliceFrom, sliceTo);
      if (textSlice) {
        target.push(createInlineContentToken(TokenCons, part.token.type, textSlice));
      }
      continue;
    }

    target.push(part.token);
  }
}

function renderMathChunk(
  chunk: any[],
  TokenCons: any,
  onRenderedMath?: () => void
): { changed: boolean; children: any[] } {
  const parts: MathInlineChunkPart[] = [];
  let offset = 0;
  let hasDollar = false;

  for (const child of chunk) {
    if (child.type === 'text' || child.type === 'text_special') {
      const text = String(child.content ?? '');
      const part = {
        token: child,
        from: offset,
        to: offset + text.length,
        text
      };
      parts.push(part);
      offset = part.to;
      if (!hasDollar && text.includes('$')) {
        hasDollar = true;
      }
      continue;
    }

    const part = {
      token: child,
      from: offset,
      to: offset + 1,
      text: '\n'
    };
    parts.push(part);
    offset = part.to;
  }

  if (!hasDollar) {
    return { changed: false, children: chunk };
  }

  const chunkText = parts.map((part) => part.text).join('');
  const mathRanges = collectLatexMathRanges(chunkText);
  if (!mathRanges.length) {
    return { changed: false, children: chunk };
  }

  const output: any[] = [];
  let cursor = 0;

  for (const mathRange of mathRanges) {
    if (mathRange.from > cursor) {
      appendMathChunkPlainSlice(output, parts, cursor, mathRange.from, TokenCons);
    }

    const renderedMath = renderLatexMathToHtml(mathRange.content, mathRange.mode);
    if (!renderedMath) {
      appendMathChunkPlainSlice(output, parts, mathRange.from, mathRange.to, TokenCons);
      cursor = mathRange.to;
      continue;
    }

    const htmlNode = new TokenCons('html_inline', '', 0);
    htmlNode.meta = { ...(htmlNode.meta ?? {}), meoTrustedHtml: true };
    const fencedClass = mathRange.mode === 'display' && mathRange.fencedDisplay ? ' meo-export-math-fenced-display' : '';
    htmlNode.content = [
      `<span class="meo-export-math meo-export-math-${mathRange.mode}${fencedClass}">`,
      renderedMath,
      '</span>'
    ].join('');
    output.push(htmlNode);
    onRenderedMath?.();
    cursor = mathRange.to;
  }

  if (cursor < chunkText.length) {
    appendMathChunkPlainSlice(output, parts, cursor, chunkText.length, TokenCons);
  }

  return { changed: true, children: output };
}

export function installMathTransform(
  md: MarkdownIt,
  options: {
    onRenderedMath?: () => void;
  } = {}
): void {
  md.block.ruler.before('fence', 'meo-math-block', (state: any, startLine: number, endLine: number, silent: boolean) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const end = state.eMarks[startLine];
    if (state.src.slice(start, end).trim() !== '$$') {
      return false;
    }

    for (let line = startLine + 1; line < endLine; line += 1) {
      const lineStart = state.bMarks[line] + state.tShift[line];
      const lineEnd = state.eMarks[line];
      if (state.src.slice(lineStart, lineEnd).trim() !== '$$') {
        continue;
      }
      if (silent) {
        return true;
      }

      const content = state.getLines(startLine + 1, line, state.blkIndent, false).trim();
      if (!content) {
        return false;
      }
      const mathBlock = state.push('meo_math_block', 'div', 0);
      mathBlock.block = true;
      mathBlock.content = content;
      mathBlock.map = [startLine, line + 1];
      mathBlock.markup = '$$';
      state.line = line + 1;
      return true;
    }

    return false;
  });

  md.renderer.rules.meo_math_block = (tokens, idx, _options, _env, self) => {
    const mathBlock = tokens[idx];
    const renderedMath = renderLatexMathToHtml(String(mathBlock.content ?? ''), 'display');
    if (!renderedMath) {
      return `<pre>${md.utils.escapeHtml(`$$\n${mathBlock.content}\n$$`)}</pre>\n`;
    }
    options.onRenderedMath?.();
    return `<div class="meo-export-math meo-export-math-display meo-export-math-fenced-display"${self.renderAttrs(mathBlock)}>${renderedMath}</div>\n`;
  };

  md.core.ruler.after('inline', 'meo-math-transform', (state: any) => {
    if (!String(state.src ?? '').includes('$')) {
      return;
    }

    for (const token of state.tokens as any[]) {
      if (token.type !== 'inline' || !Array.isArray(token.children) || token.children.length === 0) {
        continue;
      }

      if (!String(token.content ?? '').includes('$')) {
        continue;
      }

      const TokenCons = token.children[0]?.constructor as any;
      if (!TokenCons) {
        continue;
      }

      const hasOnlyTextLikeChildren = token.children.every((child: any) => isMathInlineTextToken(child));
      if (hasOnlyTextLikeChildren) {
        const transformed = renderMathFromRawInlineContent(String(token.content ?? ''), TokenCons, options.onRenderedMath);
        if (transformed.changed) {
          token.children = transformed.children;
        }
        continue;
      }

      let changed = false;
      const nextChildren: any[] = [];
      let chunk: any[] = [];

      const flushChunk = (): void => {
        if (!chunk.length) {
          return;
        }
        const transformed = renderMathChunk(chunk, TokenCons, options.onRenderedMath);
        if (transformed.changed) {
          changed = true;
        }
        nextChildren.push(...transformed.children);
        chunk = [];
      };

      for (const child of token.children) {
        if (child.type === 'text_special' && String(child.content ?? '') === '$') {
          flushChunk();
          nextChildren.push(child);
          continue;
        }

        if (isMathInlineTextToken(child)) {
          chunk.push(child);
          continue;
        }
        flushChunk();
        nextChildren.push(child);
      }

      flushChunk();

      if (changed) {
        token.children = nextChildren;
      }
    }
  });
}
