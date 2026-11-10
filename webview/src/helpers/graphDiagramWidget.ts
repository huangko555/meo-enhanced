import { WidgetType, type EditorView } from '@codemirror/view';
import type { DocumentBlocksPort } from '../editor/documentBlocks';
import { MermaidDiagramWidget } from './mermaidDiagram';
import type { DocumentBlockCamera } from '../../../src/documentViews';

const cameras = new WeakMap<object, { language: string; camera: DocumentBlockCamera }>();

export type GraphRenderer = { language: string; port: DocumentBlocksPort };
export type GraphDiagramWidget = WidgetType & Pick<MermaidDiagramWidget,
  'toDOM' | 'destroy' | 'updateSource' | 'eq' | 'estimatedHeight' | 'measuredHeight' | 'themeSignature' | 'measuredContentWidth' | 'startLine' | 'endLine' | 'updateCostMs'>;

/** Only the canvas differs. The caller owns the common code-block shell and editor state. */
export function createGraphDiagramWidget(source: string, start: number, end: number,
  options: ConstructorParameters<typeof MermaidDiagramWidget>[3], renderer?: GraphRenderer): GraphDiagramWidget {
  if (!renderer) return new MermaidDiagramWidget(source, start, end, options);
  const token = options.viewportState;
  let session = token && cameras.get(token);
  if (token && (!session || session.language !== renderer.language)) {
    session = { language: renderer.language, camera: {} }; cameras.set(token, session);
  }
  return new ContributedDiagramWidget(source, start, end, renderer, session?.camera);
}

class ContributedDiagramWidget extends WidgetType {
  updateCostMs(_source: string): number { return 0; }
  measuredHeight = 360;
  measuredContentWidth = 0;
  themeSignature = '';
  private mounted?: ReturnType<DocumentBlocksPort['mount']>;
  constructor(private source: string, public startLine: number, public endLine: number, private renderer: GraphRenderer, private camera?: DocumentBlockCamera) { super(); }
  get estimatedHeight() { return this.measuredHeight; }
  eq(other: WidgetType) {
    return other instanceof ContributedDiagramWidget && other.source === this.source
      && other.startLine === this.startLine && other.endLine === this.endLine
      && other.renderer.port === this.renderer.port && other.renderer.language === this.renderer.language && other.camera === this.camera;
  }
  toDOM(_view?: EditorView) {
    const root = document.createElement('div');
    root.className = 'meo-mermaid-block meo-graph-block';
    this.mounted = this.renderer.port.mount(root, { language: this.renderer.language, text: this.source, line: this.startLine, camera: this.camera });
    return root;
  }
  updateSource(source: string, startLine: number, endLine: number) {
    this.source = source; this.startLine = startLine; this.endLine = endLine;
    this.mounted?.update({ language: this.renderer.language, text: source, line: startLine, camera: this.camera });
  }
  destroy() { this.mounted?.dispose(); this.mounted = undefined; }
}
