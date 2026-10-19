'use client';

import { useId } from 'react';
import { useInstanceConfig, useBrand } from '@/lib/runtime-config';

/**
 * The logo: a mark (two halves of a rounded tile, split by a gap, with a lens of concentric circles over the gap, in a
 * lavender-to-violet gradient) and the name in solid geometric capitals. Letters are stroked centerlines on a 60-unit
 * cap height, so every size draws the same shapes. Strokes run past the baseline and cap line, and a clip cuts them
 * flat there.
 */
const STROKE = 13;
const CAP = 60;
const GAP = 9.5;
type Glyph = { d: string; width: number };
const GLYPHS: Record<'P' | 'A' | 'R' | 'L' | 'X', Glyph> = {
  P: { d: 'M6.5 66V6.5H29.3A14.7 14.7 0 0 1 29.3 35.9H6.5', width: 50.5 },
  A: { d: 'M4.32 66L26.6 6.5H33.4L55.68 66M13 43H47', width: 60 },
  R: { d: 'M6.5 66V6.5H29.8A14.7 14.7 0 0 1 29.8 35.9H6.5M30.7 35.9L48.1 66', width: 52 },
  L: { d: 'M6.5 -6V53.5H48.6', width: 48.6 },
  X: { d: 'M4.55 -6L52.55 66M52.55 -6L4.55 66', width: 57.1 },
};
/** Pairs set closer than GAP: the A's foot tucks under the P's bowl. */
const KERNING: Record<string, number> = { PA: -9.5 };

type Letter = { glyph: Glyph; x: number };
const WORD = [...'PARALLAX'].reduce<Letter[]>((letters, char, i, chars) => {
  const previous = letters[letters.length - 1];
  const kern = KERNING[`${chars[i - 1]}${char}`] ?? 0;
  const x = previous ? previous.x + previous.glyph.width + GAP + kern : 0;
  letters.push({ glyph: GLYPHS[char as keyof typeof GLYPHS], x });
  return letters;
}, []);
const WORD_WIDTH = WORD[WORD.length - 1]!.x + WORD[WORD.length - 1]!.glyph.width;

/** The app's purple (globals.css), for the letters; the mark's gradient runs from a tint of it to its hover shade. */
const PURPLE = 'var(--accent-primary)';

/** The letters, solid. */
function Letters({ letters, id }: { letters: Letter[]; id: string }) {
  return (
    <g fill="none" strokeLinejoin="miter" strokeLinecap="butt">
      <clipPath id={`${id}-cap`}>
        <rect x={-STROKE} y={0} width={WORD_WIDTH + 2 * STROKE} height={CAP} />
      </clipPath>
      <g clipPath={`url(#${id}-cap)`}>
        {letters.map(({ glyph, x }) => (
          <path
            key={x}
            d={glyph.d}
            transform={`translate(${x} 0)`}
            stroke={PURPLE}
            strokeWidth={STROKE}
          />
        ))}
      </g>
    </g>
  );
}

/**
 * The mark, 72 × 76 units: the tile's halves, then the lens's three circles, each a little more opaque. They're
 * translucent over a white base, so the mark looks the same on any background.
 */
const MARK = { width: 72, height: 76 };

function MarkShapes({ id }: { id: string }) {
  const gradient = `url(#${id}-gradient)`;
  const [cx, cy] = [MARK.width / 2, MARK.height / 2];
  return (
    <>
      <defs>
        <linearGradient id={`${id}-gradient`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c5bbff" />
          <stop offset="1" stopColor="#5740d6" />
        </linearGradient>
        <mask
          id={`${id}-split`}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width={MARK.width}
          height={MARK.height}
        >
          <rect width={MARK.width} height={MARK.height} fill="#fff" />
          <rect x="22.25" width="27.5" height={MARK.height} fill="#000" />
        </mask>
      </defs>
      <g fill="#fff">
        <rect width={MARK.width} height={MARK.height} rx="22.25" mask={`url(#${id}-split)`} />
        <circle cx={cx} cy={cy} r="24.5" />
      </g>
      <rect
        width={MARK.width}
        height={MARK.height}
        rx="22.25"
        fill={gradient}
        opacity="0.85"
        mask={`url(#${id}-split)`}
      />
      <circle cx={cx} cy={cy} r="24.5" fill={gradient} opacity="0.55" />
      <circle cx={cx} cy={cy} r="18" fill={gradient} opacity="0.7" />
      <circle cx={cx} cy={cy} r="9.25" fill={gradient} opacity="0.9" />
    </>
  );
}

/** The mark alone, for favicons, tight spaces and loading: `size` is its height in pixels. */
export function Logo({ size = 28, title }: { size?: number; title?: string }) {
  const config = useInstanceConfig();
  const id = useId().replace(/:/g, '');
  if (config.iconUrl)
    return <img src={config.iconUrl} width={size} height={size} alt={title || ''} />;
  return (
    <svg
      viewBox={`0 0 ${MARK.width} ${MARK.height}`}
      width={(size * MARK.width) / MARK.height}
      height={size}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className="shrink-0"
    >
      <MarkShapes id={id} />
    </svg>
  );
}

/**
 * The name in the logo's letters, after the mark unless `mark` is false: `height` is the cap height in pixels, or
 * size it with `className`.
 */
export function Wordmark({
  height,
  className,
  title,
  mark = true,
}: {
  height?: number;
  className?: string;
  title?: string;
  mark?: boolean;
}) {
  const { APP_NAME } = useBrand();
  const config = useInstanceConfig();
  const id = useId().replace(/:/g, '');
  if (config.logoUrl)
    return (
      <img src={config.logoUrl} alt={title || APP_NAME} style={{ height }} className={className} />
    );
  if (APP_NAME !== 'Parallax')
    return (
      <span
        className={className}
        style={{
          fontSize: height || 'clamp(24px, 6vw, 72px)',
          lineHeight: 1.1,
          overflowWrap: 'anywhere',
          fontFamily: 'var(--font-display)',
        }}
      >
        {APP_NAME}
      </span>
    );
  // The mark is ~2.4 cap heights tall, centred on the letters, then a gap of ~0.4 cap heights.
  const markScale = (CAP * 2.4) / MARK.height;
  const markWidth = MARK.width * markScale;
  const lead = mark ? markWidth + CAP * 0.42 : 0;
  const top = mark ? CAP / 2 - (MARK.height * markScale) / 2 : -2;
  const [x, y, width, h] = [
    -2,
    top,
    lead + WORD_WIDTH + 4,
    mark ? MARK.height * markScale : CAP + 4,
  ];
  return (
    <svg
      viewBox={`${x} ${y} ${width} ${h}`}
      height={height ? (height * h) / CAP : undefined}
      className={className}
      role="img"
      aria-label={title || APP_NAME}
    >
      {mark && (
        <g transform={`translate(0 ${top}) scale(${markScale})`}>
          <MarkShapes id={`${id}-mark`} />
        </g>
      )}
      <g transform={`translate(${lead} 0)`}>
        <Letters letters={WORD} id={id} />
      </g>
    </svg>
  );
}
