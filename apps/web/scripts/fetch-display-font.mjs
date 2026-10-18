// The titles' font is licensed separately, so it isn't in this repo. A build with DISPLAY_FONT_URL set
// downloads it into public/fonts; without it, titles fall back to Inter.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

const target = new URL('../public/fonts/britti-sans-variable.woff2', import.meta.url);
const url = process.env.DISPLAY_FONT_URL;

if (existsSync(target)) {
  process.exit(0);
}
if (!url) {
  console.log('DISPLAY_FONT_URL is not set: titles will use Inter.');
  process.exit(0);
}
const response = await fetch(url);
if (!response.ok) {
  throw new Error(`Couldn't download the display font (${response.status} from DISPLAY_FONT_URL)`);
}
await mkdir(new URL('.', target), { recursive: true });
await writeFile(target, Buffer.from(await response.arrayBuffer()));
console.log('Downloaded the display font.');
