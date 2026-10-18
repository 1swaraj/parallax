import { ImageResponse } from 'next/og';
import fs from 'node:fs';
import path from 'node:path';
import { APP_NAME, APP_TAGLINE } from '@/lib/brand';

export const alt = `${APP_NAME}: ${APP_TAGLINE}`;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Raw values: an image is rendered outside the page's CSS, so the tokens are spelled out here.
const BG = '#FBFAF9';
const INK = '#26262B';
const MUTED = '#727285';

const ICON = `data:image/svg+xml;base64,${fs.readFileSync(path.join(process.cwd(), 'src/app/icon.svg')).toString('base64')}`;

/** The default link preview: the mark, the name, what it is, on the dot grid. */
export default function Image() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 80,
        background: BG,
        backgroundImage: 'radial-gradient(circle, rgba(10,10,10,0.08) 1.5px, transparent 0)',
        backgroundSize: '24px 24px',
        color: INK,
        fontFamily: 'sans-serif',
      }}
    >
      {/* The square mark (components/brand.tsx, app/icon.svg), as an image: it uses masks. */}
      <img width={120} height={120} src={ICON} alt="" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ fontSize: 112, fontWeight: 600, letterSpacing: -3 }}>{APP_NAME}</div>
        <div style={{ fontSize: 44, color: MUTED }}>{APP_TAGLINE}</div>
      </div>
      <div style={{ fontSize: 24, letterSpacing: 3, color: MUTED, textTransform: 'uppercase' }}>
        Built on Lens · Running on Monad
      </div>
    </div>,
    size
  );
}
