/**
 * Rattrapage du **dénivelé** sur l'historique déjà en base.
 *
 * `activities.elevation_gain_m` et `elevation_loss_m` sont alimentées **à
 * l'ingestion** : par le fichier quand il porte `total_ascent` / `total_descent`,
 * sinon par un calcul sur le flux d'altitude (cf. `recordElevation` dans
 * `src/lib/fit/ingest.ts`). Elles valent donc pour les imports à venir et
 * restent vides sur tout ce qui a été importé avant elles — la montre de
 * l'athlète n'écrivant aucun des deux champs, c'est le cas de la totalité de
 * l'historique. Ce script balaie ces séances-là, calcule leur dénivelé depuis
 * `activity_streams`, et l'écrit.
 *
 * Usage : `pnpm db:backfill:elevation` (les migrations doivent avoir été
 * appliquées avant).
 *
 * ## Forme
 *
 * Calque exact de `scripts/backfill-best-segments.ts`, et point d'entrée
 * exécutable autonome comme `src/data/db/migrate.ts` : **pas de
 * `import 'server-only'`**, pas d'import du client applicatif ni du DAL,
 * connexion propre en `max: 1`, `DATABASE_URL` lue directement.
 *
 * ## Ce qui est garanti
 *
 * - **Par lots** : l'historique de flux n'est jamais chargé en entier. La
 *   pagination porte sur les *identifiants* ({@link BATCH_SIZE} par tour), et le
 *   flux d'altitude est lu **une séance à la fois** — le pic mémoire est celui
 *   d'une seule séance, quelle que soit la taille de l'historique.
 * - **Idempotent** : ne sont sélectionnées que les activités jamais balayées
 *   dont **aucun** des deux sens n'est connu, et l'écriture est conditionnée à
 *   cette même paire vide — elle ne peut pas écraser une valeur déjà sue. Le
 *   relancer ne refait pas le travail fait. La paire est atomique : un appareil
 *   qui n'écrit qu'un sens garde le sien, et le flux ne complète pas l'autre
 *   (cf. `elevationWrite`, qui porte la justification).
 * - **Progression journalisée** : « 120/540 activités traitées ».
 * - **Le compteur atteint zéro** : chaque séance balayée reçoit sa marque
 *   (`activities.elevation_scanned_at`) **même quand le calcul ne rend rien**, et
 *   sort donc du prédicat. C'est la leçon que le dépôt a écrite avec les
 *   meilleurs efforts (cf. `.claude/rules/data-import.md`) : le critère de sortie
 *   d'un rattrapage est « je l'ai regardée », jamais « elle a produit quelque
 *   chose ». Un flux d'altitude présent mais entièrement `null`, non numérique,
 *   ou réduit à une seule mesure ne produit aucun dénivelé — et resterait
 *   sélectionné pour toujours sans cette marque.
 * - **Rien ne l'arrête, et rien n'est tu** : une séance qui ne produit aucun
 *   dénivelé est journalisée **avec son identifiant et son motif**. Une séance
 *   dont l'écriture échoue reste, elle, sans marque : elle sera reprise au
 *   prochain passage. C'est aussi pourquoi le curseur avance par identifiant
 *   croissant — sans lui, une séance en échec serait resélectionnée sans fin.
 *
 * Le script balaie **tous les athlètes** : il n'a pas de session, et chaque
 * valeur écrite reste sur la ligne d'activité de son propriétaire.
 */

import { pathToFileURL } from 'node:url';

