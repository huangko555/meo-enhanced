export type CodeThemeDto = {
  readonly name: string;
  readonly type: 'light' | 'dark';
  readonly colors: Record<string, string>;
  readonly tokenColors: unknown[];
};

export type HostConfigurationEvent =
  | { readonly type: 'toggleMode' }
  | { readonly type: 'tableStickyHeaderChanged'; readonly enabled: boolean }
  | { readonly type: 'restoreReadingPositionOnOpenChanged'; readonly enabled: boolean }
  | {
      readonly type: 'vscodeCodeThemeChanged';
      readonly appearance: 'light' | 'dark';
      readonly vscodeTheme: CodeThemeDto | null;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
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
    case 'tableStickyHeaderChanged':
    case 'restoreReadingPositionOnOpenChanged':
      return typeof value.enabled === 'boolean' ? value as HostConfigurationEvent : null;
    case 'vscodeCodeThemeChanged':
      return (value.appearance === 'light' || value.appearance === 'dark')
        && decodeCodeTheme(value.vscodeTheme) !== false && decodeCodeTheme(value.vscodeTheme) !== undefined
        ? value as HostConfigurationEvent : null;
    default:
      return null;
  }
}
