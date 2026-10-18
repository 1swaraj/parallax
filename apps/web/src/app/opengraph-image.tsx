import { ImageResponse } from 'next/og';
import { APP_NAME, APP_TAGLINE } from '@/lib/brand';

export const alt = `${APP_NAME}: ${APP_TAGLINE}`;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Raw values: an image is rendered outside the page's CSS, so the MDS tokens are spelled out here.
const BG = '#FBFAF9';
const INK = '#26262B';
const MUTED = '#727285';
const PURPLE = '#6E54FF';

/** The default link preview: the mark, the name, what it is, on monad.xyz's dot grid. */
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
      <svg width="120" height="120" viewBox="0 0 24 24">
        <rect width="24" height="24" rx="4" fill={PURPLE} />
        <circle cx="10" cy="10" r="5" fill="none" stroke="#fff" strokeWidth="1.5" />
        <circle cx="14" cy="14" r="5" fill="none" stroke="#fff" strokeWidth="1.5" />
        <path d="M14.915 9.085A5 5 0 0 1 9.085 14.915A5 5 0 0 1 14.915 9.085Z" fill="#fff" />
      </svg>
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
