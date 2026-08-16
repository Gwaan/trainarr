/**
 * Ce qu'est une activité « en attente de segments », et comment s'écrivent ses
 * segments — en SQL, sans `server-only`.
 *
 * Ce module existe pour une raison précise : **deux appelants qui ne peuvent
 * pas partager de code applicatif** doivent pourtant s'accorder au critère près.
 *
 * - le script de rattrapage (`scripts/backfill-best-segments.ts`) tourne hors
 *   serveur, comme `migrate.ts` : il n'importe ni `server-only`, ni le client
 *   applicatif, ni le DAL ;
 * - le DAL des records (`src/data/personal-bests.ts`) **compte** ce qui reste à
 *   rattraper, pour que l'écran puisse dire que les records sont provisoires.
 *
 * Si les deux définitions divergeaient d'un critère, le compteur n'atteindrait
 * jamais zéro (le script ne balaierait pas ce que le DAL compte) et l'écran
 * annoncerait éternellement des records provisoires. D'où une définition
 * unique, ici, importée par les deux.
 *
 * Trois choses y vivent, et c'est leur accord qui fait tenir l'ensemble : le
 * prédicat ({@link pendingBestSegmentsWhere}), la forme des lignes écrites
 * ({@link toBestSegmentRows}) et la **marque de balayage**
 * ({@link bestSegmentsScanMark}) — celle-ci parce qu'une marque que l'un des
 * deux écrivains oublierait de poser laisserait des séances éternellement
 * comptées « en attente », sans autre symptôme.
 *
 * Aucun `import 'server-only'`, et **aucun import par alias `@/`** : ce fichier
 * est chargé par `tsx` hors du build Next (même contrainte que
 * `scripts/seed.ts`).
 */

import { and, eq, gte, isNull, sql, type SQL } from 'drizzle-orm';

import { BEST_SEGMENT_TARGETS_M, type BestSegment } from '../../lib/metrics/best-segments';

import {
  activities,
  activityBestSegments,
  activityStreams,
  type NewActivityBestSegment,
} from './schema';

/**
 * La plus petite cible (400 m) : en dessous, aucun segment n'est calculable, et
 * une séance plus courte n'a pas à rester éternellement « en attente ».
 */
const SMALLEST_TARGET_M = Math.min(...BEST_SEGMENT_TARGETS_M);

/**
 * « Cette activité est de la course à pied », en SQL.
 *
 * Même définition que `isRunning` (`src/data/training-metrics.ts`), qui décide
 * du calcul côté application : `lower(sport_type)` contient `run`. Les deux
 * doivent bouger ensemble — un sport reconnu ici et pas là-bas produirait des
 * séances comptées « en attente » que rien ne viendrait jamais servir.
 */
const IS_RUNNING = sql`lower(${activities.sportType}) like '%run%'`;

/** L'activité porte le flux de distance dont le calcul a besoin. */
const HAS_DISTANCE_STREAM = sql`exists (
  select 1 from ${activityStreams}
  where ${activityStreams.activityId} = ${activities.id}
    and ${activityStreams.type} = 'distance'
)`;

/** Aucun segment n'a encore été écrit pour cette activité. */
const HAS_NO_SEGMENT = sql`not exists (
  select 1 from ${activityBestSegments}
  where ${activityBestSegments.activityId} = ${activities.id}
)`;

/**
 * L'activité n'a **jamais été balayée**. C'est la condition qui garantit la
 * terminaison, cf. {@link pendingBestSegmentsWhere}.
 */
const NEVER_SCANNED = isNull(activities.bestSegmentsScannedAt);

