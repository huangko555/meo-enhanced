import { inlineCodeMarkers } from '../application/symbolInput';

export function safeClipboardUrl(value: string): string | null {
  const url = value.trim();
  return url && !/[\u0000-\u0020]/.test(url) && /^(https?:\/\/|mailto:)/i.test(url) ? url : null;
}

const escapeText = (value: string) => value.replace(/\s+/g, ' ').replaceAll('&', '&amp;').replace(/[\\`*_\[\]]/g, '\\$&').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const destination = (value: string) => value.trim().replace(/\s/g, '%20').replaceAll('\\', '%5C').replaceAll('(', '%28').replaceAll(')', '%29');
function allowedDestination(value: string): boolean {
  value = value.trim();
  return !!value && !/[\u0000-\u001f]/.test(value) && !/^(?:javascript|data|vbscript|file):/i.test(value)
    && (!/^[a-z][a-z\d+.-]*:/i.test(value) || /^(?:https?|mailto):/i.test(value));
}

/** Converts inert clipboard HTML to the subset supported by the editor. Never inserts HTML DOM. */
export function clipboardHtmlToMarkdown(html: string): string | null {
  if (!html || html.length > 5_000_000) return null;
  const document = new DOMParser().parseFromString(html, 'text/html');
  const children = (node: Node): string => Array.from(node.childNodes, convert).join('');
  const convert = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent ?? '');
    if (!(node instanceof Element)) return '';
    const tag = node.tagName;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'IFRAME', 'OBJECT', 'SVG'].includes(tag)) return '';
    if (tag === 'PRE') {
      const value = (node.textContent ?? '').replace(/\r\n?/g, '\n');
      let length = 3; for (const match of value.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
      const fence = '`'.repeat(length);
      return '\n\n' + fence + '\n' + value.replace(/\n$/, '') + '\n' + fence + '\n\n';
    }
    if (tag === 'CODE') {
      const value = node.textContent ?? '';
      const { open, close } = inlineCodeMarkers(value);
      return open + value + close;
    }
    if (tag === 'BR') return '<br>\n';
    if (tag === 'HR') return '\n\n---\n\n';
    const content = children(node);
    const styled = (marker: string) => content.trim() ? content.replace(/^(\s*)([\s\S]*?)(\s*)$/, (_match, before: string, text: string, after: string) => before + marker + text + marker + after) : content;
    if (['B', 'STRONG'].includes(tag)) return styled('**');
    if (['I', 'EM'].includes(tag)) return styled('*');
    if (['S', 'STRIKE', 'DEL'].includes(tag)) return styled('~~');
    if (tag === 'MARK') return styled('==');
    if (tag === 'U') return '<u>' + content + '</u>';
    if (tag === 'KBD') return '<kbd>' + content + '</kbd>';
    if (tag === 'A') {
      const href = node.getAttribute('href') ?? '';
      return allowedDestination(href) ? '[' + content + '](' + destination(href) + ')' : content;
    }
    if (tag === 'IMG') {
      const src = node.getAttribute('src') ?? '';
      return allowedDestination(src) ? '![' + escapeText(node.getAttribute('alt') ?? '') + '](' + destination(src) + ')' : '';
    }
    if (/^H[1-6]$/.test(tag)) return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + content.trim() + '\n\n';
    if (tag === 'BLOCKQUOTE') return '\n\n' + content.trim().split('\n').map(line => '> ' + line).join('\n') + '\n\n';
    if (tag === 'UL' || tag === 'OL') {
      const start = tag === 'OL' ? Number(node.getAttribute('start') ?? 1) : 1;
      return '\n\n' + Array.from(node.children).filter(child => child.tagName === 'LI').map((item, index) => {
        const marker = tag === 'OL' ? `${Number.isFinite(start) ? start + index : index + 1}. ` : '- ';
        return marker + children(item).trim().split('\n').map((line, lineIndex) => lineIndex ? ' '.repeat(marker.length) + line : line).join('\n');
      }).join('\n') + '\n\n';
    }
    if (tag === 'TD' || tag === 'TH') return content.trim() + '\t';
    if (['P', 'DIV', 'SECTION', 'ARTICLE', 'TR', 'TABLE'].includes(tag)) return '\n\n' + content.trim() + '\n\n';
    return content;
  };
  return children(document.body).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() || null;
}
