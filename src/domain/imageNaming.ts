import type { ImageNamingMode } from '../foundation/imageStorage';

/** Naming is pure; the Host still claims each candidate with an exclusive create. */
export function* imageFileNameCandidates(context: {
  readonly naming: ImageNamingMode;
  readonly documentName: string;
  readonly extension: string;
  readonly timestamp: number;
  readonly existingNames: readonly string[];
}): Generator<string> {
  const extension = context.extension.toLowerCase();
  if (!/^[a-z0-9][a-z0-9.+-]{0,31}$/.test(extension)) throw new Error('Invalid image file extension.');
  const sequential = context.naming === 'documentSequence' || context.naming === 'imageSequence';
  const date = new Date(context.timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  const documentName = context.documentName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '') || 'image';
  const stem = context.naming === 'documentSequence' ? documentName
    : context.naming === 'imageSequence' ? 'image'
    : context.naming === 'timestamp' ? String(context.timestamp)
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  let sequence = 0;
  if (sequential) {
    const prefix = stem.toLowerCase() + '-';
    for (const name of context.existingNames) {
      if (!name.toLowerCase().startsWith(prefix)) continue;
      const match = /^(\d+)\.[a-z0-9][a-z0-9.+-]{0,31}$/i.exec(name.slice(prefix.length));
      if (match && Number.isSafeInteger(Number(match[1]))) sequence = Math.max(sequence, Number(match[1]));
    }
    sequence += 1;
  }
  while (Number.isSafeInteger(sequence)) {
    yield `${stem}${sequence === 0 ? '' : '-' + sequence}.${extension}`;
    sequence += 1;
  }
  throw new Error('Image sequence limit reached.');
}
