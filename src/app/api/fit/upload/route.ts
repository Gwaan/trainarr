import { NextResponse, type NextRequest } from 'next/server';

import { getCurrentAthleteId } from '@/data/athlete';
import { getSession } from '@/data/session';
import { SESSION_REQUIRED_MESSAGE } from '@/lib/auth/messages';
import { ingestFitBuffer } from '@/lib/fit/ingest';
import { FitParseError } from '@/lib/fit/parse';

import {
  FIT_UPLOAD_FIELD,
  NO_ATHLETE_MESSAGE,
  UNEXPECTED_ERROR_MESSAGE,
  UPLOAD_TOO_LARGE_MESSAGE,
  checkFitFile,
  displayFileName,
  exceedsUploadLimit,
  type FitUploadResult,
} from '../_lib/upload-contract';

/**
 * Import manuel de fichiers FIT (montre, export HealthFit…), en complément du
 * rapatriement automatique depuis intervals.icu que ramasse le watcher.
 *
 * Route handler et non Server Action : l'entrée est un `multipart/form-data`
 * de plusieurs fichiers volumineux, et la réponse est un rapport par fichier.
 * L'enveloppe reste mince — le décodage et l'écriture vivent dans
 * `src/lib/fit/`, la validation d'un fichier dans `../_lib/upload-contract.ts`.
 *
 * Pas de `connection()` ici : un handler POST n'est jamais prérendu, et la
 * lecture du corps est déjà un signal dynamique — vérifié au build, la route
 * ressort en `ƒ`.
 */

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Tout premier contrôle : le proxy ne couvre pas `/api/`, et cette route est
  // la seule entrée en écriture de fichiers qui reste. Sans session, rien n'est
  // lu — ni le corps, ni la base.
  //
  // La réponse garde la forme du contrat (`{ results }`), qui est la seule que
  // l'écran d'import sache lire : un refus doit s'afficher, pas se traduire en
  // « import impossible » générique.
  if ((await getSession()) === null) {
    return NextResponse.json(
      { results: [{ name: 'Envoi', ok: false as const, error: SESSION_REQUIRED_MESSAGE }] },
      { status: 401 },
    );
  }

  // Avant toute lecture du corps : `formData()` matérialise l'intégralité du
  // multipart en mémoire, un envoi démesuré doit être refusé sans être bufferisé.
  if (exceedsUploadLimit(request.headers.get('content-length'))) {
    return NextResponse.json(
      { results: [{ name: 'Envoi', ok: false, error: UPLOAD_TOO_LARGE_MESSAGE }] },
      { status: 413 },
    );
  }

  // Endpoint public : un corps qui n'est pas un multipart exploitable n'est pas
  // une panne, c'est une requête à rejeter — même issue qu'un envoi sans fichier.
  const formData = await request.formData().catch(() => null);
  const files = formData
    ? formData
        .getAll(FIT_UPLOAD_FIELD)
        .filter((value): value is File => value instanceof File)
    : [];

  if (files.length === 0) {
    return NextResponse.json({ results: [] }, { status: 400 });
  }

  // Le propriétaire des activités importées, résolu **une fois** pour tout
  // l'envoi : c'est cette route qui sait à qui appartiennent ces fichiers (elle
  // a une session), et c'est elle qui le dit à l'ingestion. Sans athlète, rien
  // n'est lu ni écrit — une activité appartient à quelqu'un.
  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) {
    return NextResponse.json(
      { results: files.map((file) => ({ name: displayFileName(file.name), ok: false as const, error: NO_ATHLETE_MESSAGE })) },
      { status: 409 },
    );
  }

  const results: FitUploadResult[] = [];

  // Séquentiel : chaque fichier est chargé entier en mémoire et écrit en base,
  // les paralléliser multiplierait l'empreinte sans rien accélérer.
  for (const file of files) {
    const name = displayFileName(file.name);
    const check = checkFitFile(file);

    if (!check.ok) {
      results.push({ name, ok: false, error: check.error });
      continue;
    }

    try {
      const report = await ingestFitBuffer(Buffer.from(await file.arrayBuffer()), athleteId);
      results.push({ name, ok: true, status: report.status });
    } catch (error) {
      if (error instanceof FitParseError) {
        // Message métier, déjà rédigé en français et sans détail d'implémentation.
        results.push({ name, ok: false, error: error.message });
        continue;
      }

      // Panne inattendue (base indisponible, bug) : le détail reste au serveur.
      console.error(`[fit] Import du fichier « ${name} » en échec :`, error);
      results.push({ name, ok: false, error: UNEXPECTED_ERROR_MESSAGE });
    }
  }

  return NextResponse.json({ results });
}
