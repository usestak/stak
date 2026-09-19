/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Linting runs as a separate turbo task, not during the build.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
