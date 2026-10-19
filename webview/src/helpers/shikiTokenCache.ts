import type { ShikiTokenLines } from './shikiTypes';

const byteBudget = 8 * 1024 * 1024;

/** Includes source keys, token text and scope metadata. This conservative byte
 * estimate bounds retained results across revisions as well as entry count. */
function retainedBytes(key: string, tokens: ShikiTokenLines): number {
  let bytes = key.length * 2;
  for (const line of tokens) {
    bytes += 32;
    for (const syntaxToken of line) {
      bytes += 96 + syntaxToken.content.length * 2;
      for (const scope of syntaxToken.scopeNames ?? []) bytes += 16 + scope.length * 2;
    }
  }
  return bytes;
}

export function createShikiTokenCache(entryLimit: number) {
  const entries = new Map<string, { tokens: ShikiTokenLines; bytes: number }>();
  let bytes = 0;
  const remove = (key: string) => {
    const entry = entries.get(key);
    if (entry) { entries.delete(key); bytes -= entry.bytes; }
  };
  return {
    get size() { return entries.size; },
    has(key: string) { return entries.has(key); },
    get(key: string): ShikiTokenLines | undefined {
      const entry = entries.get(key);
      if (entry) { entries.delete(key); entries.set(key, entry); }
      return entry?.tokens;
    },
    set(key: string, tokens: ShikiTokenLines): void {
      remove(key);
      const weight = retainedBytes(key, tokens);
      while (entries.size && (entries.size >= entryLimit || bytes + weight > byteBudget)) {
        remove(entries.keys().next().value!);
      }
      // Permit one oversized current result. The next different result evicts
      // it rather than retaining several large historical versions.
      entries.set(key, { tokens, bytes: weight }); bytes += weight;
    },
    clear(): void { entries.clear(); bytes = 0; }
  };
}
