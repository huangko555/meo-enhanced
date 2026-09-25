const svgNamespace = 'http://www.w3.org/2000/svg';
const page = (fill: string): string => `<path fill="${fill}" d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/>`;

const formatIconSvg = {
  html: `<svg xmlns="${svgNamespace}" viewBox="0 0 24 24">
    <defs><mask id="markup-cutout" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
      <rect width="24" height="24" fill="#fff"/>
      <path d="M3.5 4L1.9 5.6c-.2.2-.2.5 0 .7L3.5 8m5-4l1.6 1.6c.2.2.2.5 0 .7L8.5 8M7 2.5l-2 7" transform="translate(4.5 8.5) scale(1.25)" fill="none" stroke="#000" stroke-linecap="round"/>
    </mask></defs>
    ${page('#ffab91')}
    <path fill="#e65100" mask="url(#markup-cutout)" d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m7 1.5V9h5.5z"/>
  </svg>`,
  pdf: `<svg xmlns="${svgNamespace}" viewBox="0 0 24 24">
    ${page('#ffb3b1')}
    <path fill="#ef5350" d="M13 9h5.5L13 3.5zM6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m4.93 10.44c.41.9.93 1.64 1.53 2.15l.41.32c-.87.16-2.07.44-3.34.93l-.11.04l.5-1.04c.45-.87.78-1.66 1.01-2.4m6.48 3.81c.18-.18.27-.41.28-.66c.03-.2-.02-.39-.12-.55c-.29-.47-1.04-.69-2.28-.69l-1.29.07l-.87-.58c-.63-.52-1.2-1.43-1.6-2.56l.04-.14c.33-1.33.64-2.94-.02-3.6a.85.85 0 0 0-.61-.24h-.24c-.37 0-.7.39-.79.77c-.37 1.33-.15 2.06.22 3.27v.01c-.25.88-.57 1.9-1.08 2.93l-.96 1.8l-.89.49c-1.2.75-1.77 1.59-1.88 2.12c-.04.19-.02.36.05.54l.03.05l.48.31l.44.11c.81 0 1.73-.95 2.97-3.07l.18-.07c1.03-.33 2.31-.56 4.03-.75c1.03.51 2.24.74 3 .74c.44 0 .74-.11.91-.3m-.41-.71l.09.11c-.01.1-.04.11-.09.13h-.04l-.19.02c-.46 0-1.17-.19-1.9-.51c.09-.1.13-.1.23-.1c1.4 0 1.8.25 1.9.35M7.83 17c-.65 1.19-1.24 1.85-1.69 2c.05-.38.5-1.04 1.21-1.69zm3.02-6.91c-.23-.9-.24-1.63-.07-2.05l.07-.12l.15.05c.17.24.19.56.09 1.1l-.03.16l-.16.82z"/>
  </svg>`,
  docx: `<svg xmlns="${svgNamespace}" viewBox="0 0 24 24">
    ${page('#90caf9')}
    <path fill="#01579b" d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m7 1.5V9h5.5zM7 13l1.5 7h2l1.5-3l1.5 3h2l1.5-7h1v-2h-4v2h1l-.9 4.2L13 15h-2l-1.1 2.2L9 13h1v-2H6v2z"/>
  </svg>`
} as const;

export type ExportIconFormat = keyof typeof formatIconSvg;

export const createExportFormatIcon = (format: ExportIconFormat): HTMLImageElement => {
  const icon = document.createElement('img');
  icon.width = 16;
  icon.height = 16;
  icon.alt = '';
  icon.setAttribute('aria-hidden', 'true');
  icon.src = `data:image/svg+xml,${encodeURIComponent(formatIconSvg[format])}`;
  return icon;
};

export const createExportButtonIcon = (): SVGSVGElement => {
  const icon = document.createElementNS(svgNamespace, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('width', '16');
  icon.setAttribute('height', '16');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svgNamespace, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', 'M14 17a1 1 0 1 0 0 2zm4.707-2.536a1 1 0 1 0-1.414 1.415l.707-.707zM20.828 18l.707.707a1 1 0 0 0 0-1.414zm-3.535 2.121a1 1 0 0 0 1.414 1.415L18 20.828zm-3-16.828L13.586 4zM19 8.414h-1V9h2v-.586zM19 9h-1v3h2V9zM6 3v1h7V2H6zm7 0v1h.586V2H13zm1.293.293L13.586 4L18 8.414l.707-.707l.707-.707L15 2.586zM13 3h-1v5.5h2V3zm.5 6v1H19V8h-5.5zM5 20h1V4H4v16zm9-2v1h6.328v-2H14zm4-2.828l-.707.707l2.828 2.828l.707-.707l.707-.707l-2.828-2.828zM20.828 18l-.707-.707l-2.828 2.828l.707.707l.707.707l2.828-2.828zM6 21v1h6v-2H6zm-1-1H4a2 2 0 0 0 2 2v-2zm8-11.5h-1a1.5 1.5 0 0 0 1.5 1.5V8a.5.5 0 0 1 .5.5zM6 3V2a2 2 0 0 0-2 2h2zm7.586 0v1l.707-.707l.707-.707A2 2 0 0 0 13.586 2zM19 8.414h1A2 2 0 0 0 19.414 7l-.707.707l-.707.707z');
  icon.appendChild(path);
  return icon;
};
