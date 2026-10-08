/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Linting runs as a separate turbo task, not during the build.
  eslint: { ignoreDuringBuilds: true },
  // The codebase imports local modules with explicit `.js` extensions (TS NodeNext style)
  // even though the source files are `.ts`/`.tsx` — webpack doesn't resolve that by default.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
