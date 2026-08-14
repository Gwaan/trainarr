import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Build autonome (.next/standalone) consommé par le Dockerfile multi-stage.
  output: "standalone",
  // Modèle de cache Next 16 : tout est dynamique par défaut, on opte pour "use cache".
  cacheComponents: true,
  /*
   * Ni `skipTrailingSlashRedirect` ni `experimental.proxyClientMaxBodySize` :
   * les deux n'existaient que pour le dépôt WebDAV, retiré.
   *
   * - `skipTrailingSlashRedirect` empêchait le 308 de normalisation qui
   *   frappait `PROPFIND /dav/` avant le proxy. Plus de `/dav`, plus de raison
   *   de désactiver la normalisation d'URL de **toute** l'application : Next
   *   redirige de nouveau `/plan/` vers `/plan`, ce qui est son comportement par
   *   défaut, et la redirection optimiste du proxy s'applique ensuite.
   * - `proxyClientMaxBodySize` relevait la borne de bufferisation des corps qui
   *   traversent le proxy (10 Mo par défaut, tronqués en silence au-delà).
   *   Le matcher du proxy exclut désormais `/api/` : le multipart de
   *   `POST /api/fit/upload` ne traverse plus le proxy, donc n'est plus
   *   bufferisé. Vérifié sur le serveur standalone avec un envoi de 30 Mo, reçu
   *   entier.
   */
};

export default nextConfig;
