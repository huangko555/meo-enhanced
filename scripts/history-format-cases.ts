/** Public editing examples shared by capability and split-Worker history tests.
 * Each new entry automatically inherits both replay directions and all states. */
export function historyFormatCases(text: string) {
  return [
    ['bold', `**${text}**`], ['italic', `*${text}*`], ['lineover', `~~${text}~~`],
    ['highlight', `==${text}==`], ['inlineCode', `\`${text}\``], ['link', `[${text}]()`],
    ['wikiLink', `[[${text}]]`], ['kbd', `<kbd>${text}</kbd>`], ['underline', `<u>${text}</u>`]
  ] as const;
}

export function formattedHistoryRange(action: string, formatted: string, text: string, offset = 0) {
  const from = offset + formatted.indexOf(text);
  return action === 'link' ? { anchor: offset + formatted.length - 1, head: offset + formatted.length - 1 }
    : action === 'wikiLink' ? { anchor: offset + formatted.length, head: offset + formatted.length }
    : { anchor: from, head: from + text.length };
}
