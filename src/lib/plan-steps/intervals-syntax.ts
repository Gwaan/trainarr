/**
 * Sérialisation d'une séance structurée dans la **syntaxe native du workout
 * builder d'intervals.icu**.
 *
 * C'est ce qui sépare une séance *lisible* d'une séance *exécutable* : une
 * description en texte plat s'affiche au calendrier et rien de plus, tandis
 * qu'un déroulé écrit dans cette syntaxe est parsé par intervals.icu en étapes,
 * poussé à la montre par l'app Companion, et égrené pas à pas pendant la sortie.
 *
 * Module **pur** (ni base, ni réseau, ni `server-only`) : l'unique consommateur
 * est aujourd'hui la synchronisation du plan (`lib/intervals/push-plan`), mais
 * rien n'interdit de l'appeler depuis un aperçu côté client.
 *
 * ## La syntaxe, telle qu'elle est documentée
 *
 * - Une étape par ligne, préfixée d'un tiret :
 *   `- [intitulé] [durée ou distance] [cible]`.
 * - Durées : `10m` (minutes !), `90s`, `1m30s`. Distances : `2km`, `400mtr` —
 *   `mtr` pour les mètres, jamais `m`, qui vaut « minutes ».
 * - Allure : `4:30/km Pace`, ou une plage `4:25-4:35/km Pace` (la borne rapide,
 *   c'est-à-dire le plus petit nombre de secondes par kilomètre, d'abord).
 * - Zone cardiaque : `Z2 HR`.
 * - Bloc répété : une ligne `3x` seule, puis les étapes du bloc, **encadrée de
 *   lignes vides** — c'est cette séparation qui délimite le bloc pour le
 *   parseur. Pas d'imbrication (le schéma ne l'autorise pas davantage).
 *
 * Ce qui n'a pas de cible ne produit que sa mesure : une étape sans consigne
 * d'allure ni de fréquence cardiaque reste une étape libre, on ne lui invente
 * pas d'intensité.
 *
 * ## Fréquence cardiaque : une plage en bpm, pas un numéro de zone
 *
 * `Z2 HR` référence la **configuration de zones du compte intervals.icu**, que
 * Trainarr ne contrôle pas : si l'athlète y a laissé les zones par défaut d'une
 * montre grand public, le « Z2 » poussé vaudrait 60–70 % de FC max là où le plan
 * en veut 65–79 % (cf. `lib/metrics/hr-targets`). La prescription changerait de
 * sens en chemin, sans que rien ne le signale.
 *
 * Dès que la FC max est connue, la cible part donc en **battements explicites**,
 * sur le modèle exact de la plage d'allure : `120-145 bpm HR`. Elle ne dépend
 * plus d'aucun réglage distant.
 *
 * **Cette forme n'est pas vérifiée empiriquement** sur le compte réel — la
 * documentation du builder n'en donne pas d'exemple, et le parseur n'est pas
 * public. Elle est le décalque de `4:25-4:35/km Pace`, qui est documentée et
 * fonctionne : même position dans la ligne, même ordre des bornes, même suffixe
 * de type (`HR`). Un test la fige pour qu'une correction future soit une
 * décision et non une dérive. Si le parseur la refuse, le repli connu est
 * `Z2 HR` — c'est ce qui sort déjà sans FC max.
 */

import { hrZoneTargetBpm } from '@/lib/metrics/hr-targets';

import { toSingleLine, type PlanSessionSteps, type PlanStep, type PlanStepRole } from './schema';

/**
 * Intitulés de rôle, en ASCII pur.
 *
 * Ils passent devant la mesure, dans la zone que le parseur d'intervals.icu
 * traite comme du texte libre. L'ASCII est de la prudence, pas une nécessité
 * connue : un accent mal digéré en chemin (API, montre) rendrait l'intitulé
 * illisible sur le poignet, et « Echauffement » sans accent y reste
 * parfaitement compréhensible.
 */
const ROLE_LABELS: Record<PlanStepRole, string> = {
  warmup: 'Echauffement',
  run: 'Course',
  recover: 'Recuperation',
  cooldown: 'Retour au calme',
};

/**
 * Allure en `m:ss`, sans unité.
 *
 * `formatPace` de `@/lib/ai/format` rend `4:25/km`, qui ne se compose pas en
 * plage : `4:25/km-4:35/km` n'est pas la syntaxe attendue. D'où cette horloge
 * nue, à laquelle l'unité est ajoutée une seule fois, en fin d'expression.
 */
