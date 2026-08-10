import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { env } from '@/config/env';
import { DAV_BASE_PATH, handleDavRequest, nodeDavFileSystem } from '@/lib/fit/dav';

/**
 * Interception réseau (ex-`middleware.ts`, déprécié en v16). Runtime Node.js.
 *
 * Un seul usage : servir le point de dépôt WebDAV des fichiers FIT sur `/dav`.
 * Le proxy est le seul endroit qui puisse le faire — il s'exécute **avant** le
 * routage, donc avant que Next ne rejette `PROPFIND` ou `MKCOL`, que les route
 * handlers ne savent pas déclarer (vérifié en dev comme en build standalone).
 *
 * Il reste une enveloppe : tout le protocole vit dans `src/lib/fit/dav.ts`,
 * testable sans serveur HTTP. Ce n'est pas non plus la couche d'auth de
 * l'application — l'authentification Basic ici ne protège que `/dav`.
 *
 * Deux réglages de `next.config.ts` en dépendent, ne pas les retirer :
 * `skipTrailingSlashRedirect` (sans lui, `PROPFIND /dav/` est redirigé en 308
 * avant d'atteindre le proxy, or les clients WebDAV suffixent les collections)
 * et `experimental.proxyClientMaxBodySize` (Next bufferise le corps et le
 * tronque silencieusement au-delà — la valeur doit couvrir `MAX_FIT_FILE_BYTES`).
 */
export async function proxy(request: NextRequest): Promise<Response> {
  const { pathname } = request.nextUrl;

  if (pathname === DAV_BASE_PATH || pathname.startsWith(`${DAV_BASE_PATH}/`)) {
    return handleDavRequest(request, {
      credentials:
        env.WEBDAV_USERNAME !== undefined && env.WEBDAV_PASSWORD !== undefined
          ? { username: env.WEBDAV_USERNAME, password: env.WEBDAV_PASSWORD }
          : null,
      inboxDir: env.FIT_INBOX_DIR,
      fs: nodeDavFileSystem,
    });
  }

  return NextResponse.next();
}

/**
 * Le proxy ne s'exécute que sur `/dav` : tout le reste de l'application (pages,
 * route handlers, assets) n'a rien à en attendre, autant ne pas lui faire
 * traverser une couche de plus.
 */
export const config = {
  matcher: ['/dav', '/dav/:path*'],
};
