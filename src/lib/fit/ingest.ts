import 'server-only';

import {
  hasActivityStreams,
  saveActivityStreams,
  upsertActivityFromFit,
  type FitUpsertOutcome,
} from '@/data/activities';
import { recordThresholdBlockLthr } from '@/data/lthr-suggestion';
import { recordSustainedMaxHr } from '@/data/max-hr-suggestion';
import { linkActivityToPlannedSession } from '@/data/plan-reconciliation';
import { maybeApplyFitnessTest } from '@/lib/ai/fitness-test-service';
import { maybeReviewActivePlan } from '@/lib/ai/review-service';
import { sustainedMaxHrBpm } from '@/lib/metrics';
import { notifyActivityAnalyzed } from '@/lib/push/notices';
import { recordActivityWeather } from '@/lib/weather/service';

import { parseFitActivity } from './parse';

/**
 * Ingestion d'un fichier FIT : parsing → écriture en base → séries temporelles.
 *
 * Seul module de `lib/fit` à toucher la base, et uniquement via le DAL (le
 * parseur, lui, reste une fonction pure).
 */

export type IngestReport = {
  /**
   * - `created` : nouvelle activité ;
   * - `updated` : ce fichier avait déjà été importé (même empreinte) ;
   * - `merged` : cette séance était déjà en base, importée depuis un **autre**
   *   fichier — l'activité existante a été complétée, pas dupliquée.
   */
  status: 'created' | 'updated' | 'merged';
  activityId: number;
};

/**
 * Politique des séries temporelles, selon la façon dont le fichier s'est
 * rattaché à la base.
 *
 * **Création ou même fichier → réécriture intégrale.** C'est l'inverse de la
 * politique des colonnes de `activities`, qui ne comble que ses trous — et la
 * raison est la même dans les deux cas : ne jamais perdre une donnée que seul
 * l'humain pouvait produire, toujours rafraîchir celle que seul le fichier
 * produit. Une série temporelle n'est pas éditable dans l'appli ; sa seule
 * source est le fichier, relu ici par la version courante du parseur. Ne
 * réécrire que les activités dépourvues de séries — le comportement d'avant —
 * rendait toute correction du parseur inopérante sur l'historique : redéposer le
 * fichier ne réparait rien.
 *
 * **Même séance, autre fichier → on ne réécrit que s'il n'y a rien.** Un
 * doublon venu d'une autre source n'est pas une meilleure version de la séance :
 * il n'a aucun titre à écraser des séries saines, et rien ne dit qu'il porte les
 * mêmes canaux (une même sortie exportée deux fois peut avoir perdu sa FC en
 * chemin). En revanche, s'il apporte des séries à une activité qui n'en a
 * aucune, il les apporte.
 */
async function shouldRewriteStreams(
  status: IngestReport['status'],
  activityId: number,
  athleteId: number,
): Promise<boolean> {
  if (status !== 'merged') return true;
  return !(await hasActivityStreams(activityId, athleteId));
}

/**
 * Issue du DAL → statut du rapport d'import.
 *
 * Table exhaustive par construction : ajouter une issue à `FitUpsertOutcome`
 * sans lui donner de statut ne compile pas.
 */
const REPORT_STATUS = {
  created: 'created',
  'same-file': 'updated',
  'same-session': 'merged',
} as const satisfies Record<FitUpsertOutcome, IngestReport['status']>;

/**
 * Rapproche l'activité de la séance planifiée qu'elle réalise, quel que soit le
 * statut d'import : l'appel est idempotent et une activité rapprochée le reste.
 *
 * **Le rapprochement n'est pas une condition de l'import**, c'est un
 * enrichissement : la séance est en base, elle ne doit pas repartir en
 * `failed/` parce que la jointure avec le plan a échoué. Le prochain passage
 * (réimport, régénération du plan) rattrapera le lien manquant. En revanche
 * l'échec se journalise avec son type et son message — un silence ici ferait
 * passer « aucun plan rapproché » pour un état normal.
 */
async function linkToPlannedSession(activityId: number, athleteId: number): Promise<void> {
  try {
    await linkActivityToPlannedSession(activityId, athleteId);
  } catch (error) {
    const reason = error instanceof Error ? `${error.name} : ${error.message}` : String(error);
    console.error(`[fit] activité ${activityId} : rapprochement du plan impossible — ${reason}`);
  }
}

