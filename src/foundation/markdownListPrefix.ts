import { markdownTaskMarkerPattern } from './markdownTaskList';

export type MarkdownListPrefix = {
  readonly leadingWhitespace: string;
  readonly fromOffset: number;
  readonly markerEndOffset: number;
  readonly toOffset: number;
  readonly bullet: string | undefined;
  readonly orderedNumber: string | undefined;
  readonly orderedSuffix: string | undefined;
  readonly taskMarker: string | undefined;
  readonly taskBracketStart: number | undefined;
};

const markerPattern = String.raw`(?:([-+*])|(\d+)([.)]))`;
const startPattern = new RegExp(String.raw`^(\s*)${markerPattern}(?:\s|$)`);
const prefixPattern = new RegExp(String.raw`^(\s*)${markerPattern}(?:\s+(?:${markdownTaskMarkerPattern}\s+)?|$)`);

/** A line-local prefix check for list-run discovery, without a presentation object. */
export function hasMarkdownListPrefix(lineText: string): boolean {
  return startPattern.test(lineText);
}

/** Source offsets only. The caller's parsed container decides where a list may occur. */
export function readMarkdownListPrefix(lineText: string, offset = 0): MarkdownListPrefix | null {
  const match = prefixPattern.exec(lineText.slice(offset));
  if (!match) return null;
  const fromOffset = offset + match[1].length;
  const markerEndOffset = fromOffset + (match[2]?.length ?? (match[3]?.length ?? 0) + (match[4]?.length ?? 0));
  return {
    leadingWhitespace: match[1], fromOffset, markerEndOffset, toOffset: offset + match[0].length,
    bullet: match[2], orderedNumber: match[3], orderedSuffix: match[4], taskMarker: match[5],
    taskBracketStart: match[5] === undefined ? undefined : offset + match[0].indexOf('[', markerEndOffset - offset)
  };
}
