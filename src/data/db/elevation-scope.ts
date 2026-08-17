/**
 * Ce qu'est une activité « dont le dénivelé reste à établir », et comment il
 * s'écrit — en SQL, sans `server-only`.
 *
 * Ce module existe pour la même raison que `./best-segments-scope` : **deux
 * écrivains qui ne peuvent pas partager de code applicatif** doivent pourtant
 * s'accorder au critère près.
 *
 * - le rattrapage (`scripts/backfill-elevation.ts`) tourne hors serveur, comme
 *   `migrate.ts` : il n'importe ni `server-only`, ni le client applicatif, ni le
 *   DAL ;
 * - le DAL (`recordActivityElevation`, appelé par l'ingestion) écrit la même
 *   chose pour les imports à venir.
 *
 * Si les deux divergeaient — sur la politique d'écriture, ou sur la marque de
 * balayage — une séance pourrait rester éternellement sélectionnée par le
 * rattrapage, ou recevoir deux dénivelés différents selon le chemin par lequel
 * elle est entrée en base. D'où une définition unique, ici, importée par les
 * deux.
 *
 * Aucun `import 'server-only'`, et **aucun import par alias `@/`** : ce fichier
 * est chargé par `tsx` hors du build Next (même contrainte que
 * `./best-segments-scope` et `scripts/seed.ts`).
 */

import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';

import type { ElevationChange } from '../../lib/metrics/elevation';

import { activities, activityStreams } from './schema';

/** L'activité porte le flux d'altitude dont le repli a besoin. */
const HAS_ALTITUDE_STREAM = sql`exists (
  select 1 from ${activityStreams}
  where ${activityStreams.activityId} = ${activities.id}
    and ${activityStreams.type} = 'altitude'
)`;

/**
 * La paire de dénivelés est **vide des deux côtés** : rien n'est encore su du
 * relief de cette séance, et c'est la seule situation où le repli écrit (cf.
 * {@link elevationWrite}, qui porte la justification de l'atomicité de la
 * paire).
 *
 * **Une seule définition pour le prédicat et pour l'écriture** : c'est
 * exactement la raison d'être de ce module. Un prédicat plus large que ce que
 * l'écrivain sait faire annoncerait du travail qui ne produirait rien, et le
 * rattrapage journaliserait « aucun dénivelé calculable » là où il a en fait
 * refusé d'en écrire un.
 */
const PAIR_IS_EMPTY = sql`(${activities.elevationGainM} is null and ${activities.elevationLossM} is null)`;

/**
 * L'activité n'a **jamais été balayée**. C'est la condition qui garantit la
 * terminaison, cf. {@link pendingElevationWhere}.
 */
const NEVER_SCANNED = isNull(activities.elevationScannedAt);

/**
 * Les activités dont le dénivelé reste à établir — clause `where` sur
 * `activities`.
 *
 * ## « En attente » veut dire « personne n'a regardé »
 *
 * C'est la leçon que le dépôt vient d'écrire à propos des meilleurs efforts (cf.
 * `.claude/rules/data-import.md`, « Ce qui se recalcule, ce qui se persiste ») :
 * **un rattrapage doit pouvoir finir**. Un prédicat bâti sur les seules
 * conditions de *possibilité* — un flux d'altitude existe, les colonnes sont
 * vides — laisse entrer des séances que le rattrapage ne peut pas en faire
 * sortir : un canal d'altitude présent mais entièrement `null` (import indoor),
 * non numérique (import ancien) ou réduit à une seule mesure exploitable ne
 * produit aucun dénivelé, donc aucune écriture, donc une séance resélectionnée
 * pour toujours.
 *
 * Le prédicat s'ancre donc sur une **marque persistée**,
 * `activities.elevation_scanned_at`, que les deux écrivains posent dans la même
 * écriture que les colonnes — y compris quand celle-ci n'écrit aucun dénivelé.
 * Une séance balayée sort du prédicat quel qu'ait été le résultat : le compteur
 * décroît strictement, donc il atteint zéro.
 *
 * ## Les conditions, et ce qu'elles disent chacune
 *
 * 1. **un flux d'altitude en base** : c'est la seule source du repli. Une
 *    séance qui n'en a pas (tapis de course, doublon dont on n'a pas retenu les
 *    séries) ne donnera jamais rien — elle n'a pas à gonfler le travail annoncé,
 *    et sa colonne reste `NULL`, ce qui est la réponse honnête ;
 * 2. **les deux sens manquants** : dès que l'un des deux est connu, la paire
 *    appartient à sa source et le repli n'y touche plus (cf.
 *    {@link elevationWrite}) — il n'y a donc rien à établir, et annoncer la
 *    séance comme « en attente » promettrait un rattrapage qui ne ferait rien ;
 * 3. **jamais balayée** : c'est elle qui porte la terminaison.
 *
 * **Tous les sports.** Le dénivelé se lit sur une sortie vélo comme sur un
 * footing, et la colonne alimente le résumé de la séance autant que la
 * correction d'altitude de la VO₂max (course à pied seulement, elle).
 *
 * **`athleteId` est facultatif** : le rattrapage balaie la base entière sans
 * avoir à énumérer les comptes, et chaque ligne écrite reste celle de son
 * propriétaire — c'est une colonne de `activities`, pas une table à part.
 */