import { and, asc, count, eq, gt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { elevationWrite, pendingElevationWhere } from '../src/data/db/elevation-scope';
import { activities, activityStreams } from '../src/data/db/schema';
import { elevationChange } from '../src/lib/metrics/elevation';

/**
 * Nombre d'identifiants ramenés par tour. Cinquante, comme le rattrapage des
 * meilleurs efforts : assez pour que le coût de la requête de sélection (qui
 * porte un `EXISTS`) se dilue, assez peu pour que la progression s'affiche
 * régulièrement. Ce n'est pas un lot de *données* — les flux sont lus séance par
 * séance.
 */
const BATCH_SIZE = 50;

type Database = ReturnType<typeof drizzle>;

/**
 * Ouvre la connexion, rattrape, referme.
 *
 * **Exportée pour être testée** : c'est tout le script sauf son bootstrap, et ce
 * qu'elle garantit — le balayage converge — ne se vérifie qu'en la faisant
 * tourner (cf. `backfill-elevation.test.ts`, qui lui substitue une base en
 * mémoire).
 */
export async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL est requise pour rattraper le dénivelé.');
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
    console.log('Aucune activité en attente : tous les dénivelés calculables sont en base.');
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
          // « 12 séances sans dénivelé » n'apprend rien et ne se corrige pas.
          console.warn(`Activité ${id} : aucun dénivelé — ${outcome}. Balayée quand même.`);
        }
      } catch (error) {
        failed += 1;
        const reason = error instanceof Error ? `${error.name} : ${error.message}` : String(error);
        console.error(`Activité ${id} : dénivelé non écrit — ${reason}`);
      }
    }

    console.log(`${processed}/${total} activités traitées.`);
  }

  console.log(
    `Terminé : ${processed} activités traitées, ${written} avec un dénivelé, ` +
      `${empty} sans dénivelé calculable, ${failed} en échec.`,
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
    .where(pendingElevationWhere());

  return rows[0]?.value ?? 0;
}

/**
 * Le lot suivant d'identifiants, au-delà du curseur.
 *
 * Le curseur (`id > cursor`) plutôt qu'un `OFFSET` : les lignes balayées sortent
 * du prédicat au fur et à mesure, un `OFFSET` sauterait donc des séances. Il
 * reste **indispensable** à la terminaison même avec la marque de balayage : une
 * séance dont l'écriture échoue ne la reçoit pas, donc reste dans le prédicat, et
 * serait resélectionnée sans fin.
 */
async function selectPending(db: Database, cursor: number): Promise<{ id: number }[]> {
  return db
    .select({ id: activities.id })
    .from(activities)
    .where(and(gt(activities.id, cursor), pendingElevationWhere()))
    .orderBy(asc(activities.id))
    .limit(BATCH_SIZE);
}

/**
 * Balaie une séance : calcule son dénivelé, l'écrit, et la marque comme balayée.
 * Rend `null` si un dénivelé a été écrit, sinon le **motif** pour lequel il n'y
 * en a pas.
 *
 * La marque est posée dans tous les cas, dans la même instruction que les
 * colonnes (`elevationWrite`) : c'est ce qui garantit que la séance sort du
 * prédicat et que le balayage converge. Le motif, lui, part dans les journaux —
 * une séance sans dénivelé n'est pas une anomalie silencieuse.
 *
 * L'écriture est un `coalesce` : une valeur déjà en base (le `total_ascent` d'un
 * fichier qui l'écrivait) n'est jamais écrasée par le calcul de repli.
 *
 * Le flux est lu ici, pour cette seule activité, et relâché au tour suivant.
 */
async function sweepActivity(db: Database, activityId: number): Promise<string | null> {
  const rows = await db
    .select({ data: activityStreams.data })
    .from(activityStreams)
    .where(
      and(
        eq(activityStreams.activityId, activityId),
        eq(activityStreams.type, 'altitude'),
      ),
    );

  const altitude = altitudeSeries(rows);
  const change = altitude === null ? null : elevationChange(altitude);

  await db
    .update(activities)
    .set(elevationWrite(change, new Date()))
    .where(eq(activities.id, activityId));

  if (change !== null) return null;
  // Deux motifs distincts, parce qu'ils n'appellent pas la même vérification
  // côté données : un canal mal formé se répare au réimport, un canal trop
  // clairsemé ne se réparera jamais.
  return altitude === null
    ? "flux d'altitude absent ou mal formé"
    : "moins de deux mesures d'altitude exploitables";
}

/**
 * La série d'altitude, `null` si elle est absente ou si sa forme ne correspond
 * pas (une série de couples écrite sous un type scalaire, par exemple). Une
 * donnée mal formée se refuse, elle ne se devine pas.
 */
function altitudeSeries(rows: readonly { data: unknown }[]): (number | null)[] | null {
  const data = rows[0]?.data;
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
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => {
      process.exit(0);
    },
    (error: unknown) => {
      console.error('Échec du rattrapage du dénivelé :', error);
      process.exit(1);
    },
  );
}
