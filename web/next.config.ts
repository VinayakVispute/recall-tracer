import type { NextConfig } from "next";

const RECALL_API = process.env.RECALL_API ?? "http://localhost:8787";

// Every path the Hono API serves. /recall/stream (SSE) is covered by /recall/:path*.
const API_PATHS = ["/recall", "/recall/:path*", "/graph/:path*", "/notices", "/notices/:path*", "/export/:path*", "/incident/:path*", "/incidents", "/incidents/:path*", "/outbreak", "/outbreak/:path*", "/ingest/:path*", "/real/:path*", "/chat"];

const nextConfig: NextConfig = {
  reactCompiler: true,
  // gzip makes the proxied /recall/stream (SSE) arrive in one buffered chunk at the end of the run.
  compress: false,
  turbopack: {
    root: import.meta.dirname,
    rules: {
      "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" },
    },
  },
  async rewrites() {
    return API_PATHS.map((source) => ({ source, destination: `${RECALL_API}${source}` }));
  },
};

export default nextConfig;
