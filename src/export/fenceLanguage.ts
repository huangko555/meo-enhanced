const FENCE_LANGUAGE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  m: 'powerquery',
  pq: 'powerquery',
  rs: 'rust',
  golang: 'go',
  cs: 'csharp',
  'c#': 'csharp'
});

export function normalizeFenceLanguage(info: string): string {
  const first = `${info ?? ''}`.trim().split(/\s+/, 1)[0] ?? '';
  const normalized = first.toLowerCase();
  return FENCE_LANGUAGE_ALIASES[normalized] ?? normalized;
}
