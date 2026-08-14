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
 * - Fréquence cardiaque : `65-79% HR` — cf. la section dédiée.
 * - Bloc répété : une ligne `3x` seule, puis les étapes du bloc, **encadrée de
 *   lignes vides** — c'est cette séparation qui délimite le bloc pour le
 *   parseur. Pas d'imbrication (le schéma ne l'autorise pas davantage).
 *
 * Ce qui n'a pas de cible ne produit que sa mesure : une étape sans consigne
 * d'allure ni de fréquence cardiaque reste une étape libre, on ne lui invente
 * pas d'intensité.
 *
 * ## Fréquence cardiaque : forme vérifiée empiriquement le 12/08/2026 sur le compte réel
 *
 * Le `workout_doc` envoyé avec un event est **ignoré** : intervals.icu le
 * régénère depuis le texte de `description`. Le dialecte textuel est donc le seul
 * canal, et une cible qu'il ne parse pas est du texte mort — elle s'affiche au
 * calendrier et la montre n'en voit rien, ni plage ni alerte.
 *
 * 29 events de test ont été poussés sur le compte réel puis relus (champ
 * `workout_doc.steps[].hr` de l'event enregistré) avant d'être supprimés. Ce qui
 * en ressort :
 *
 * | Forme écrite      | Ce qu'intervals.icu en fait                 |
 * |-------------------|---------------------------------------------|
 * | `65-79% HR`       | `hr {start:65, end:79, units:"%hr"}` — pourcentage de la **FC max du compte** |
 * | `65-79% LTHR`     | `units:"%lthr"` — pourcentage du **seuil**  |
 * | `Z2 HR`           | `units:"hr_zone"` — les **zones du compte** |
 * | `65-79% MaxHR`    | **`power {units:"%ftp"}`** — de la puissance |
 * | `65-79% HRmax`    | idem : puissance                            |
 * | `65-79% Max HR`   | idem : puissance                            |
 * | `120-145 bpm HR`, `120-145bpm`, `145bpm`, `HR 120-145`, `120-145hr` | **rien** : aucune cible |
 *
 * Trois conséquences, dans cet ordre :
 *
 * 1. **Aucune forme en bpm absolus ne parse.** La cible ne peut partir qu'en
 *    pourcentage, quelle que soit l'envie qu'on ait d'écrire des battements.
 * 2. **Le suffixe est porteur, et `MaxHR` est un piège** : il a l'air du plus
 *    explicite des trois, et c'est le seul qui quitte le domaine cardiaque pour
 *    atterrir en puissance — une cible silencieusement fausse, sur une grandeur
 *    qu'une coureuse ne mesure même pas. Seuls ` HR` et ` LTHR` atteignent la FC.
 *    Un test le fige.
 * 3. **`Z2 HR` est écarté** : il référence la configuration de zones du compte,
 *    que Trainarr ne contrôle pas. Mesuré sur ce compte, il vaut 77–81 % de la FC
 *    max là où le plan en veut 65–79 % (cf. `lib/metrics/hr-targets`) — la
 *    prescription changerait de sens en chemin, sans que rien ne le signale.
 *
 * ## Le pourcentage émis est celui de **leur** FC max, pas de la nôtre
 *
 * `% HR` se résout sur la FC max du compte intervals.icu, et rien ne dit qu'elle
 * égale celle du profil Trainarr : celui de cette athlète porte 205, sa vraie FC
 * max est 184. Écrire les 65–79 % du créneau prescrit tel quel donnerait
 * 133–162 bpm à la montre — du seuil au lieu d'une endurance.
 *
 * La chaîne est donc : la zone se résout en **battements** sur la référence du
 * profil (`hrZoneTargetBpm`, source unique de vérité — FC seuil si l'athlète en
 * a adopté une, FC max sinon), puis ces battements se
 * ramènent en pourcentage de la FC max **distante**, lue à chaque publication
 * (`hrTargetPercentOfMax`). 120–145 bpm deviennent `59-71% HR` sur une référence
 * de 205, `65-79% HR` sur une référence de 184 : la même prescription, exprimée
 * dans les termes du destinataire.
 *
 * Le point de départ de cette chaîne est la cible **de l'étape**
 * (`stepHrTargetBpm`), sous-créneau compris : une fin de sortie longue qui vise
 * le haut de l'endurance (74–79 % du profil, soit 136–145 bpm à 184) part en
 * `66-71% HR` sur une référence de 205, quand le reste du parcours part en
 * `59-71% HR`. Sans cela, la montre affichait la même plage du premier au
 * dernier kilomètre.
 *
 * ## Sans référence distante, pas de cible cardiaque du tout
 *
 * Si la FC max distante manque — API en erreur, champ absent, valeur aberrante —
 * l'étape ne reçoit **aucune** cible de fréquence cardiaque. Ni `Z2 HR`, dont on
 * sait qu'il prescrit autre chose, ni un pourcentage calculé sur une référence
 * devinée. Une cible fausse est pire qu'une cible absente : elle se surveille.
 * Ce qui reste est ce qui a toujours fonctionné — la mesure de l'étape, et sa
 * cible d'allure quand elle en porte une.
 */

import { hrTargetPercentOfMax } from '@/lib/metrics/hr-targets';
import type { HrZoneAnchor } from '@/lib/metrics/hr-zones';

import { stepHrTargetBpm } from './hr-target';
import { toSingleLine, type PlanSessionSteps, type PlanStep, type PlanStepRole } from './schema';

/**
 * Les deux fréquences cardiaques maximales que la sérialisation doit tenir
 * ensemble — cf. l'en-tête.
 *
 * Elles ne jouent pas le même rôle et ne sont pas interchangeables : la première
 * **prescrit**, la seconde **traduit**.
 */
export type HrReference = {
  /**
   * La référence du profil Trainarr — FC seuil si l'athlète en a adopté une, FC
   * max sinon —, seule source de la prescription : c'est elle qui dit à quels
   * battements se court la zone.
   */
  profileAnchor: HrZoneAnchor | null;
  /**
   * La FC max que porte le compte intervals.icu, lue à la publication : le
   * dénominateur du pourcentage émis, et rien d'autre.
   */
  intervalsMaxHrBpm: number | null;
};

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
 * La cible de l'étape, ou `null` quand elle n'en porte pas — et **jamais** une
 * cible qu'on ne sait pas exprimer.
 *
 * L'allure passe devant : elle est absolue, elle ne dépend d'aucun réglage
 * distant, et une étape qui en porte une est prescrite en allure. Le suffixe
 * cardiaque est écrit ` HR` et rien d'autre — ` MaxHR` partirait en puissance
 * (cf. l'en-tête).
 *
 * @param hr les deux FC max, celle qui prescrit et celle qui traduit. `null`,
 * l'une manquante, hors bornes, ou une zone sans créneau de prescription
 * déclaré : l'étape sort **sans** cible cardiaque.
 */
function formatTargetToken(step: PlanStep, hr: HrReference | null): string | null {
  if (step.paceMinSecPerKm !== null && step.paceMaxSecPerKm !== null) {
    const min = paceClock(step.paceMinSecPerKm);
    // Bornes égales : une allure unique, pas une plage de largeur nulle.
    if (step.paceMinSecPerKm === step.paceMaxSecPerKm) return `${min}/km Pace`;
    return `${min}-${paceClock(step.paceMaxSecPerKm)}/km Pace`;
  }

  if (hr === null) return null;

  // La cible de l'étape, sous-créneau compris : un bloc qui vise le haut de
  // l'endurance doit partir sur ses propres bornes, sinon la fin appuyée d'une
  // sortie longue arrive sur la montre avec la cible du reste du parcours.
  const target = stepHrTargetBpm(step, hr.profileAnchor);
  if (target === null) return null;

  const percent = hrTargetPercentOfMax(target, hr.intervalsMaxHrBpm);
  if (percent === null) return null;

  return `${percent.minPercent}-${percent.maxPercent}% HR`;
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
function stepLine(step: PlanStep, hr: HrReference | null): string {
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

  const parts = [cue, measure, formatTargetToken(step, hr)].filter(
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
 * @param hr les deux FC max qui rendent une cible cardiaque exprimable (cf.
 * l'en-tête). Omise ou incomplète : les étapes ciblées en zone sortent sans
 * cible, plutôt qu'avec une cible que Trainarr ne contrôle pas.
 */
export function stepsToIntervalsSyntax(
  steps: PlanSessionSteps,
  hr: HrReference | null = null,
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
      lines.push(...block.steps.map((step) => stepLine(step, hr)));
      lines.push('');
      continue;
    }

    lines.push(...block.steps.map((step) => stepLine(step, hr)));
  }

  // La ligne vide qui suit un bloc répété final n'a rien à séparer.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  return lines.join('\n');
}
