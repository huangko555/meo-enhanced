// Diagram surfaces follow the editor's gray/blue baseline. Only categorical
// charts use official Catppuccin Mocha accents, starting with blue.
// https://github.com/catppuccin/catppuccin#-palette
const chartColors = [
  '#89b4fa', '#94e2d5', '#a6e3a1', '#fab387', '#f9e2af', '#f38ba8',
  '#f5c2e7', '#cba6f7', '#74c7ec', '#b4befe', '#eba0ac', '#f2cdcd'
];

/** Shared diagram colors keep Live, Preview and exported documents consistent. */
export function getMermaidPalette(darkMode: boolean) {
  return darkMode ? {
    nodeBackground: '#2a3036',
    secondaryBackground: '#31363b',
    tertiaryBackground: '#3a4149',
    clusterBackground: '#24292e',
    foreground: '#e6edf3',
    border: '#676f7d',
    line: '#61afef',
    chartColors,
    chartTextColor: '#24292f'
  } : {
    nodeBackground: '#eef1f4',
    secondaryBackground: '#f1f3f5',
    tertiaryBackground: '#e6e8eb',
    clusterBackground: '#f6f8fa',
    foreground: '#24292f',
    border: '#8c959f',
    line: '#0550ae',
    chartColors,
    chartTextColor: '#24292f'
  };
}

// One color-role table is consumed by Live, Preview and the standalone export
// script. Keep it as data so export can embed it without serializing functions.
export const mermaidThemeColorRoles = {
  background: 'background',
  mainBkg: 'nodeBackground',
  secondBkg: 'secondaryBackground',
  secondaryColor: 'secondaryBackground',
  tertiaryColor: 'tertiaryBackground',
  primaryColor: 'nodeBackground',
  primaryTextColor: 'foreground',
  secondaryTextColor: 'foreground',
  tertiaryTextColor: 'foreground',
  primaryBorderColor: 'border',
  secondaryBorderColor: 'border',
  tertiaryBorderColor: 'border',
  nodeBorder: 'border',
  lineColor: 'line',
  signalColor: 'line',
  textColor: 'foreground',
  nodeTextColor: 'foreground',
  edgeLabelBackground: 'background',
  clusterBkg: 'clusterBackground',
  clusterBorder: 'border',
  titleColor: 'foreground',
  noteBkgColor: 'secondaryBackground',
  noteTextColor: 'foreground',
  noteBorderColor: 'border',
  doneTaskBkgColor: 'secondaryBackground',
  activeTaskBkgColor: 'tertiaryBackground',
  taskTextDarkColor: 'foreground',
  pieSectionTextColor: 'chartTextColor',
  pieLegendTextColor: 'foreground',
  pieTitleTextColor: 'foreground',
  pieStrokeColor: 'border',
  pieOuterStrokeColor: 'border'
} as const;

export function getMermaidColorVariables(palette: ReturnType<typeof getMermaidPalette> & { background: string }) {
  return Object.fromEntries(Object.entries(mermaidThemeColorRoles).map(([variable, role]) => [variable, palette[role]]));
}
