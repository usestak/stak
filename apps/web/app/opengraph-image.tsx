import { ImageResponse } from 'next/og';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Derived directly from the approved identity (symbol geometry + brand tokens from
// apps/web/public/brand/BRAND.md) with no new visual direction — background, ring colors,
// and wordmark hierarchy (STAK bold over "Memory" muted) all come from that spec.
export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 56,
        padding: '0 96px',
        background: '#0B0A09',
      }}
    >
      <svg width="220" height="220" viewBox="0 0 100 100">
        <g transform="translate(0 -1)">
          <polygon points="50,44 88,63 50,82 12,63" fill="#1F1D1B" />
          <polygon points="12,63 50,82 50,94 12,75" fill="#4A4743" />
          <polygon points="50,82 88,63 88,75 50,94" fill="#2A2826" />
          <path
            d="M70 78L80 73"
            stroke="#F2A03A"
            strokeWidth="3.4"
            strokeLinecap="round"
          />
          <polygon points="12,27 50,46 50,50 12,31" fill="#B0531F" />
          <polygon points="50,46 88,27 88,31 50,50" fill="#B0531F" />
          <path
            d="M50 8L88 27L50 46L12 27ZM50 16L72 27L50 38L28 27Z"
            fillRule="evenodd"
            fill="#E8793A"
          />
        </g>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', fontSize: 72, letterSpacing: -1 }}>
          <span style={{ color: '#A39D93', fontWeight: 400 }}>Memory</span>
          <span style={{ color: '#ECE7DF', fontWeight: 700, marginLeft: 16 }}>
            STAK
          </span>
        </div>
        <div style={{ display: 'flex', fontSize: 30, color: '#B8B2A8' }}>
          Portable AI agent environments.
        </div>
      </div>
    </div>,
    { ...size },
  );
}
