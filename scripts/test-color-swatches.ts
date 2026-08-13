import { collectHexColorRangesFromText } from '../src/shared/hexColorSwatches';

function sources(text: string): string[] {
  return collectHexColorRangesFromText(text).map((range) => text.slice(range.from, range.to));
}

const supported = 'Hex #abc #abcd #aabbcc #aabbccdd';
const expected = ['#abc', '#abcd', '#aabbcc', '#aabbccdd'];
if (JSON.stringify(sources(supported)) !== JSON.stringify(expected)) {
  throw new Error(`Supported colors were not collected: ${JSON.stringify(sources(supported))}`);
}

const excludedByBoundary = [
  'heading#abc',
  'color-#fff',
  '#12345',
  '#1234567',
  '##abc',
  'https://example.com/#abc',
  '[section](#abc)',
  '#abc/tag',
  'url(#abc)'
].join(' ');
if (sources(excludedByBoundary).length !== 0) {
  throw new Error(`Invalid or embedded colors were collected: ${JSON.stringify(sources(excludedByBoundary))}`);
}

const plainCssText = [
  'rgb(10, 20, 30)',
  'rgba(10 20 30 / 50%)',
  'hsl(120deg 50% 40%)',
  'hsla(0, 100%, 50%, .4)',
  'red',
  'rebeccapurple',
  'linear-gradient(#fff, red)',
  'radial-gradient(circle, #0008, transparent)'
].join(' ');
if (sources(plainCssText).length !== 0) {
  throw new Error(`Non-HEX CSS text must remain undecorated: ${JSON.stringify(sources(plainCssText))}`);
}

console.log('color swatch parser checks passed');
