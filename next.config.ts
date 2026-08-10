import type { NextConfig } from "next";

import { MAX_FIT_FILE_BYTES } from "./src/lib/fit/limits";

const nextConfig: NextConfig = {
  // Build autonome (.next/standalone) consommé par le Dockerfile multi-stage.
  output: "standalone",
  // Modèle de cache Next 16 : tout est dynamique par défaut, on opte pour "use cache".
  cacheComponents: true,
  /**
   * Sans ce drapeau, `PROPFIND /dav/` reçoit un 308 de normalisation **avant**
   * que `src/proxy.ts` ne s'exécute (vérifié) : les clients WebDAV suffixent
   * les collections d'un « / », le point de dépôt serait inutilisable. Le reste
   * de l'application continue de servir les URL suffixées, sans redirection.
   */
  skipTrailingSlashRedirect: true,
  experimental: {
    /**
     * Next bufferise le corps des requêtes qui traversent le proxy et le
     * **tronque silencieusement** au-delà de cette borne (10 Mo par défaut).
     * Un dépôt WebDAV doit donc pouvoir couvrir un fichier FIT entier, sans
     * quoi les gros fichiers arriveraient mutilés.
     */
    proxyClientMaxBodySize: MAX_FIT_FILE_BYTES,
  },
};

export default nextConfig;
