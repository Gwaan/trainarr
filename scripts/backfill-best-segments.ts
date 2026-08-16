/**
 * Rattrapage des meilleurs efforts sur l'historique déjà en base.
 *
 * `activity_best_segments` est alimentée **à l'ingestion** : elle vaut donc pour
 * les imports à venir et reste vide sur tout ce qui a été importé avant elle.
 * Ce script balaie ces séances-là, calcule leurs segments depuis
 * `activity_streams`, et les écrit. Tant qu'il n'est pas passé, l'écran des
 * records annonce des records **provisoires** (`pendingActivities`, cf.
 * `src/data/personal-bests.ts`) — et il compte exactement ce que ce script
 * ramassera, les deux partageant la même définition
 * (`src/data/db/best-segments-scope.ts`).
 *
 * Usage : `pnpm db:backfill:best-segments` (les migrations doivent avoir été
 * appliquées avant).
 *
 * ## Forme
 *
 * Point d'entrée exécutable, autonome comme `src/data/db/migrate.ts` :
 * **pas de `import 'server-only'`**, pas d'import du client applicatif ni du
 * DAL, connexion propre en `max: 1`, `DATABASE_URL` lue directement.
 *
 * ## Ce qui est garanti
 *
 * - **Par lots** : l'historique de flux n'est jamais chargé en entier. La
 *   pagination porte sur les *identifiants* ({@link BATCH_SIZE} par tour), et
 *   les flux sont lus **une séance à la fois** — le pic mémoire est donc celui
 *   d'une seule séance, quelle que soit la taille de l'historique. C'est une
 *   requête par activité, assumé : ce script tourne une fois, la sûreté prime
 *   sur le débit.
 * - **Idempotent** : ne sont sélectionnées que les activités jamais balayées et
 *   sans aucune ligne de segment, et le balayage de chacune est une transaction
 *   purge + insertion + marque. Le relancer ne duplique rien et ne refait pas le
 *   travail fait.
 * - **Progression journalisée** : « 120/540 activités traitées ».
 * - **Le compteur atteint zéro** : chaque séance balayée reçoit sa marque
 *   (`activities.best_segments_scanned_at`) **même quand le calcul ne rend
 *   rien**, et sort donc du prédicat. C'est le point qui manquait : un flux de
 *   distance présent mais inexploitable produisait zéro segment, donc zéro
 *   ligne, donc une séance éternellement « en attente » à l'écran des records.
 * - **Rien ne l'arrête, et rien n'est tu** : une séance qui ne produit aucun
 *   segment est journalisée **avec son identifiant et son motif** — sans quoi
 *   rien ne permettrait d'aller regarder les lignes en cause. Une séance dont
 *   l'écriture échoue reste, elle, sans marque : elle sera reprise au prochain
 *   passage. C'est aussi pourquoi le curseur avance par identifiant croissant —
 *   sans lui, une séance en échec serait resélectionnée sans fin.
 *
 * Le script balaie **tous les athlètes** : il n'a pas de session, et chaque
 * ligne écrite reste rattachée à son propriétaire par la clé étrangère de son
 * activité.
 */

import { pathToFileURL } from 'node:url';

import { and, asc, count, eq, gt, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import {
  bestSegmentsScanMark,
  pendingBestSegmentsWhere,
  toBestSegmentRows,
} from '../src/data/db/best-segments-scope';
import { activities, activityBestSegments, activityStreams } from '../src/data/db/schema';
import { computeBestSegments } from '../src/lib/metrics/best-segments';

/**
 * Nombre d'identifiants ramenés par tour. Cinquante : assez pour que le coût
 * de la requête de sélection (qui porte deux `EXISTS`) se dilue, assez peu pour
 * que la progression s'affiche régulièrement et qu'une interruption ne perde
 * que quelques secondes de travail. Ce n'est pas un lot de *données* — les flux
 * sont lus séance par séance.
 */
const BATCH_SIZE = 50;

/** Les deux seuls canaux dont le calcul a besoin. */
const NEEDED_STREAMS = ['distance', 'time'] as const;

type Database = ReturnType<typeof drizzle>;

/**
 * Ouvre la connexion, rattrape, referme.
 *
 * **Exportée pour être testée** : c'est tout le script sauf son bootstrap, et
 * ce qu'elle garantit — le compteur d'activités en attente atteint zéro — ne se
 * vérifie qu'en la faisant tourner (cf. `backfill-best-segments.test.ts`, qui
 * lui substitue une base en mémoire).
 */
export async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL est requise pour rattraper les meilleurs efforts.');
  }

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await backfill(drizzle(sql));
  } finally {
    // Sans fermeture explicite, le pool garde le process en vie.
    await sql.end();
  }
}

