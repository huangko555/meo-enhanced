export function findYamlMappingSeparator(lineText: string, startOffset: number): number {
  let quote: 'single' | 'double' | null = null;
  let flowDepth = 0;

  for (let index = startOffset; index < lineText.length; index += 1) {
    const character = lineText[index];

    if (quote === 'double') {
      if (character === '\\') {
        index += 1;
      } else if (character === '"') {
        quote = null;
      }
      continue;
    }

    if (quote === 'single') {
      if (character === "'" && lineText[index + 1] === "'") {
        index += 1;
      } else if (character === "'") {
        quote = null;
      }
      continue;
    }

    if (character === '"') {
      quote = 'double';
      continue;
    }
    if (character === "'") {
      quote = 'single';
      continue;
    }
    if (character === '[' || character === '{') {
      flowDepth += 1;
      continue;
    }
    if (character === ']' || character === '}') {
      flowDepth = Math.max(0, flowDepth - 1);
      continue;
    }
    if (
      character === ':'
      && flowDepth === 0
      && (index + 1 === lineText.length || /\s/.test(lineText[index + 1] ?? ''))
    ) {
      return index;
    }
  }

  return -1;
}
