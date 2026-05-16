const apiOrigin = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4319';

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
};
export default nextConfig;
