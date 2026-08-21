export type MermaidRenderPriority = 'normal' | 'high';

/** Expected resource admission/disposal failure that callers may recover from silently. */
export class MermaidDiagramResourceUnavailableError extends Error {}

export type MermaidDiagramRenderRequest = {
  readonly rawSource: string;
  readonly normalizedSource: string;
  readonly themeKey: string;
  readonly configKey: string;
  readonly priority?: MermaidRenderPriority;
};

export type MermaidDiagramRenderResult =
  | { readonly ok: true; readonly svg: string }
  | { readonly ok: false; readonly error: string };

/** One independently replaceable Live presentation or Preview render consumer. */
export type MermaidDiagramRenderConsumer = {
  /** Creates another consumer in the same logical Live/Preview lifecycle group. */
  fork(): MermaidDiagramRenderConsumer;
  render(request: MermaidDiagramRenderRequest): Promise<MermaidDiagramRenderResult>;
  getCached(request: MermaidDiagramRenderRequest): MermaidDiagramRenderResult | null;
  runExclusive<T>(operation: () => Promise<T>, priority?: MermaidRenderPriority): Promise<T>;
  /** Invalidates this consumer's pending work without affecting other consumers. */
  invalidate(): void;
  release(): void;
};

/** Application-owned resource seam shared by Editor and Preview adapters. */
export type MermaidDiagramRenderResources = {
  acquire(): MermaidDiagramRenderConsumer;
  getCached(request: MermaidDiagramRenderRequest): MermaidDiagramRenderResult | null;
  refreshTheme(): void;
  subscribeThemeRefresh(listener: () => void): () => void;
  getHeight(key: string): number | null;
  rememberHeight(key: string, height: number): void;
  dispose(): void;
};