/**
 * Relève ce que la séance dit de la **FC seuil**, quand elle réalise une séance
 * de seuil planifiée.
 *
 * **Après le rapprochement**, et ce n'est pas un détail d'ordre : c'est le lien
 * à la séance planifiée qui dit qu'un bloc de seuil a été couru, et quelle
 * longueur il faisait. Sans lui, la mesure n'a aucun point d'ancrage.
 *
 * **Jamais une condition de l'import**, comme le rapprochement et la météo : une
 * séance dont on ne sait pas tirer de plateau cardiaque reste une séance valide,
 * et elle ne doit pas repartir en `failed/` pour ça. L'échec se journalise avec
 * son motif — un silence ferait passer « aucune mesure » pour un état normal
 * alors que c'en est un pour la plupart des séances, mais pas pour toutes.
 */
async function recordThresholdLthr(activityId: number, athleteId: number): Promise<void> {
  try {
    await recordThresholdBlockLthr(activityId, athleteId);
  } catch (error) {
    const reason = error instanceof Error ? `${error.name} : ${error.message}` : String(error);
    console.error(`[fit] activité ${activityId} : mesure de FC seuil impossible — ${reason}`);
  }
}

/**
 * Relève la météo de la séance qui vient d'être importée.
 *
 * **Jamais une condition de l'import**, exactement comme le rapprochement au
 * plan : une séance sans météo reste une séance valide, et elle ne doit pas
 * repartir en `failed/` parce qu'Open-Meteo n'a pas répondu. Le service
 * journalise ses propres motifs et ne lève pas (`[weather]`) ; ce `catch` est un
 * dernier recours.
 *
 * **Attendu**, contrairement au suivi du plan : c'est un unique appel HTTP de
 * quelques dizaines de millisecondes, borné par un délai de garde, et le rendre
 * synchrone garantit que la météo est là quand l'écran de la séance s'ouvre.
 * Ce qui n'aboutit pas est de toute façon repris par la boucle de rattrapage.
 *
 * **Après les séries temporelles**, et ce n'est pas un détail d'ordre : les
 * coordonnées viennent du flux `latlng`, qui n'existe en base qu'une fois
 * `saveActivityStreams` passé.
 */
async function recordWeather(activityId: number, athleteId: number): Promise<void> {
  try {
    await recordActivityWeather(activityId, athleteId);
  } catch (error) {
    const reason = error instanceof Error ? `${error.name} : ${error.message}` : String(error);
    console.error(`[fit] activité ${activityId} : relevé météo impossible — ${reason}`);
  }
}

/**
 * Annonce à l'athlète que sa séance est analysée.
 *
 * **Jamais une condition de l'import**, comme le rapprochement, le seuil et la
 * météo : une bannière qui n'est pas partie ne doit pas renvoyer le fichier en
 * `failed/`. Le service journalise ses propres motifs et ne lève pas
 * (`[push]`) ; ce `catch` est un dernier recours.
 *
 * **Attendu**, contrairement au suivi du plan : quelques lectures indexées et un
 * appel HTTP borné vers le service de push. Le rendre asynchrone n'y gagnerait
 * rien et ferait perdre l'ordre des notifications entre deux fichiers déposés à
 * la suite.
 *
 * **En dernier**, et ce n'est pas un détail d'ordre : le message annonce le
 * rapprochement au plan quand il a eu lieu, et ce lien est posé plus haut par
 * {@link linkToPlannedSession}. Le notifier avant reviendrait à dire « séance
 * hors plan » d'une séance qui vient d'être rattachée.
 */
async function notifyAnalysis(activityId: number, athleteId: number): Promise<void> {
  try {
    await notifyActivityAnalyzed(activityId, athleteId);
  } catch (error) {
    const reason = error instanceof Error ? `${error.name} : ${error.message}` : String(error);
    console.error(`[fit] activité ${activityId} : notification impossible — ${reason}`);
  }
}

