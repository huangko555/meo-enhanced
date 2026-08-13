export type ThemeFontsDto = {
  readonly liveFont: string;
  readonly sourceFont: string;
  readonly liveFontWeight: string;
  readonly sourceFontWeight: string;
  readonly liveFontSize: number | null;
  readonly sourceFontSize: number | null;
  readonly h1FontSize: number | null;
  readonly h2FontSize: number | null;
  readonly h3FontSize: number | null;
  readonly h4FontSize: number | null;
  readonly h5FontSize: number | null;
  readonly h6FontSize: number | null;
  readonly h1FontWeight: string;
  readonly h2FontWeight: string;
  readonly h3FontWeight: string;
  readonly h4FontWeight: string;
  readonly h5FontWeight: string;
  readonly h6FontWeight: string;
  readonly liveLineHeight: number;
  readonly sourceLineHeight: number;
};

export type ThemeSettingsDto = {
  readonly id: string;
  readonly name: string;
  readonly backgroundColor: string;
  readonly colors: Record<string, string>;
  readonly semanticColors: Record<string, string>;
  readonly syntaxTokens: Record<string, string>;
  readonly fonts: ThemeFontsDto;
};

export type CodeThemeDto = {
  readonly name: string;
  readonly type: 'light' | 'dark';
  readonly colors: Record<string, string>;
  readonly tokenColors: unknown[];
};

export type HostConfigurationEvent =
  | { readonly type: 'toggleMode' }
  | { readonly type: 'themeChanged'; readonly theme: ThemeSettingsDto; readonly codeTheme?: CodeThemeDto | null }
  | { readonly type: 'shikiCodeBlocksChanged'; readonly enabled: boolean; readonly codeTheme?: CodeThemeDto | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function decodeThemeFonts(value: unknown): ThemeFontsDto | null {
  if (!isRecord(value)) return null;
  const stringKeys = [
    'liveFont', 'sourceFont', 'liveFontWeight', 'sourceFontWeight',
    'h1FontWeight', 'h2FontWeight', 'h3FontWeight', 'h4FontWeight', 'h5FontWeight', 'h6FontWeight'
  ] as const;
  const nullableNumberKeys = [
    'liveFontSize', 'sourceFontSize', 'h1FontSize', 'h2FontSize', 'h3FontSize',
    'h4FontSize', 'h5FontSize', 'h6FontSize'
  ] as const;
  if (stringKeys.some((key) => typeof value[key] !== 'string')
    || nullableNumberKeys.some((key) => !isNullableFiniteNumber(value[key]))
    || !isFiniteNumber(value.liveLineHeight)
    || !isFiniteNumber(value.sourceLineHeight)) return null;
  return value as ThemeFontsDto;
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

export function decodeThemeSettings(value: unknown): ThemeSettingsDto | null {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.backgroundColor === 'string'
    && isStringRecord(value.colors)
    && isStringRecord(value.semanticColors)
    && isStringRecord(value.syntaxTokens)
    && decodeThemeFonts(value.fonts) !== null ? value as ThemeSettingsDto : null;
}

export function decodeCodeTheme(value: unknown): CodeThemeDto | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return isRecord(value)
    && typeof value.name === 'string'
    && (value.type === 'light' || value.type === 'dark')
    && isRecord(value.colors)
    && Object.values(value.colors).every((color) => typeof color === 'string')
    && Array.isArray(value.tokenColors)
    && value.tokenColors.every(isJsonValue) ? value as CodeThemeDto : false;
}

export function decodeHostConfigurationEvent(value: unknown): HostConfigurationEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'toggleMode':
      return { type: 'toggleMode' };
    case 'themeChanged':
      return decodeThemeSettings(value.theme) !== null && decodeCodeTheme(value.codeTheme) !== false
        ? value as HostConfigurationEvent : null;
    case 'shikiCodeBlocksChanged':
      return typeof value.enabled === 'boolean' && decodeCodeTheme(value.codeTheme) !== false
        ? value as HostConfigurationEvent : null;
    default:
      return null;
  }
}
