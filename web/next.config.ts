import type { NextConfig } from "next";

// The engine runs as its own service (`orch serve`). The browser talks to it
// through these rewrites, so there is one origin and no CORS.
const engine = process.env.ORCH_ENGINE_URL ?? "http://127.0.0.1:4317";

const nextConfig: NextConfig = {
  // The engine's reducer and tree code are shared with the browser.
  transpilePackages: ["orch"],
  devIndicators: false,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${engine}/api/:path*` }];
  },
};

export default nextConfig;
