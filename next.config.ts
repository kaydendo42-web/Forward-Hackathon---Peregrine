import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // pdf-parse (pdfjs) and sharp use Node-specific loading; keep them out of the server bundle
  // so the intake route requires them at runtime instead of evaluating them at build.
  serverExternalPackages: ['pdf-parse', 'pdfjs-dist', 'sharp'],
};

export default nextConfig;