async function backfill(db: Database): Promise<void> {
  const total = await countPending(db);
  if (total === 0) {
    console.log('Aucune activité en attente : tous les meilleurs efforts sont en base.');
    return;
  }

  console.log(`${total} activités à traiter.`);

  let cursor = 0;
  let processed = 0;
  let written = 0;
  let empty = 0;
  let failed = 0;

  for (;;) {
    const batch = await selectPending(db, cursor);
    if (batch.length === 0) break;

    for (const { id } of batch) {
      cursor = id;
      processed += 1;
      try {
        const outcome = await sweepActivity(db, id);
        if (outcome === null) {
          written += 1;
        } else {
          empty += 1;
          // Le seul moyen d'aller voir les lignes en cause : sans l'identifiant,
          // « 12 séances sans segment » n'apprend rien et ne se corrige pas.
          console.warn(`Activité ${id} : aucun segment — ${outcome}. Balayée quand même.`);
        }
      } catch (error) {
        failed += 1;
        const reason = error instanceof Error ? `${error.name} : ${error.message}` : String(error);
        console.error(`Activité ${id} : segments non écrits — ${reason}`);
      }
    }

    console.log(`${processed}/${total} activités traitées.`);
  }

  console.log(
    `Terminé : ${processed} activités traitées, ${written} avec des segments, ` +
      `${empty} sans segment calculable, ${failed} en échec.`,
  );
  if (failed > 0) {
    // Les seules qui restent « en attente » : elles n'ont pas reçu leur marque.
    console.log(`${failed} activités restent à rattraper : relancer la commande les reprendra.`);
  }
}

/** Combien de séances restent à balayer — pour la progression, rien d'autre. */
async function countPending(db: Database): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(activities)
    .where(pendingBestSegmentsWhere());

  return rows[0]?.value ?? 0;
}

/**
 * Le lot suivant d'identifiants, au-delà du curseur.
 *
 * Le curseur (`id > cursor`) plutôt qu'un `OFFSET` : les lignes balayées sortent
 * du prédicat au fur et à mesure, un `OFFSET` sauterait donc des séances. Il
 * reste **indispensable** à la terminaison même depuis que la marque de balayage
 * existe : une séance dont l'écriture échoue ne reçoit pas de marque, donc reste
 * dans le prédicat, et serait resélectionnée sans fin.
 */
async function selectPending(db: Database, cursor: number): Promise<{ id: number }[]> {
  return db
    .select({ id: activities.id })
    .from(activities)
    .where(and(gt(activities.id, cursor), pendingBestSegmentsWhere()))
    .orderBy(asc(activities.id))
    .limit(BATCH_SIZE);
}

/**
 * Balaie une séance : calcule ses segments, les écrit, et la marque comme
 * balayée. Rend `null` si des segments ont été écrits, sinon le **motif** pour
 * lequel il n'y en a aucun.
 *
 * La marque est posée dans tous les cas, dans la transaction : c'est ce qui
 * garantit que la séance sort du prédicat et que le compteur de l'écran des
 * records finit par atteindre zéro. Le motif, lui, part dans les journaux —
 * une séance sans segment n'est pas une anomalie silencieuse.
 *
 * Les flux sont lus ici, pour cette seule activité, et relâchés au tour suivant.
 */
async function sweepActivity(db: Database, activityId: number): Promise<string | null> {
  const streams = await db
    .select({ type: activityStreams.type, data: activityStreams.data })
    .from(activityStreams)
    .where(
      and(
        eq(activityStreams.activityId, activityId),
        inArray(activityStreams.type, [...NEEDED_STREAMS]),
      ),
    );

  const distance = seriesOf(streams, 'distance');
  const time = seriesOf(streams, 'time');

  // Le motif est nommé : « flux absent ou mal formé » et « distance parcourue
  // sous 400 m » n'appellent pas la même vérification côté données.
  const reason =
    distance === null
      ? 'flux de distance absent ou mal formé'
      : time === null
        ? 'axe des temps absent ou mal formé'
        : null;

  const segments =
    distance !== null && time !== null ? computeBestSegments(distance, time) : [];
  const rows = toBestSegmentRows(activityId, segments);

  await db.transaction(async (tx) => {
    // Purge d'abord : le prédicat de sélection exclut déjà les activités qui ont
    // des segments, mais un second passage concurrent (ou un réimport en cours)
    // ne doit pas se heurter à la clé primaire.
    await tx.delete(activityBestSegments).where(eq(activityBestSegments.activityId, activityId));
    if (rows.length > 0) await tx.insert(activityBestSegments).values(rows);
    // La marque, dans la même transaction et sans condition sur `rows` : une
    // séance regardée est une séance regardée, avec ou sans résultat.
    await tx
      .update(activities)
      .set(bestSegmentsScanMark(new Date()))
      .where(eq(activities.id, activityId));
  });

  if (rows.length > 0) return null;
  return reason ?? 'aucune fenêtre de 400 m dans le flux de distance';
}

/**
 * La série numérique d'un canal, `null` si elle est absente ou si sa forme ne
 * correspond pas (une série de couples écrite sous un type scalaire, par
 * exemple). Une donnée mal formée se refuse, elle ne se devine pas.
 */
function seriesOf(
  rows: readonly { type: string; data: unknown }[],
  type: (typeof NEEDED_STREAMS)[number],
): (number | null)[] | null {
  const data = rows.find((row) => row.type === type)?.data;
  if (!Array.isArray(data)) return null;

  return isNumberSeries(data) ? data : null;
}

function isNumberSeries(data: readonly unknown[]): data is (number | null)[] {
  return data.every((value) => value === null || typeof value === 'number');
}

/*
 * Bootstrap, sous le test canonique « ce module est-il le point d'entrée du
 * process ? ». Sans lui, importer le module — ce que fait son test — lancerait
 * un rattrapage et terminerait le process de vitest par un `process.exit`.
 * `pnpm db:backfill:best-segments` le franchit, et c'est vérifiable : sans
 * `DATABASE_URL`, la commande doit échouer en le disant.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => {
      process.exit(0);
    },
    (error: unknown) => {
      console.error('Échec du rattrapage des meilleurs efforts :', error);
      process.exit(1);
    },
  );
}
