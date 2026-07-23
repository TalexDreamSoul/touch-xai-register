import type { NextConfig } from "next";

const apiTarget = process.env.API_PROXY_TARGET || "http://127.0.0.1:8787";
const isExport = process.env.NEXT_OUTPUT === "export" || process.env.NODE_ENV === "production";

const nextConfig: NextConfig = {
  // Static export → copied into web/ for Go embed (production)
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  turbopack: {
    root: process.cwd(),
  },
};

// rewrites only apply in `next dev` (export ignores custom routes)
if (!isExport) {
  // no-op: keep API_PROXY_TARGET documented for local next dev reverse-proxy setups
  void apiTarget;
}

export default nextConfig;
