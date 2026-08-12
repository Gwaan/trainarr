/**
 * La **marche/course** des premières semaines d'une reprise.
 *
 * ## Pourquoi ce format-là, et pas un footing plus court
 *
 * Parce que c'est le seul format de reprise qui ait un essai contrôlé randomisé
 * derrière lui : Hottenrott 2016 rapporte, à performance égale, **moins de
 * douleurs et moins de fatigue perçue** qu'une course continue chez des coureurs
 * de loisir. C'est donc un argument de **confort démontré**, et il doit être
 * présenté comme tel — aucune donnée ne montre qu'alterner marche et course
 * prévienne les blessures, et le laisser croire ferait de ce module un vendeur de
 * promesses. Ce qu'on limite par ailleurs (la charge cumulée, la sortie longue,
 * la qualité) est décidé ailleurs, dans `intent.ts`.
 *
 * ## Deux contraintes dures, héritées et non négociables
 *
 * 1. **Toutes les étapes se mesurent en distance** (`distanceM`), jamais en
 *    durée. Mesuré sur la matrice du test de propriété : un déroulé en durée fait
 *    sortir 98,3 % des semaines de leur cible une fois `applyImposedPaces` passé,
 *    parce qu'`imposedDistanceKm` remplace la distance déclarée par la couverture
 *    du déroulé dès qu'elle lui est supérieure. Une séance de marche/course est
 *    justement celle où l'écart serait le pire : la moitié de son déroulé se
 *    parcourt en marchant, à une allure que personne n'impose.
 * 2. **La couverture vaut exactement la distance déclarée.** Les blocs répétés
 *    tombent sur des centaines de mètres et le reliquat part dans un dernier bloc
 *    marché, jamais dans un second arrondi.
 *
 * Les étapes marchées portent le rôle `recover` (ou `cooldown` pour la dernière),
 * qui ne reçoit **aucune cible d'allure** en aval : c'est le comportement existant
 * du post-traitement, et il tombe parfaitement ici — une marche ne se prescrit pas
 * en minutes par kilomètre.
 *
 * Module **pur** et strictement déterministe : le ratio se déduit du rang de la
 * semaine dans la fenêtre de marche/course, ni horloge, ni aléa.
 */

import type { PlanSessionSteps } from '@/lib/plan-steps/schema';

import { distanceStep } from './variations';

/**
 * La part **courue** d'un bloc, du premier au dernier rang de la fenêtre.
 *
 * D'un tiers à deux tiers, soit un ratio course/marche qui ouvre à 1:2 et finit à
 * 2:1. La fenêtre n'est pas une béquille qu'on garde : c'est une rampe qu'on
 * remonte, et à sa sortie l'athlète court deux fois plus qu'elle ne marche —
 * l'étape d'après étant le footing continu des semaines suivantes.
 */
const RUN_SHARE = { from: 1 / 3, to: 2 / 3 } as const;

/**
 * La longueur visée d'un bloc course + marche, en mètres.
 *
 * 600 m, et le chiffre n'est pas indifférent : sur la grille des centaines de
 * mètres — la seule qu'un athlète lise sur sa montre —, 600 est la plus petite
 * longueur qui rende **exactement** les deux ratios visés, 200/400 (1:2) et
 * 400/200 (2:1), en passant par 300/300 (1:1). Un bloc de 500 m ne saurait
 * exprimer que 200/300 et 300/200, soit 2:3 et 3:2 : la rampe y perdrait ses deux
 * bouts.
 */
const CYCLE_M = 600;

/**
 * Le plus grand nombre de répétitions qu'un bloc admet
 * (`PLAN_STEP_BOUNDS.repeat`), et donc le nombre de blocs au-delà duquel il faut
 * les allonger plutôt que les multiplier.
 */
const MAX_CYCLES = 20;

/**
 * En deçà de trois blocs, ce n'est plus une alternance, c'est une séance hachée.
 *
 * Trois blocs de 600 m font 1,8 km : sous ce volume, la séance reste un footing
 * ordinaire — ce qui est le cas des toutes petites semaines, où il n'y a de toute
 * façon pas grand-chose à alterner.
 */
const MIN_CYCLES = 3;

/** Une distance à la centaine de mètres : ce qu'un athlète peut lire sur sa montre. */
function roundHundredM(meters: number): number {
  return Math.round(meters / 100) * 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** La part courue d'un bloc, au rang `rank` d'une fenêtre qui compte `total` semaines. */
function runShare(rank: number, total: number): number {
  // Une fenêtre d'une seule semaine n'a ni début ni fin de rampe : elle reçoit le
  // milieu, comme la rampe de composition (cf. `composition.ts`).
  const progress = total <= 1 ? 0.5 : clamp(rank / (total - 1), 0, 1);
  return RUN_SHARE.from + (RUN_SHARE.to - RUN_SHARE.from) * progress;
}

/** Une séance de marche/course : son titre et son déroulé se décident ensemble. */
export type WalkRunShape = { title: string; steps: PlanSessionSteps };

/**
 * Le déroulé d'une séance de marche/course — `undefined` quand la séance est trop
 * courte pour porter trois blocs ({@link MIN_CYCLES}), auquel cas l'appelant
 * écrit un footing ordinaire.
 *
 * ## Pourquoi la couverture tombe juste
 *
 * Les distances des séances sont arrondies au dixième de kilomètre par la
 * décomposition des budgets : `distanceKm` vaut donc toujours un multiple de
 * 100 m, et `CYCLE_M` en est un aussi. Le reliquat est donc lui-même un multiple
 * de 100 m — soit nul, soit assez grand pour faire un dernier bloc marché lisible.
 * Rien ne se perd et rien ne s'arrondit deux fois.
 *
 * @param distanceKm la distance de la séance, telle que le budget l'a fixée.
 * @param rank le rang (0-based) de la semaine dans la fenêtre de marche/course.
 * @param total la longueur de cette fenêtre, en semaines.
 */
export function walkRunShape(
  distanceKm: number,
  rank: number,
  total: number,
): WalkRunShape | undefined {
  const totalM = Math.round(distanceKm * 1_000);

  // Au-delà de 20 blocs, on allonge le bloc au lieu de le répéter : c'est la
  // borne du contrat des étapes, et vingt répétitions sont de toute façon la
  // limite de ce qu'une séance décrit lisiblement.
  const cycleM =
    totalM / CYCLE_M > MAX_CYCLES ? Math.ceil(totalM / MAX_CYCLES / 100) * 100 : CYCLE_M;
  const cycles = Math.floor(totalM / cycleM);
  if (cycles < MIN_CYCLES) return undefined;

  const runM = clamp(roundHundredM(cycleM * runShare(rank, total)), 100, cycleM - 100);
  const walkM = cycleM - runM;
  const restM = totalM - cycles * cycleM;

  const steps: PlanSessionSteps = [
    {
      repeat: cycles,
      steps: [
        distanceStep('run', runM, 'Portion courue, souple : tu dois pouvoir parler en courant'),
        distanceStep('recover', walkM, 'Marche, sans forcer : laisse le souffle redescendre'),
      ],
    },
  ];
  // Le reliquat de la division, marché : la séance couvre alors exactement sa
  // distance déclarée, et elle se termine sur la partie la moins coûteuse.
  if (restM > 0) {
    steps.push({
      repeat: 1,
      steps: [distanceStep('cooldown', restM, 'Termine en marchant, tranquillement')],
    });
  }

  return {
    title: `Marche/course : ${cycles} × (${runM} m course / ${walkM} m marche)`,
    steps,
  };
}