function paceClock(secPerKm: number): string {
  const total = Math.round(secPerKm);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Durée : `45s`, `10m`, `1m30s`. `m` vaut **minutes** dans cette syntaxe. */
function formatDurationToken(durationS: number): string {
  const total = Math.round(durationS);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;

  if (minutes === 0) return `${seconds}s`;
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}

/**
 * Distance : `2km` pour un compte rond de kilomètres, `400mtr` sinon.
 *
 * Pas de kilomètre décimal (`1.5km`) : le séparateur décimal attendu par le
 * parseur n'est pas documenté, alors que le mètre entier l'est. `1500mtr` dit
 * exactement la même chose sans pari.
 */
function formatDistanceToken(distanceM: number): string {
  const meters = Math.round(distanceM);
  return meters % 1000 === 0 ? `${meters / 1000}km` : `${meters}mtr`;
}

/**
 * La cible de l'étape, ou `null` quand elle n'en porte pas.
 *
 * @param maxHrBpm la FC max du profil : elle seule permet de traduire un rang de
 * zone en battements (cf. l'en-tête). `null` — ou une zone dont le créneau n'est
 * pas déclaré — laisse sortir le `Z<n> HR` d'origine.
 */
function formatTargetToken(step: PlanStep, maxHrBpm: number | null): string | null {
  if (step.paceMinSecPerKm !== null && step.paceMaxSecPerKm !== null) {
    const min = paceClock(step.paceMinSecPerKm);
    // Bornes égales : une allure unique, pas une plage de largeur nulle.
    if (step.paceMinSecPerKm === step.paceMaxSecPerKm) return `${min}/km Pace`;
    return `${min}-${paceClock(step.paceMaxSecPerKm)}/km Pace`;
  }

  if (step.hrZone === null) return null;

  const target = hrZoneTargetBpm(step.hrZone, maxHrBpm);
  if (target === null) return `Z${step.hrZone} HR`;

  return `${target.minBpm}-${target.maxBpm} bpm HR`;
}

/**
 * Une étape, en une ligne.
 *
 * L'ordre est imposé par la syntaxe : intitulé, puis mesure, puis cible. La
 * note du plan prolonge l'intitulé — c'est la consigne que l'athlète doit lire
 * au moment de courir l'étape, sa place est donc devant, pas en commentaire de
 * fin de séance.
 *
 * La note est réécrite sur une seule ligne : le schéma l'impose désormais, mais
 * ce sérialiseur reçoit aussi des `steps` écrits en base avant cette contrainte,
 * et un retour à la ligne y ouvrirait une étape fantôme.
 */
function stepLine(step: PlanStep, maxHrBpm: number | null): string {
  const label = ROLE_LABELS[step.role];
  const note = step.note === null ? '' : toSingleLine(step.note);
  const cue = note === '' ? label : `${label} - ${note}`;

  // Le schéma garantit exactement une des deux mesures.
  const measure =
    step.distanceM !== null
      ? formatDistanceToken(step.distanceM)
      : step.durationS !== null
        ? formatDurationToken(step.durationS)
        : null;

  const parts = [cue, measure, formatTargetToken(step, maxHrBpm)].filter(
    (part): part is string => part !== null,
  );

  return `- ${parts.join(' ')}`;
}

/**
 * Le déroulé complet d'une séance, prêt à être posé dans la description d'un
 * event intervals.icu.
 *
 * Les blocs non répétés (`repeat === 1`) sont rendus à plat : un `1x` serait du
 * bruit, et une ligne vide de séparation inviterait le parseur à découper là où
 * il n'y a rien à découper.
 *
 * @param maxHrBpm la FC max du profil, qui traduit les zones cardiaques en
 * battements explicites (cf. l'en-tête). Omise ou `null` : les zones sortent en
 * `Z<n> HR`, exactement comme avant.
 */
export function stepsToIntervalsSyntax(
  steps: PlanSessionSteps,
  maxHrBpm: number | null = null,
): string {
  const lines: string[] = [];

  /** Une ligne vide, jamais deux d'affilée, jamais en tête. */
  const separate = (): void => {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
  };

  for (const block of steps) {
    if (block.repeat > 1) {
      separate();
      lines.push(`${block.repeat}x`);
      lines.push(...block.steps.map((step) => stepLine(step, maxHrBpm)));
      lines.push('');
      continue;
    }

    lines.push(...block.steps.map((step) => stepLine(step, maxHrBpm)));
  }

  // La ligne vide qui suit un bloc répété final n'a rien à séparer.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  return lines.join('\n');
}
