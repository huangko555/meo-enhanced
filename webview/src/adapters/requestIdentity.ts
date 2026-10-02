let fallbackSequence = 0;
/** Correlation IDs also work in local development pages without secure-context randomUUID. */
export function createRequestPrefix(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto?.getRandomValues === 'function') return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  return `${Date.now().toString(36)}-${++fallbackSequence}-${Math.random().toString(36).slice(2)}`;
}
