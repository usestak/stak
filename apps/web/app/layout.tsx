import type { ReactNode } from 'react';

export const metadata = {
  title: 'Stack Cloud',
  description: 'Portable AI agent environments.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
          maxWidth: 640,
          margin: '4rem auto',
          padding: '0 1.5rem',
          lineHeight: 1.6,
          color: '#111',
        }}
      >
        {children}
      </body>
    </html>
  );
}
