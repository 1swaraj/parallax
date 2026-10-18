'use client';

import { useId } from 'react';
import { APP_NAME } from '@/lib/brand';

/**
 * The logo: geometric capitals in Monad purple, each with a grey outline offset up and to the right, the "parallax".
 * Letters are stroked centerlines on a 60-unit cap height, so every size draws the same shapes. Strokes run past the
 * baseline and cap line, and a clip cuts them flat there.
 */
const STROKE = 12;
const CAP = 60;
const GAP = 8;
/** Where the outline layer sits, relative to the letters: up and to the right. */
const SHIFT = { x: 5, y: -5 };
const OUTLINE = 1.75;

type Glyph = { d: string; width: number };
const GLYPHS: Record<'P' | 'A' | 'R' | 'L' | 'X', Glyph> = {
  P: { d: 'M6 66V6H26A14 14 0 0 1 26 34H6', width: 46 },
  A: { d: 'M4.56 66L19 6H27L41.44 66M11 40H35', width: 46 },
  R: { d: 'M6 66V6H26A14 14 0 0 1 26 34H6M24 34L46.15 66', width: 48 },
  L: { d: 'M6 -6V54H40', width: 40 },
  X: { d: 'M0.2 -6L45.8 66M45.8 -6L0.2 66', width: 46 },
};

type Letter = { glyph: Glyph; x: number };
const WORD = [...'PARALLAX'].reduce<Letter[]>((letters, char) => {
  const previous = letters[letters.length - 1];
  const x = previous ? previous.x + previous.glyph.width + GAP : 0;
  letters.push({ glyph: GLYPHS[char as keyof typeof GLYPHS], x });
  return letters;
}, []);
const WORD_WIDTH = WORD[WORD.length - 1]!.x + WORD[WORD.length - 1]!.glyph.width;

const PURPLE = 'var(--brand-purple)';
const GREY = 'var(--brand-grey)';

/**
 * The letters, and behind them their outline, shifted. The outline is a mask (a wide stroke minus a narrower one), so
 * it's hollow over any background.
 */
function Letters({ letters, id }: { letters: Letter[]; id: string }) {
  const paths = (stroke: string, width: number) =>
    letters.map(({ glyph, x }) => (
      <path
        key={x}
        d={glyph.d}
        transform={`translate(${x} 0)`}
        stroke={stroke}
        strokeWidth={width}
      />
    ));
  const bounds = { x: -20, y: -20, width: WORD_WIDTH + 40, height: CAP + 40 };
  return (
    <g fill="none" strokeLinejoin="miter" strokeLinecap="butt">
      <clipPath id={`${id}-cap`}>
        <rect x={-STROKE} y={0} width={WORD_WIDTH + 2 * STROKE} height={CAP} />
      </clipPath>
      <clipPath id={`${id}-cap-shifted`}>
        <rect x={-STROKE} y={-OUTLINE} width={WORD_WIDTH + 2 * STROKE} height={CAP + 2 * OUTLINE} />
      </clipPath>
      <mask id={`${id}-outline`} maskUnits="userSpaceOnUse" {...bounds}>
        <g clipPath={`url(#${id}-cap-shifted)`}>{paths('#fff', STROKE + 2 * OUTLINE)}</g>
        <g clipPath={`url(#${id}-cap)`}>{paths('#000', STROKE)}</g>
      </mask>
      <g transform={`translate(${SHIFT.x} ${SHIFT.y})`} mask={`url(#${id}-outline)`}>
        <rect {...bounds} fill={GREY} />
      </g>
      <g clipPath={`url(#${id}-cap)`}>{paths(PURPLE, STROKE)}</g>
    </g>
  );
}

/** The name, in the logo's letters: `height` is the cap height in pixels, or size it with `className`. */
export function Wordmark({
  height,
  className,
  title = APP_NAME,
}: {
  height?: number;
  className?: string;
  title?: string;
}) {
  const id = useId().replace(/:/g, '');
  // Room for the outline: shifted up and right, and past the X's slanted corners.
  const [x, y, width, h] = [-2, -8, WORD_WIDTH + 18, CAP + 10];
  return (
    <svg
      viewBox={`${x} ${y} ${width} ${h}`}
      height={height ? (height * h) / CAP : undefined}
      className={className}
      role="img"
      aria-label={title}
    >
      <Letters letters={WORD} id={id} />
    </svg>
  );
}

/** The square mark: the P on Monad's near-black, for favicons and tight spaces. */
export function Logo({ size = 28, title }: { size?: number; title?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className="shrink-0"
    >
      <rect width="64" height="64" rx="14" fill="#0e091c" />
      <g
        transform="translate(16 12) scale(0.68)"
        style={{ '--brand-grey': '#aaaabf' } as React.CSSProperties}
      >
        <Letters letters={[{ glyph: GLYPHS.P, x: 0 }]} id={id} />
      </g>
    </svg>
  );
}
