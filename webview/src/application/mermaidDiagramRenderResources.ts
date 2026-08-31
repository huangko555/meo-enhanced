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
  | { readonly ok: false; readonly error: string; readonly unavailable?: false }
  | { readonly ok: false; readonly error: string; readonly unavailable: true };

export type MermaidDiagramSuccessfulRender = Extract<MermaidDiagramRenderResult, { readonly ok: true }>;

/**
 * One independently replaceable Widget presentation within an active render group.
 * After release, render resolves unavailable, getCached returns null, and replacePending throws.
 */
export type MermaidDiagramLeafRenderConsumer = {
  render(request: MermaidDiagramRenderRequest): Promise<MermaidDiagramRenderResult>;
  getCached(request: MermaidDiagramRenderRequest): MermaidDiagramRenderResult | null;
  /** Detaches only this presentation's pending waiter before presenting a replacement. */
  replacePending(): void;
  /** Detaches this presentation and releases its leaf identity. Repeated release is safe. */
  release(): void;
};

/**
 * Owns one Live Editor generation or one Preview request generation.
 * After end, createLeaf/replace throw and runExclusive rejects; repeated end remains safe.
 */
export type MermaidDiagramRenderGroupLease = {
  createLeaf(): MermaidDiagramLeafRenderConsumer;
  runExclusive<T>(operation: () => Promise<T>, priority?: MermaidRenderPriority): Promise<T>;
  /** Ends retained work for the replaced external Document while keeping the Live group active. */
  replaceForExternalDocument(): void;
  /** Ends the whole group without cancelling underlying renderer I/O. */
  end(): void;
};

/** Application-owned resource seam shared by Editor and Preview adapters. */
export type MermaidDiagramRenderResources = {
  /** Acquires a new group or throws after Pool disposal. */
  acquireGroup(): MermaidDiagramRenderGroupLease;
  getCached(request: MermaidDiagramRenderRequest): MermaidDiagramRenderResult | null;
  /** Latest valid SVG for the same source/config, regardless of theme generation. */
  getStale(request: MermaidDiagramRenderRequest): MermaidDiagramSuccessfulRender | null;
  refreshTheme(): void;
  subscribeThemeRefresh(listener: () => void): () => void;
  getHeight(key: string): number | null;
  rememberHeight(key: string, height: number): void;
  dispose(): void;
};
