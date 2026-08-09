export type MermaidRenderPriority = 'normal' | 'high';

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

/** Application-owned resource seam shared by Editor and Preview adapters. */
export type MermaidDiagramRenderResources = {
  render(request: MermaidDiagramRenderRequest): Promise<MermaidDiagramRenderResult>;
  getCached(request: MermaidDiagramRenderRequest): MermaidDiagramRenderResult | null;
  runExclusive<T>(operation: () => Promise<T>, priority?: MermaidRenderPriority): Promise<T>;
  refreshTheme(): void;
  subscribeThemeRefresh(listener: () => void): () => void;
  getHeight(key: string): number | null;
  rememberHeight(key: string, height: number): void;
  dispose(): void;
};
