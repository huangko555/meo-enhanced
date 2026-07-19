import { collectColorRangesFromText } from '../webview/src/helpers/colorSwatches';

function sources(text: string): string[] {
  return collectColorRangesFromText(text).map((range) => text.slice(range.from, range.to));
}

const supported = 'Hex #abc #abcd #aabbcc #aabbccdd rgb(10, 20, 30) rgba(10 20 30 / 50%) hsl(120deg 50% 40%) hsla(0, 100%, 50%, .4)';
const expected = ['#abc', '#abcd', '#aabbcc', '#aabbccdd', 'rgb(10, 20, 30)', 'rgba(10 20 30 / 50%)', 'hsl(120deg 50% 40%)', 'hsla(0, 100%, 50%, .4)'];
if (JSON.stringify(sources(supported)) !== JSON.stringify(expected)) {
  throw new Error(`Supported colors were not collected: ${JSON.stringify(sources(supported))}`);
}

const excludedByBoundary = 'heading#abc color-#fff #12345 #1234567 ##abc';
if (sources(excludedByBoundary).length !== 0) {
  throw new Error(`Invalid or embedded colors were collected: ${JSON.stringify(sources(excludedByBoundary))}`);
}

const invalidFunctions = 'rgb(10, 20) hsl(120 50 40) rgba(foo) rgba(10, 20, 30) rgb(10 20 30 /)';
if (sources(invalidFunctions).length !== 0) {
  throw new Error(`Invalid color functions were collected: ${JSON.stringify(sources(invalidFunctions))}`);
}

console.log('color swatch parser checks passed');