/**
 * Confie la séance au plan — **sans attendre** : d'abord le test chronométré
 * qu'elle réalise peut-être, puis la relecture du plan par le coach.
 *
 * Le rapprochement, lui, reste dans le fil de l'import : c'est lui qui décide si
 * la séance vient d'être réalisée. Ces deux-là appellent un modèle de langage et
 * durent des minutes ; les attendre bloquerait le watcher (et le rapatriement
 * intervals.icu derrière lui) sur chaque fichier déposé, pour des décisions qui
 * n'ont aucune influence sur le rapport d'import.
 *
 * **L'ordre compte, et c'est pourquoi ils s'enchaînent au lieu de partir
 * ensemble.** Un test qui améliore le chrono de référence réécrit la fin du
 * plan ; une révision lancée en parallèle relirait un plan en train de changer,
 * et l'une des deux écritures écraserait l'autre. Enchaînés, la révision part
 * sur l'état à jour — et son contrôle de fraîcheur n'a rien à rattraper.
 *
 * **L'athlète leur est passé**, comme à l'ingestion elle-même : ils tournent
 * dans le watcher, hors requête. Le déduire d'une session ne rendait rien, et
 * les deux services s'arrêtaient sans le dire.
 *
 * Les deux services ne lèvent pas et journalisent leurs propres échecs
 * (`[plan/test]`, `[plan/review]`) ; le `catch` est un dernier recours — une
 * promesse abandonnée sans lui ferait remonter un rejet non géré au niveau du
 * process.
 */
function scheduleActivePlanFollowUp(activityId: number, athleteId: number): void {
  void maybeApplyFitnessTest(activityId, athleteId)
    .then(() => maybeReviewActivePlan(athleteId))
    .catch((error: unknown) => {
      console.error('[fit] suivi du plan impossible —', error);
    });
}

/**
 * Importe le contenu d'un fichier FIT **pour un athlète donné**.
 *
 * L'athlète est un **paramètre**, jamais une déduction : c'est l'appelant qui
 * sait à qui appartient le fichier, et lui seul.
 *
 * - l'import manuel (`POST /api/fit/upload`) a une session, donc un athlète ;
 * - le service de fond n'en a pas — il lit le propriétaire dans le chemin du
 *   fichier (un dossier par athlète, cf. `./inbox-layout`).
 *
 * Cette fonction lisait auparavant « l'athlète courant » elle-même. Depuis que
 * l'athlète appartient à un compte, cette lecture répond « l'athlète de la
 * session » — donc rien du tout dans le watcher et le poller, qui tournent sans
 * requête : chaque fichier partait en `failed/`. Le repli qui aurait « réparé »
 * ça (le premier athlète venu) est exactement ce que le cloisonnement par compte
 * interdit.
 *
 * **L'athlète descend jusqu'au bout de la chaîne**, et pas seulement jusqu'ici.
 * Le rapprochement, le test chronométré, la révision du plan et la publication
 * du calendrier le reçoivent tous en paramètre : le donner à l'ingestion sans le
 * donner à ce qu'elle déclenche laissait ces quatre-là résoudre `null` et ne
 * rien faire, sans le moindre échec visible — juste un `[auth] lecture de la
 * session impossible` par fichier importé.
 *
 * Les séries temporelles suivent {@link shouldRewriteStreams}.
 *
 * @throws {FitParseError} si le fichier est illisible — l'erreur remonte telle
 * quelle à l'appelant (le watcher), qui décide du sort du fichier.
 */
export async function ingestFitBuffer(buffer: Buffer, athleteId: number): Promise<IngestReport> {
  const parsed = parseFitActivity(buffer);

  // Le parseur ne masque jamais une perte de données : ce qu'il a dû écarter est
  // tracé ici, sinon le rapport d'import laisserait croire à une lecture parfaite.
  for (const warning of parsed.warnings) {
    console.error(`[fit] ${parsed.fileHash.slice(0, 12)} : ${warning}`);
  }

  const { activityId, outcome } = await upsertActivityFromFit(parsed, athleteId);
  const status = REPORT_STATUS[outcome];

  if (await shouldRewriteStreams(status, activityId, athleteId)) {
    await saveActivityStreams(activityId, athleteId, parsed.streams);
    // **Après** les séries, et sous la même condition : cette mesure dérive du
    // flux cardiaque qu'on vient d'écrire, et n'a de sens qu'accordée à lui. Un
    // fichier dont on n'a pas retenu les séries (doublon venu d'une autre
    // source) n'a pas non plus à décider de la FC max soutenue de la séance.
    await recordSustainedMaxHr(
      activityId,
      athleteId,
      sustainedMaxHrBpm(parsed.streams.heartrate ?? [], parsed.streams.time ?? []),
    );
  }

  await linkToPlannedSession(activityId, athleteId);
  await recordThresholdLthr(activityId, athleteId);
  await recordWeather(activityId, athleteId);
  await notifyAnalysis(activityId, athleteId);
  scheduleActivePlanFollowUp(activityId, athleteId);

  return { status, activityId };
}
