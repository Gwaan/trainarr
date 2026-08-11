import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { getPlanProgress } from '@/lib/ai/progress';

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
 * L'endpoint est public, comme tout ce qui vit sous `src/app/api/` :
 *
 * - il ne rend qu'un pourcentage, un numéro de tentative et leur total — aucune
 *   donnée d'entraînement, aucun contenu de plan, rien qui identifie qui que ce
 *   soit ;
 * - l'identifiant est un UUID v4 tiré par le client au moment de la soumission,
 *   donc non devinable et sans lien avec une quelconque ressource ; un id
 *   inconnu répond `null`, exactement comme un id périmé — l'endpoint ne dit pas
 *   davantage sur ce qui existe que sur ce qui n'existe pas.
 *
 * Rien à rate-limiter : la lecture est une consultation de `Map` en mémoire.
 *
 * Pas de `connection()` : le handler lit la chaîne de requête, qui est déjà un
 * signal dynamique — vérifié au build, la route ressort en `ƒ`.
 */

/** L'identifiant de suivi, tel que `crypto.randomUUID()` le produit côté client. */
const progressIdSchema = z.uuid();

export async function GET(request: NextRequest): Promise<NextResponse> {
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
    // Une progression périmée de deux secondes est une progression fausse.
    { headers: { 'cache-control': 'no-store' } },
  );
}
