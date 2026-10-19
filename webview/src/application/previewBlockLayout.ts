import type { PreviewDocumentBlock } from '../../../src/foundation/previewDocument';

/** Logical block heights remain available after their DOM and resources are released. */
export function createPreviewBlockLayout(blocks: readonly PreviewDocumentBlock[], options: {
  width: number; fontSize: number; lineHeight: number;
}) {
  const heights = new Float64Array(blocks.length);
  const sums = new Float64Array(blocks.length + 1);
  const add = (index: number, delta: number) => {
    for (let cursor = index + 1; cursor < sums.length; cursor += cursor & -cursor) sums[cursor]! += delta;
  };
  const top = (index: number): number => {
    let value = 0;
    for (let cursor = Math.max(0, Math.min(blocks.length, index)); cursor > 0; cursor -= cursor & -cursor) value += sums[cursor]!;
    return value;
  };
  const columns = Math.max(16, options.width / (options.fontSize * 0.55));
  for (const block of blocks) {
    const lines = Math.max(1, block.sourceEndLine - block.sourceLine + 1);
    const visualLines = Math.max(1, Math.ceil(block.sourceCharacters / columns));
    const height = /^(?:fence|code_block)$/.test(block.kind) ? lines * options.lineHeight + 32
      : block.kind === 'heading_open' ? options.lineHeight * 1.7 + 24
      : /(?:table|list|blockquote|html|footnotes|frontmatter)/.test(block.kind)
        ? Math.max(lines, visualLines) * options.lineHeight + 16 : visualLines * options.lineHeight + 16;
    heights[block.index] = height;
    add(block.index, height);
  }
  const at = (offset: number): number => {
    if (!blocks.length) return 0;
    let index = 0, sum = 0;
    let step = 1;
    while (step * 2 <= blocks.length) step *= 2;
    for (; step > 0; step >>>= 1) {
      const next = index + step;
      if (next <= blocks.length && sum + sums[next]! <= offset) { sum += sums[next]!; index = next; }
    }
    return Math.min(blocks.length - 1, index);
  };
  return {
    top,
    at,
    height: (index: number) => heights[index] ?? 0,
    total: () => top(blocks.length),
    measure(index: number, height: number) {
      if (index < 0 || index >= blocks.length || !Number.isFinite(height) || height < 0) return false;
      height = Math.max(1, height);
      const delta = height - heights[index]!;
      if (Math.abs(delta) < 0.5) return false;
      heights[index] = height;
      add(index, delta);
      return true;
    },
    window(offset: number, height: number) {
      const visibleFrom = at(offset);
      const visibleTo = Math.min(blocks.length, at(offset + height) + 1);
      const from = Math.max(at(Math.max(0, offset - height)), visibleFrom - 16);
      const to = Math.max(visibleTo, Math.min(blocks.length, at(offset + height * 2) + 1, from + 64));
      return { from, to };
    }
  };
}
