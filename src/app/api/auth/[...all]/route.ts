import { NextResponse, type NextRequest } from 'next/server';

import { authUnavailableMessage, getAuth } from '@/lib/auth';

/**
 * Les points d'entrée de better-auth, montés sur `/api/auth/*`.
 *
 * Route handler et non Server Action, parce que ce n'est pas notre choix :
 * better-auth expose un routeur HTTP complet (connexion, déconnexion, session,
 * jetons) et attend ce chemin — c'est la valeur de `basePath` par défaut, celle
 * que ses cookies et ses redirections supposent. Le segment attrape-tout
 * `[...all]` lui passe la requête entière ; l'enveloppe ci-dessous ne fait rien
 * d'autre.
 *
 * Les écrans, eux, ne passent pas par ici : la connexion et la création du
 * premier compte sont des Server Actions (cf. `src/app/(auth)/`), qui appellent
 * `auth.api.*` directement. Cette route reste nécessaire pour tout ce que le
 * navigateur adresse à better-auth de lui-même.
 *
 * Pas de `connection()` : un segment attrape-tout sans `generateStaticParams`
 * n'est jamais prérendu — vérifié au build, la route ressort en `ƒ`.
 */

/** Une réponse d'authentification périmée d'une seconde est une réponse fausse. */
const JSON_HEADERS = { 'cache-control': 'no-store' } as const;

async function handle(request: NextRequest): Promise<Response> {
  const auth = getAuth();

  // Sans secret configuré, l'authentification n'existe pas : 503, et le motif
  // exact — il nomme une variable d'environnement, jamais sa valeur.
  if (auth === null) {
    const message = authUnavailableMessage() ?? "Authentification non configurée.";
    return NextResponse.json({ message }, { status: 503, headers: JSON_HEADERS });
  }

  try {
    return await auth.handler(request);
  } catch (error) {
    // better-auth traduit lui-même ses erreurs métier en réponses JSON : ce qui
    // arrive ici est une panne (base injoignable, contexte impossible à
    // ouvrir). Elle est journalisée côté serveur, et rien de sa trace ne
    // franchit la frontière.
    console.error("[auth] échec du traitement d'une requête d'authentification", error);
    return NextResponse.json(
      { message: "Erreur interne du service d'authentification." },
      { status: 500, headers: JSON_HEADERS },
    );
  }
}

export const GET = handle;
export const POST = handle;
