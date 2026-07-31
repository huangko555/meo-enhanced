import type MarkdownIt from 'markdown-it';

const HIGHLIGHT_MARKER_CODE = 0x3D;

function tokenize(state: any, silent: boolean): boolean {
  if (silent || state.src.charCodeAt(state.pos) !== HIGHLIGHT_MARKER_CODE) return false;

  const scanned = state.scanDelims(state.pos, true);
  if (scanned.length !== 2) return false;

  const markerText = state.push('text', '', 0);
  markerText.content = '==';
  state.delimiters.push({
    marker: HIGHLIGHT_MARKER_CODE,
    length: 0,
    ['token']: state.tokens.length - 1,
    end: -1,
    open: scanned.can_open,
    close: scanned.can_close
  });
  state.pos += 2;
  return true;
}

function resolveDelimiters(state: any, delimiters: any[]): void {
  for (const delimiter of delimiters) {
    if (delimiter.marker !== HIGHLIGHT_MARKER_CODE || delimiter.end === -1) continue;
    const closingDelimiter = delimiters[delimiter.end];

    const openingMarkerNode = state.tokens[delimiter.token];
    openingMarkerNode.type = 'mark_open';
    openingMarkerNode.tag = 'mark';
    openingMarkerNode.nesting = 1;
    openingMarkerNode.markup = '==';
    openingMarkerNode.content = '';

    const closingMarkerNode = state.tokens[closingDelimiter.token];
    closingMarkerNode.type = 'mark_close';
    closingMarkerNode.tag = 'mark';
    closingMarkerNode.nesting = -1;
    closingMarkerNode.markup = '==';
    closingMarkerNode.content = '';
  }
}

function postProcess(state: any): boolean {
  resolveDelimiters(state, state.delimiters);
  for (const metadata of state.tokens_meta) {
    if (metadata?.delimiters) resolveDelimiters(state, metadata.delimiters);
  }
  return true;
}

export function installHighlightTransform(md: MarkdownIt): void {
  md.inline.ruler.before('emphasis', 'meo_highlight', tokenize);
  md.inline.ruler2.before('emphasis', 'meo_highlight', postProcess);
}