export function pendingElevationWhere(athleteId?: number): SQL | undefined {
  return and(
    athleteId === undefined ? undefined : eq(activities.athleteId, athleteId),
    HAS_ALTITUDE_STREAM,
    PAIR_IS_EMPTY,
    NEVER_SCANNED,
  );
}

/**
 * Ce que les deux écrivains posent sur la ligne d'activité — de quoi alimenter
 * un `update(activities).set(…)`.
 *
 * **Complétion, jamais écrasement** : une valeur déjà en base reste intacte.
 * C'est la politique de tout ce qu'un réimport touche sur `activities` (cf.
 * `completableFields`) — le fichier comble les trous, il n'écrase pas ce qui est
 * déjà su. Le champ `total_ascent` d'une session FIT reste donc prioritaire sur
 * le calcul depuis le flux, qui n'est qu'un repli.
 *
 * ## D+ et D− sont une **paire**, pas deux colonnes indépendantes
 *
 * D'où le `case … PAIR_IS_EMPTY …` plutôt que deux `coalesce` séparés. Un
 * `coalesce` par colonne complétait chaque sens isolément, et produisait une
 * paire mixte dès qu'un appareil écrivait `total_ascent` sans son pendant :
 * **D+ selon l'algorithme de la montre, D− selon notre hystérésis de 1 m**. Sur
 * une boucle qui revient à son altitude de départ, cela persistait des valeurs
 * telles que D+ 45 / D− 32 — deux filtres différents affichés côte à côte, et
 * surtout une paire incohérente donnée à la formule de Greif, qui les additionne
 * pondérées (`+2 m` par mètre monté, `−1 m` par mètre descendu). L'écart entre
 * les deux filtres se retrouvait alors intégralement dans la distance
 * équivalente, donc dans la VO₂max.
 *
 * La politique « complétion, jamais écrasement » a été pensée pour des colonnes
 * indépendantes ; celles-ci ne le sont pas. **Le repli ne remplit donc la paire
 * que si elle est entièrement vide**, et une paire à moitié dite par le fichier
 * le reste : `correctedDistanceM` (`lib/metrics/elevation-correction.ts`) refuse
 * déjà de corriger quand un sens manque, ce qui est exactement la conclusion
 * juste — « dénivelé inconnu ⇒ aucune correction », jamais une correction
 * calculée sur une paire dépareillée.
 *
 * **L'alternative écartée** était de prendre les deux sens du flux dès que le
 * fichier n'en donne qu'un : elle rendait bien une paire cohérente, mais au prix
 * d'écraser un `total_ascent` mesuré par l'appareil avec notre propre filtre —
 * l'application aurait affiché un D+ différent de celui de la montre sur une
 * séance où la montre l'avait bel et bien écrit. Perdre la correction d'altitude
 * sur ces séances-là est le moindre mal : c'est le comportement d'avant qu'elle
 * existe, et il ne ment sur rien.
 *
 * Le test se lit sur la **ligne d'avant** (Postgres évalue les expressions du
 * `SET` contre l'ancien tuple) : les deux colonnes voient donc le même verdict,
 * et deux écritures concurrentes ne peuvent pas en dépareiller une.
 *
 * **La marque est posée dans tous les cas**, y compris quand `change` est `null`
 * (rien de calculable) : c'est elle qui fait sortir la séance du prédicat, et
 * c'est tout l'objet de cette fonction que de rendre l'oubli impossible.
 */
export function elevationWrite(
  change: ElevationChange | null,
  at: Date,
): { elevationGainM?: SQL; elevationLossM?: SQL; elevationScannedAt: Date } {
  if (change === null) return { elevationScannedAt: at };

  return {
    elevationGainM: sql`case when ${PAIR_IS_EMPTY} then ${change.gainM} else ${activities.elevationGainM} end`,
    elevationLossM: sql`case when ${PAIR_IS_EMPTY} then ${change.lossM} else ${activities.elevationLossM} end`,
    elevationScannedAt: at,
  };
}
