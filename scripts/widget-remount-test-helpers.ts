import { type WidgetType } from '@codemirror/view';
import type { Range } from '@codemirror/state';
import type { Decoration } from '@codemirror/view';
import { createEditor } from './test-editor-factory';
import { addMermaidDiagram } from '../webview/src/helpers/codeBlocks';
import { addHtmlContentDecorations } from '../webview/src/helpers/htmlContent';
import { ImageGroupWidget, ImageWidget, setImageSrcResolver } from '../webview/src/helpers/images';
import { getImagePresentationFactory } from '../webview/src/editor/imagePresentation';
import { resolvedSyntaxTree } from '../webview/src/helpers/markdownSyntax';
import { usesLargeDocumentDerivedWorkBudget } from '../webview/src/editor/liveInputDerivedWork';

let sequence = 0;

/** Replays CodeMirror's replacement-before-destruction order through real Widgets. */
export function createWidgetRemountProbe(kind: 'mermaid' | 'image' | 'group' | 'html' | 'inline-html', large: boolean) {
  const marker = `REMOUNT_${++sequence}`;
  const url = `${marker}.svg`;
  const diagram = `flowchart LR\n${marker} --> Ready`;
  const source = kind === 'mermaid' ? `\`\`\`mermaid\n${diagram}\n\`\`\``
    : kind === 'html' ? `<figure><img src="${url}"><figcaption>Image</figcaption></figure>`
      : kind === 'inline-html' ? `An inline <img src="${url}"> image.`
        : `![Image](${url})`;
  const text = `Before\n\n${source}\n\nAfter` + (large ? '\nTail paragraph.\n'.repeat(6_000) : '');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = 0;
  const runtime = window.mermaid;
  const originalRender = runtime?.render;
  if (kind === 'mermaid') {
    if (!runtime || !originalRender) throw new Error('Mermaid fixture runtime is missing');
    runtime.render = async (id, value, container) => {
      if (value.includes(marker)) { started++; await gate; }
      return originalRender.call(runtime, id, value, container);
    };
  } else {
    setImageSrcResolver(async value => {
      if (value !== url) return value;
      started++;
      await gate;
      return `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="blue"/></svg>')}`;
    });
  }
  const parent = document.createElement('div');
  parent.style.height = '340px';
  document.body.append(parent);
  const editor = createEditor({ parent, text, initialMode: 'live', onApplyChanges() {} });
  const view = editor.view;
  const ranges: Range<Decoration>[] = [];
  let widget: WidgetType | undefined;
  if (kind === 'mermaid') {
    resolvedSyntaxTree(view.state).iterate({ enter(node) {
      if (node.name === 'FencedCode') addMermaidDiagram(ranges, view.state, node);
    } });
    widget = ranges.find(range => range.value.spec.widget)?.value.spec.widget;
  } else if (kind === 'html' || kind === 'inline-html') {
    addHtmlContentDecorations(ranges, view.state, new Set());
    widget = ranges.find(range => range.to > range.from && range.value.spec.widget)?.value.spec.widget;
  } else {
    const factory = getImagePresentationFactory(view.state);
    widget = kind === 'image' ? new ImageWidget(url, 'Image', '', null, factory)
      : new ImageGroupWidget([{ url, altText: 'Image', linkUrl: '', sourceFrom: text.indexOf('![') }], factory);
  }
  if (!widget) throw new Error(`${kind} fixture did not create a rendered Widget`);
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;top:60px;left:10px;width:600px;';
  view.scrollDOM.append(host);
  const oldDOM = widget.toDOM(view);
  host.append(oldDOM);
  const currentDOM = widget.toDOM(view);
  host.append(currentDOM);
  widget.destroy(oldDOM);
  oldDOM.remove();
  const retiredHtml = oldDOM.innerHTML;
  const originalSelection = view.state.selection.toJSON();
  const selector = kind === 'mermaid' ? '.meo-mermaid-svg-wrapper > svg' : 'img.meo-md-image-img';
  return {
    release,
    openImageFullscreen() {
      const button = currentDOM.querySelector<HTMLButtonElement>('button[aria-label="Fullscreen image"]');
      if (!button) throw new Error('Replacement image controls are missing');
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    },
    retireOldAgain() { widget!.destroy(oldDOM); },
    snapshot() {
      const bounds = currentDOM.getBoundingClientRect(), viewport = view.scrollDOM.getBoundingClientRect();
      return {
        started, ready: Boolean(currentDOM.querySelector(selector)),
        visible: bounds.bottom > viewport.top && bounds.top < viewport.bottom,
        optimized: usesLargeDocumentDerivedWorkBudget(view.state),
        retiredStable: oldDOM.innerHTML === retiredHtml,
        textUnchanged: editor.getText() === text,
        selectionUnchanged: JSON.stringify(view.state.selection.toJSON()) === JSON.stringify(originalSelection)
      };
    },
    destroy() {
      release();
      widget!.destroy(currentDOM);
      host.remove();
      editor.destroy();
      parent.remove();
      if (runtime && originalRender) runtime.render = originalRender;
      if (kind !== 'mermaid') setImageSrcResolver(value => value);
    }
  };
}
