/**
 * tools/sync-fallback.mjs
 * ------------------------
 * Role:
 *   Copy data.json into the inline <script id="fallback-data"> block inside
 *   index.html. The browser needs that snapshot when the page is opened via
 *   file://, because fetch() is blocked there.
 *
 * Usage:
 *   node tools/sync-fallback.mjs          # write the snapshot
 *   node tools/sync-fallback.mjs --check  # fail if the snapshot is stale
 *
 * The GitHub Actions workflow runs this after the scraper so the snapshot never
 * drifts far behind data.json.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML_PATH = path.join(ROOT, 'index.html');
const DATA_PATH = path.join(ROOT, 'data.json');
const START = '<!-- FALLBACK_DATA_START -->';
const END = '<!-- FALLBACK_DATA_END -->';

const [html, raw] = await Promise.all([
  readFile(HTML_PATH, 'utf8'),
  readFile(DATA_PATH, 'utf8')
]);

const data = JSON.parse(raw.replace(/^\uFEFF/, ''));
const pretty = JSON.stringify(data, null, 2).replace(/<\/script/gi, '<\\/script');
const block = START + '\n<script type="application/json" id="fallback-data">\n' + pretty + '\n</script>\n' + END;

const startIndex = html.indexOf(START);
const endIndex = html.indexOf(END);
if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
  console.error('Could not find the FALLBACK_DATA markers in index.html.');
  process.exit(1);
}

const next = html.slice(0, startIndex) + block + html.slice(endIndex + END.length);
const checkOnly = process.argv.includes('--check');

if (checkOnly) {
  if (next === html) {
    console.log('index.html fallback snapshot is in sync with data.json.');
  } else {
    console.error('index.html fallback snapshot is OUT OF SYNC. Run: node tools/sync-fallback.mjs');
    process.exit(1);
  }
} else if (next === html) {
  console.log('Fallback snapshot already up to date; nothing written.');
} else {
  await writeFile(HTML_PATH, next, 'utf8');
  console.log('Updated the fallback snapshot in index.html.');
}