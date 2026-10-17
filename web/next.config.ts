import type { NextConfig } from "next";

const RECALL_API = process.env.RECALL_API ?? "http://localhost:8787";

const nextConfig: NextConfig = {
  // Self-contained server for the Docker image and Render.
  output: "standalone",
  reactCompiler: true,
  // gzip makes the proxied /api/recall/stream (SSE) arrive in one buffered chunk at the end of the run.
  compress: false,
  turbopack: {
    root: import.meta.dirname,
    rules: {
      "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" },
    },
  },
  // The Hono API lives under /api so its paths (/outbreak, /incident/...) never collide with page routes.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${RECALL_API}/:path*` }];
  },
};

export default nextConfig;
