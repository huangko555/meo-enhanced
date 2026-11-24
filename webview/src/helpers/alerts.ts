import { WidgetType, type EditorView } from '@codemirror/view';
import { mapLiveWidgetPositions } from '../editor/liveWidgetPositions';
import { createElement, Info, Lightbulb, AlertCircle, AlertTriangle, XCircle } from 'lucide';
import { getUiStrings } from '../application/uiLanguage';
import { UiLanguageSensitiveWidget, uiLanguageFacet } from '../editor/uiLanguage';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNodeRef } from '@lezer/common';
import { readMarkdownAlertDirective, type AlertType } from '../../../src/foundation/markdownAlert';
import { hrefFromSourceLinkNode } from './linkNavigation';

export type { AlertType } from '../../../src/foundation/markdownAlert';

function getAlertIconElement(type: AlertType): Element {
  const iconProps = { 'aria-hidden': 'true', width: 16, height: 16 };
  switch (type) {
    case 'NOTE':
      return createElement(Info, iconProps);
    case 'TIP':
      return createElement(Lightbulb, iconProps);
    case 'IMPORTANT':
      return createElement(AlertCircle, iconProps);
    case 'WARNING':
      return createElement(AlertTriangle, iconProps);
    case 'CAUTION':
      return createElement(XCircle, iconProps);
    default:
      return createElement(Info, iconProps);
  }
}

export class AlertIconWidget extends UiLanguageSensitiveWidget {
  [mapLiveWidgetPositions](): WidgetType { return this; }
  type: AlertType;

  constructor(type: AlertType) {
    super();
    this.type = type;
  }

  eq(other: WidgetType): boolean {
    return other instanceof AlertIconWidget &&
      this.hasSameUiLanguageEpoch(other) &&
      other.type === this.type;
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('span');
    container.className = 'meo-md-alert-icon';
    container.appendChild(getAlertIconElement(this.type));
    const label = document.createElement('span');
    label.className = 'meo-md-alert-label';
    label.textContent = getUiStrings(view.state.facet(uiLanguageFacet)).alertLabel(this.type);
    container.appendChild(label);
    return container;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export interface AlertBlock {
  type: AlertType;
  from: number;
  to: number;
  lineFrom: number;
  lineTo: number;
  directiveFrom: number;
  directiveTo: number;
  labelFrom: number;
  labelTo: number;
}

export function detectAlertInBlockquote(state: EditorState, node: SyntaxNodeRef): AlertBlock | null {
  let marker = node.node.firstChild;
  const paragraph = marker?.nextSibling;
  if (marker?.name !== 'QuoteMark' || paragraph?.name !== 'Paragraph') return null;
  let firstInline = paragraph.firstChild;
  // Leading blank quote lines may be included in Lezer's first paragraph.
  while (firstInline?.name === 'QuoteMark' && !state.doc.sliceString(marker.to, firstInline.from).trim()) {
    marker = firstInline;
    firstInline = firstInline.nextSibling;
  }
  const line = state.doc.lineAt(marker.from);
  const afterMarker = state.doc.sliceString(marker.to, line.to);
  const text = afterMarker.trimStart();
  const start = marker.to + afterMarker.length - text.length;
  const directive = readMarkdownAlertDirective(text);
  if (!directive) return null;
  if (firstInline?.name === 'Link' && firstInline.from === start
    && (firstInline.getChildren('LinkMark').length > 2 || hrefFromSourceLinkNode(state, firstInline))) return null;

  return {
    type: directive.type,
    from: node.from,
    to: node.to,
    lineFrom: line.from,
    lineTo: line.to,
    directiveFrom: marker.from,
    directiveTo: start + directive.length,
    labelFrom: start + 2,
    labelTo: start + directive.length - 1
  };
}
