import { ImageResponse } from 'next/og';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

// Rendered at request time via satori/ImageResponse rather than a static PNG —
// no SVG rasterizer is available in this environment to pre-bake one.
export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        background: '#0A0A0A',
        borderRadius: 40,
      }}
    >
      <svg width="180" height="180" viewBox="0 0 100 100">
        <defs>
          <linearGradient id="gRing" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#FFC93A" />
            <stop offset="1" stopColor="#F0621C" />
          </linearGradient>
          <linearGradient id="gRingS" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#E0731F" />
            <stop offset="1" stopColor="#A8461A" />
          </linearGradient>
          <linearGradient id="gLeft" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#7A756F" />
            <stop offset="1" stopColor="#3A3734" />
          </linearGradient>
          <linearGradient id="gRight" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#2E2C2A" />
            <stop offset="1" stopColor="#181716" />
          </linearGradient>
          <linearGradient id="gTop" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#2A2826" />
            <stop offset="1" stopColor="#121110" />
          </linearGradient>
        </defs>
        {/* translate(14,14) scale(.72) reproduces the 72%-inset placement
              the approved stak-app-icon.svg uses via a nested <svg x=14 y=14>,
              flattened here since satori's SVG support doesn't cover nesting. */}
        <g transform="translate(14 14) scale(0.72)">
          <g transform="translate(0 -1)">
            <polygon points="50,44 88,63 50,82 12,63" fill="url(#gTop)" />
            <polygon points="12,63 50,82 50,94 12,75" fill="url(#gLeft)" />
            <polygon points="50,82 88,63 88,75 50,94" fill="url(#gRight)" />
            <path
              d="M70 78L80 73"
              stroke="#FFB21E"
              strokeWidth="3.4"
              strokeLinecap="round"
            />
            <polygon points="12,27 50,46 50,50 12,31" fill="url(#gRingS)" />
            <polygon points="50,46 88,27 88,31 50,50" fill="url(#gRingS)" />
            <path
              d="M50 8L88 27L50 46L12 27ZM50 16L72 27L50 38L28 27Z"
              fillRule="evenodd"
              fill="url(#gRing)"
            />
          </g>
        </g>
      </svg>
    </div>,
    { ...size },
  );
}
