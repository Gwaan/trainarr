import { NextResponse, connection, type NextRequest } from 'next/server';
import { z } from 'zod';

import { getSession } from '@/data/session';
import { getPlanProgress } from '@/lib/ai/progress';
import { SESSION_REQUIRED_MESSAGE } from '@/lib/auth/messages';

/**
 * Avancement d'une génération de plan en cours : `GET /api/plan-progress?id=<uuid>`.
 *
 * Route handler et non Server Action : c'est une **lecture** interrogée toutes
 * les deux secondes pendant qu'une action occupe déjà le formulaire. Une action
 * de plus sérialiserait les deux (les Server Actions s'exécutent à la queue leu
 * leu) et la barre ne bougerait jamais.
 *
 * ## Sécurité
 *
 * **Une session est exigée**, comme sur toute route de `src/app/api/` hors
 * `/api/auth/…`. Elle ne l'était pas tant que l'application n'avait pas de
 * comptes : l'endpoint ne rend qu'un pourcentage, un numéro de tentative et
 * leur total — aucune donnée d'entraînement, aucun contenu de plan. Mais une
 * porte ouverte se justifie par ce qu'elle protège, pas par ce qu'elle laisse
 * voir aujourd'hui, et le reste de l'API est fermé : celle-ci l'est aussi.
 *
 * Le reste n'a pas changé : l'identifiant est un UUID v4 tiré par le client au
 * moment de la soumission, donc non devinable ; un id inconnu répond `null`,
 * exactement comme un id périmé — l'endpoint ne dit pas davantage sur ce qui
 * existe que sur ce qui n'existe pas.
 *
 * Rien à rate-limiter : la lecture est une consultation de `Map` en mémoire.
 *
 * `connection()` en tête, et il est **indispensable depuis que la session est
 * exigée** : `cacheComponents: true` prérend ce handler `GET` au build, où ni la
 * base ni les variables d'environnement n'existent. La lecture de la chaîne de
 * requête suffisait à l'en sortir tant qu'elle venait en premier ; la session,
 * elle, lit `env` **avant** son premier signal dynamique et fait échouer le
 * build (vérifié). Cf. `.claude/rules/nextjs.md`.
 */

/** L'identifiant de suivi, tel que `crypto.randomUUID()` le produit côté client. */
const progressIdSchema = z.uuid();

/** Une progression périmée de deux secondes est une progression fausse. */
const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function GET(request: NextRequest): Promise<NextResponse> {
  await connection();

  // Avant de lire quoi que ce soit : le proxy ne couvre pas `/api/`, c'est ici
  // que la route se protège elle-même.
  if ((await getSession()) === null) {
    return NextResponse.json(
      { error: SESSION_REQUIRED_MESSAGE },
      { status: 401, headers: NO_STORE },
    );
  }

  const parsed = progressIdSchema.safeParse(request.nextUrl.searchParams.get('id'));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Identifiant de suivi invalide.' }, { status: 400 });
  }

  const progress = getPlanProgress(parsed.data);

  return NextResponse.json(
    progress === null
      ? null
      : {
          percent: progress.percent,
          attempt: progress.attempt,
          maxAttempts: progress.maxAttempts,
        },
    { headers: NO_STORE },
  );
}
