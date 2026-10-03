import type { InputAssistance } from '../../../src/foundation/editingPreferences';
export type SuggestionContext = { readonly type: 'slash' | 'emoji' | 'documents' | 'paths' | 'headings'; readonly query: string; readonly target: string; readonly length: number; readonly wiki: boolean };
/** Reads a bounded line prefix; code and selection exclusions belong to the editor adapter. */
export function detectSuggestionContext(before: string, preferences: InputAssistance): SuggestionContext | null {
  if (before.length > 1000) return null;
  const emoji = preferences.emoji ? /(?:^|\s):([a-z0-9_+-][a-z0-9_+-]*)$/i.exec(before) : null;
  if (emoji) return { type: 'emoji', query: emoji[1], target: '', length: emoji[1].length + 1, wiki: false };
  if (!preferences.documentSuggestions) return null;
  const wiki = /\[\[([^\]\n|]{0,500})$/.exec(before);
  const path = wiki ? null : /\[[^\]\n]*\]\(([^)\n]{0,500})$/.exec(before);
  const match = wiki ?? path;
  if (match && (/\\+$/.exec(before.slice(0, match.index))?.[0].length ?? 0) % 2) return null;
  const value = wiki?.[1] ?? path?.[1];
  if (value === undefined || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return null;
  const hash = value.indexOf('#');
  return hash < 0 ? { type: wiki ? 'documents' : 'paths', query: value, target: '', length: value.length, wiki: !!wiki }
    : { type: 'headings', query: value.slice(hash + 1), target: value.slice(0, hash), length: value.length - hash - 1, wiki: !!wiki };
}
export const emojiSuggestions: readonly { name: string; value: string }[] = [
  { name: 'smile', value: '😄' }, { name: 'grin', value: '😁' }, { name: 'joy', value: '😂' }, { name: 'heart', value: '❤️' }, { name: 'thumbsup', value: '👍' },
  { name: 'thumbsdown', value: '👎' }, { name: 'tada', value: '🎉' }, { name: 'rocket', value: '🚀' }, { name: 'fire', value: '🔥' }, { name: 'sparkles', value: '✨' },
  { name: 'check', value: '✅' }, { name: 'warning', value: '⚠️' }, { name: 'question', value: '❓' }, { name: 'bulb', value: '💡' }, { name: 'memo', value: '📝' },
  { name: 'eyes', value: '👀' }, { name: 'thinking', value: '🤔' }, { name: 'wave', value: '👋' }, { name: 'clap', value: '👏' }, { name: 'pray', value: '🙏' },
  { name: 'star', value: '⭐' }, { name: '100', value: '💯' }, { name: 'bug', value: '🐛' }, { name: 'wrench', value: '🔧' }, { name: 'link', value: '🔗' },
  { name: 'calendar', value: '📅' }, { name: 'coffee', value: '☕' }, { name: 'book', value: '📖' }, { name: 'lock', value: '🔒' }, { name: 'muscle', value: '💪' }
];
