import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Build autonome (.next/standalone) consommé par le Dockerfile multi-stage.
  output: "standalone",
  // Modèle de cache Next 16 : tout est dynamique par défaut, on opte pour "use cache".
  cacheComponents: true,
};

export default nextConfig;
