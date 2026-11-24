export type AlertType = 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION';

const directive = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i;

/** Callers establish that this text opens the quote's own paragraph. */
export function readMarkdownAlertDirective(text: string, github = false): { type: AlertType; length: number } | null {
  const match = directive.exec(text);
  if (!match || (github && !/^[ \t]*(?:\n|$)/.test(text.slice(match[0].length)))) return null;
  return { type: match[1]!.toUpperCase() as AlertType, length: match[0].length };
}
