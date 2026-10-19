export type RawVscodeTheme = {
  name: string;
  type: 'light' | 'dark';
  colors: Record<string, string>;
  tokenColors: unknown[];
};

export type ShikiToken = {
  readonly offset: number;
  readonly content: string;
  readonly color?: string;
  readonly fontStyle?: number;
  readonly isStringComment?: boolean;
  readonly scopeNames?: readonly string[];
};
export type ShikiTokenLines = readonly (readonly ShikiToken[])[];
export type ShikiSurface = 'editor' | 'preview' | 'source';

export type ShikiWorkerRequest = {
  readonly id: number;
  readonly theme: RawVscodeTheme;
  readonly lang: string;
  readonly grammars: readonly unknown[];
  readonly code: string;
};
export type ShikiWorkerResponse = { readonly id: number; readonly tokens?: ShikiTokenLines; readonly error?: string };