/**
 * Les activités dont les meilleurs segments restent à calculer — clause
 * `where` sur `activities`.
 *
 * ## Ce que « en attente » veut dire, et pourquoi ça a changé
 *
 * « En attente » ne veut **pas** dire « sans segment » : ça veut dire
 * « personne n'a encore regardé ». La nuance décide de la seule propriété qui
 * compte ici — que le compteur puisse atteindre zéro.
 *
 * La première version du prédicat sélectionnait toute séance de course d'au
 * moins 400 m, portant un flux de distance, et sans ligne de segment. Trois
 * conditions de *possibilité*, honnêtes une par une, mais qui laissaient entrer
 * des séances que le rattrapage ne pouvait pas en faire sortir : un flux de
 * distance présent mais inexploitable (canal entièrement `null` d'un import
 * indoor, canal non numérique d'un import ancien, amplitude réelle sous 400 m
 * alors que `distance_m` annonce davantage) ne produit aucun segment, donc
 * aucune ligne, donc la séance restait sélectionnée **pour toujours**.
 * L'écran des records réclamait alors `pnpm db:backfill:best-segments` après le
 * passage de la commande, définitivement.
 *
 * Le prédicat s'ancre donc désormais sur une **marque persistée**,
 * `activities.best_segments_scanned_at`, que les deux écrivains posent dans la
 * transaction qui écrit les segments — y compris quand celle-ci n'écrit rien.
 * Une séance balayée sort du prédicat, quel qu'ait été le résultat : le
 * compteur décroît strictement, donc il atteint zéro.
 *
 * L'autre voie envisagée — exclure les flux inexploitables directement en SQL —
 * a été écartée : elle demanderait de lire et de typer le JSONB des séries dans
 * la clause `where`, c'est-à-dire exactement ce que cette table existe pour ne
 * plus faire, et à chaque affichage de l'écran des records.
 *
 * ## Les conditions, et ce qu'elles disent chacune
 *
 * 1. **course à pied** : le reste n'a pas de records d'allure — c'est déjà la
 *    règle de `getActivityFull` ;
 * 2. **au moins 400 m parcourus** : sous la plus petite cible, il n'y a rien à
 *    mesurer ;
 * 3. **un flux de distance en base** : le calcul balaie la distance cumulée ;
 *    une séance dépourvue de ce canal (import ancien, doublon dont on n'a pas
 *    retenu les séries) ne donnera jamais de segment. L'axe `time`, lui, n'est
 *    pas testé : il est écrit dès qu'un canal l'est, c'est l'axe des séries.
 *
 * Ces trois-là ne servent qu'à ne pas *annoncer* du travail qui n'en est pas :
 * une sortie vélo ou un footing de 200 m n'a pas à gonfler le compteur. Elles ne
 * portent plus la terminaison.
 *
 * 4. **jamais balayée**, et 5. **aucune ligne de segment déjà écrite**. La
 *    quatrième suffirait à la terminaison ; la cinquième est conservée parce
 *    qu'elle est plus forte que la marque sur un point : si une marque était
 *    effacée à la main pour rejouer le rattrapage après une correction du
 *    calcul, elle éviterait de recompter des séances déjà servies. Les deux
 *    ensemble se lisent « jamais regardée, et rien en base ».
 *
 * **`athleteId` est facultatif**, et c'est la seule différence entre les deux
 * appelants : le DAL compte sous l'athlète de la session, le rattrapage balaie
 * la base entière sans avoir à énumérer les comptes. Rien n'est mélangé pour
 * autant — chaque ligne écrite reste rattachée à son activité, donc à son
 * propriétaire, par sa clé étrangère.
 */
export function pendingBestSegmentsWhere(athleteId?: number): SQL | undefined {
  return and(
    athleteId === undefined ? undefined : eq(activities.athleteId, athleteId),
    IS_RUNNING,
    gte(activities.distanceM, SMALLEST_TARGET_M),
    HAS_DISTANCE_STREAM,
    NEVER_SCANNED,
    HAS_NO_SEGMENT,
  );
}

/**
 * Les lignes à écrire pour une activité, telles que la base les attend.
 *
 * Partagée par l'ingestion et le rattrapage : les deux doivent écrire la même
 * chose, dans les mêmes unités, sous peine de records qui dépendraient du
 * chemin par lequel la séance est entrée en base.
 */
export function toBestSegmentRows(
  activityId: number,
  segments: readonly BestSegment[],
): NewActivityBestSegment[] {
  return segments.map((segment) => ({
    activityId,
    targetM: segment.targetM,
    timeS: segment.timeS,
    paceSecPerKm: segment.paceSecPerKm,
  }));
}

/**
 * La marque « cette séance a été balayée », telle que les deux écrivains la
 * posent — de quoi alimenter un `update(activities).set(…)`.
 *
 * Partagée pour la même raison que le prédicat : c'est elle qui fait sortir une
 * séance de {@link pendingBestSegmentsWhere}. Un écrivain qui l'oublierait
 * rendrait le compteur de l'écran des records éternellement non nul, sans que
 * rien d'autre ne le signale.
 *
 * **Elle se pose dans la transaction qui purge et réécrit les segments**, et
 * dans tous les cas — y compris quand le calcul ne rend rien : c'est le cas
 * qu'elle existe pour clore. Si la transaction échoue, la marque disparaît avec
 * elle et la séance repart en attente, ce qui est exactement voulu.
 */
export function bestSegmentsScanMark(at: Date): { bestSegmentsScannedAt: Date } {
  return { bestSegmentsScannedAt: at };
}
