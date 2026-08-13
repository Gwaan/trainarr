/**
 * Le **test chronométré** comme séance de la périodisation : où il tombe, ce
 * qu'il coûte à la semaine, et ce qu'il se court.
 *
 * ## Pourquoi ce module existe, et pourquoi il est sûr
 *
 * Un plan sans échéance dérive toutes ses allures d'un **chrono de référence**
 * déclaré à la création. Ce chrono ne bouge jamais : l'athlète progresse, le
 * plan reste calé sur ce qu'elle valait le premier jour, et devient
 * progressivement trop facile. La réadaptation automatique, elle, ne sait
 * ajuster les volumes qu'à la baisse — il manque le chaînon qui fait qu'un plan
 * suit la progression de celle qui le court.
 *
 * **La distinction qui rend ce chantier sûr, et qui doit rester écrite ici** :
 * le cliquet dangereux qu'on a mesuré ailleurs (42 → 215 km en neuf
 * réadaptations) était « tu as couru ce que je t'ai prescrit, donc je prescris
 * plus » — une boucle fermée sur l'obéissance, où la prescription se nourrit
 * d'elle-même. Un test chronométré est une **mesure externe** : sa sortie ne
 * dépend pas de ce que le plan a prescrit, elle dépend de ce que l'athlète vaut
 * ce jour-là. Aucune boucle, donc aucun emballement possible. C'est pour cela
 * que la mise à jour du chrono est légitime ici et ne l'était pas là-bas.
 *
 * ## Ce qui fonde la forme et la cadence
 *
 * - **Le VDOT de Daniels se calcule à partir de toute performance récente**, un
 *   test de terrain compris (*Daniels' Running Formula*) — ce n'est pas un
 *   contournement de sa méthode, c'est sa méthode. Il pose une cadence : **pas
 *   plus d'une mise à jour toutes les 4 à 6 semaines**, d'où
 *   {@link FITNESS_TEST_CADENCE_WEEKS} et le plancher qui l'accompagne
 *   ({@link firstEvaluableTestWeek}, compté en **jours** parce que c'est là
 *   qu'il se vérifie).
 * - **Un 5 km, et pas autre chose.** Scudamore et al. (*J Strength Cond Res*,
 *   2017) : l'allure de seuil dérivée d'un 5 km chronométré est fiable à tous
 *   les niveaux (« pTH can be confidently used for threshold training
 *   regardless of the ability level »). Ils relèvent aussi que le VDOT
 *   **sous-estime** la VO2max, surtout chez les coureurs récréatifs — l'erreur
 *   tombe donc du côté prudent, ce qui est exactement le côté qu'on veut quand
 *   la conséquence est une prescription d'allures.
 * - **Lacune assumée** : aucun essai contrôlé ne montre qu'un plan avec tests
 *   intégrés bat un plan sans. C'est une pratique consensuelle d'entraîneur,
 *   pas une intervention validée. Le dire ici plutôt que de laisser croire à
 *   une preuve qui n'existe pas.
 *
 * ## Ce que le test coûte à la semaine
 *
 * Il **remplace** un créneau de qualité, il ne s'y ajoute pas : un 5 km à fond
 * est une séance dure, et deux séances dures de plus dans la même semaine
 * seraient une séance dure et une séance courue fatiguée. Son budget
 * kilométrique sort donc de la décomposition existante — à ceci près qu'un
 * créneau de qualité pèse 15 à 19 % de la semaine (4,5 km sur 30) quand un test
 * en pèse {@link FITNESS_TEST_SESSION_KM}. La différence est **prise aux
 * footings** de la semaine, jamais à la sortie longue, et la somme ne bouge pas
 * d'un dixième : la semaine retombe sur sa cible ({@link fitnessTestBudgets}).
 *
 * Module **pur** : ni base, ni réseau, ni `server-only`, ni horloge, ni aléa.
 * Tout ce qu'il rend est fonction de la périodisation et des budgets — c'est ce
 * qui permet à une reconstruction de fin de plan de retrouver exactement le
 * test que la création avait posé.
 */

import type { SessionBudget } from '@/lib/ai/format';
import { PLAN_OUTPUT_BOUNDS } from '@/lib/ai/plan-schema';
import { REFERENCE_UPDATE_MIN_GAP_DAYS } from '@/lib/metrics/fitness-test';
import type { PlanSessionSteps } from '@/lib/plan-steps/schema';

import { intentRunsFitnessTests, type PlanIntent } from './intent';
import type { PlanPhase } from './phases';
import { distanceStep } from './variations';

/**
 * Le `kind` d'un test, tel qu'il sera écrit et relu.
 *
 * « Test 5 km » plutôt que « Test » : c'est ce que l'athlète lit sur sa
 * timeline, et le format *est* l'information — un test de 5 km et un test de
 * 10 km ne se courent pas pareil.
 *
 * Ce libellé est lu par trois mécanismes en aval, et aucun n'est un hasard :
 *
 * - `RACE_DAY_PATTERN` (`plan-schema.ts`) reconnaît `\btest\b` et range la
 *   séance **hors endurance** — sans quoi son enveloppe ne recevrait aucune
 *   cible et le tout passerait pour un footing ;
 * - `TEST_KIND_PATTERN`, au même endroit, coupe ensuite **toute cible** sur le
 *   corps de la séance : un effort maximal libre ne se prescrit ni en allure ni
 *   en fréquence cardiaque, il se court à fond. Seuls l'échauffement et le
 *   retour au calme gardent leur plage d'endurance ;
 * - `isIntensitySession` ne le reconnaît pas comme séance de qualité, ce qui
 *   est juste : le déroulé du test est écrit ici, entièrement, et n'a rien à
 *   faire remplir par le modèle.
 */
export const FITNESS_TEST_KIND = 'Test 5 km';

/** Le titre lu sur la timeline : ce qu'on demande, en clair. */
export const FITNESS_TEST_TITLE = 'Test chronométré : 5 km à fond';

/**
 * La distance de l'effort, en mètres — l'invariant de tout le chantier.
 *
 * 5 000 m parce que c'est le format qui alimente directement le VDOT (cf.
 * l'en-tête) et parce qu'il tient dans une semaine ordinaire : un 10 km à fond
 * coûterait une semaine entière de récupération.
 */
export const FITNESS_TEST_EFFORT_M = 5_000;

/**
 * L'échauffement, en mètres.
 *
 * 1,5 km : de quoi arriver chaud sur la ligne sans avoir entamé la séance. Plus
 * court, le premier kilomètre du test sert d'échauffement et fausse le chrono ;
 * plus long, le test empiète sur les footings de la semaine plus qu'il ne le
 * fait déjà.
 */
const FITNESS_TEST_WARMUP_M = 1_500;

/** Le retour au calme, en mètres — un kilomètre trotté, pas une séance de plus. */
const FITNESS_TEST_COOLDOWN_M = 1_000;

/**
 * Ce que la séance de test pèse au total, en kilomètres — enveloppe comprise.
 *
 * C'est le chiffre que le budget de la semaine doit financer, et il ne se
 * négocie pas : les trois blocs sont ce qu'un test demande, et un test amputé
 * de son échauffement n'est plus une mesure.
 */
export const FITNESS_TEST_SESSION_KM =
  (FITNESS_TEST_WARMUP_M + FITNESS_TEST_EFFORT_M + FITNESS_TEST_COOLDOWN_M) / 1_000;

/**
 * La cadence nominale entre deux tests, en semaines.
 *
 * Cinq : le milieu de la fourchette de Daniels (4 à 6 semaines). Comme la
 * recherche du test suivant part de ce pas **et n'avance qu'en avant**, deux
 * tests ne peuvent jamais être séparés de moins de cinq semaines. En jours —
 * l'unité où la cadence se vérifie réellement —, cela fait 35 jours à jour de
 * placement égal, et **29 au pire écart** (le premier test un dimanche, le
 * suivant un lundi) : toujours au-dessus des
 * {@link REFERENCE_UPDATE_MIN_GAP_DAYS}. Le plancher entre deux tests est donc
 * tenu par construction, sans garde supplémentaire ; celui du **premier** test,
 * qui se compte depuis le départ du plan, est l'affaire de
 * {@link firstEvaluableTestWeek}.
 */
export const FITNESS_TEST_CADENCE_WEEKS = 5;

/**
 * La première semaine du plan capable de porter un test **évaluable**, 1-based.
 *
 * ## Le défaut que cette fonction existe pour fermer
 *
 * Le placement se décide en **semaines**, la cadence de Daniels se vérifie en
 * **jours** ({@link REFERENCE_UPDATE_MIN_GAP_DAYS}, 28) : deux unités, et rien
 * ne les alignait. Un plancher posé « en semaine 4 » laissait le test tomber 23
 * jours après le départ un lundi, 17 un dimanche — sous les 28 exigés dans les
 * deux cas. Le plan prescrivait un 5 km à fond, retirait un créneau de qualité
 * pour le financer, et `fitnessTestVerdict` jetait le résultat en `too-soon`.
 * Le premier test de **chaque** plan était perdu, et sur huit semaines la
 * fonctionnalité entière l'était.
 *
 * La borne se calcule donc en jours, une bonne fois :
 *
 * - la semaine `N` du plan commence le lundi qui tombe `(N − 1) × 7` jours après
 *   l'**ancre** (le lundi de la semaine du départ) ;
 * - le départ, lui, est `firstWeekFromDay − 1` jours après cette même ancre ;
 * - le jour le plus tôt que la semaine `N` puisse porter est donc à
 *   `(N − 1) × 7 − (firstWeekFromDay − 1)` jours du départ.
 *
 * On demande que **ce jour-là déjà** satisfasse la cadence, et non le jour
 * effectivement retenu : le placement dans la semaine est choisi plus tard
 * ({@link pickFitnessTestDay}), à partir de réglages que la périodisation ne
 * voit pas. Un test posé est ainsi évaluable quel que soit le jour de départ
 * **et** le jour de placement.
 *
 * En pratique : semaine 5 pour un départ le lundi, semaine 6 pour tous les
 * autres jours de départ.
 *
 * Ce plancher ne joue qu'au **premier** test — le chrono de référence a été
 * déclaré au premier jour du plan, et c'est de là que la cadence se compte.
 * Entre deux tests, c'est {@link FITNESS_TEST_CADENCE_WEEKS} (cinq semaines,
 * soit 29 jours au pire écart de placement) qui la tient par construction.
 *
 * Il ferme aussi, en passant, la première semaine du plan — souvent entamée, et
 * dont on ignore ce qui y a été couru avant le départ.
 *
 * @param firstWeekFromDay le jour ISO du **départ du plan** (1 = lundi).
 */
export function firstEvaluableTestWeek(firstWeekFromDay: number): number {
  return 1 + Math.ceil((REFERENCE_UPDATE_MIN_GAP_DAYS + firstWeekFromDay - 1) / 7);
}

/**
 * Les phases qui peuvent porter un test.
 *
 * Trois exclusions, et chacune tient à ce que la phase **est** :
 *
 * - `partial`, la première semaine déjà entamée : on ignore ce qui y a été
 *   couru avant le départ du plan, et un test derrière deux jours inconnus ne
 *   mesure rien ;
 * - `taper`, l'affûtage : il retire du volume pour arriver frais le jour J, et
 *   un 5 km à fond au milieu défait exactement ce qu'il construit ;
 * - `race`, la semaine de la course : la séance dure de cette semaine-là est la
 *   course.
 */
const TEST_ELIGIBLE_PHASES: readonly PlanPhase[] = ['base', 'build', 'specific'];

/** Un kilométrage en dixièmes de kilomètre — la précision exacte des budgets. */
function tenths(km: number): number {
  return Math.round(km * 10);
}

/** La semaine de rang `index` (0-based dans le plan) peut-elle porter un test ? */
function isEligible(phases: readonly PlanPhase[], index: number, minWeek: number): boolean {
  // Pas avant la première semaine évaluable ({@link firstEvaluableTestWeek}),
  // ce qui écarte au passage la première semaine, souvent entamée.
  if (index + 1 < minWeek) return false;
  // Ni sur la **dernière** semaine du plan : un test dont le résultat n'a plus
  // une seule semaine à recalibrer n'est pas une mesure dans un plan, c'est une
  // mesure après lui. Il coûterait une séance dure pour rien.
  if (index >= phases.length - 1) return false;
  return TEST_ELIGIBLE_PHASES.includes(phases[index]);
}

/**
 * Les semaines du **plan** qui portent un test, par leur numéro 1-based — vide
 * quand l'intention n'en programme aucun ({@link intentRunsFitnessTests}).
 *
 * ## Où le premier tombe, et pourquoi là
 *
 * À la **fin de la phase de base**. C'est le premier moment du plan où une
 * mesure veut dire quelque chose : le socle aérobie est posé, l'athlète a
 * quelques semaines de régularité derrière elle, et le chiffre obtenu servira
 * d'ancre à tout le développement qui suit. Le mesurer plus tôt reviendrait à
 * chronométrer une reprise.
 *
 * Faute de base éligible — une base trop courte, ou entièrement contenue dans
 * les semaines que {@link firstEvaluableTestWeek} ferme —, c'est la première
 * semaine éligible qui sert d'ancre : le plan garde un test plutôt qu'aucun. Et
 * quand aucune semaine ne l'est, il n'en porte aucun — un plan de cinq semaines
 * n'a pas de place pour une mesure qui veuille dire quelque chose.
 *
 * ## Les suivants
 *
 * Tous les {@link FITNESS_TEST_CADENCE_WEEKS}, en sautant ce que la
 * périodisation refuse ({@link TEST_ELIGIBLE_PHASES}). La recherche n'avance
 * jamais en arrière : l'écart entre deux tests est donc au moins la cadence,
 * jamais moins.
 *
 * ## Fonction du **plan**, jamais de la fenêtre
 *
 * C'est le contrat qui fait qu'un test tombe à la même semaine calendaire qu'il
 * soit écrit à la création ou par une réadaptation. Les phases attendues ici
 * sont celles du **plan entier** ; une reconstruction les calcule sur le plan
 * (`remainingComposition`) et passe le résultat au squelette, exactement comme
 * elle le fait déjà pour la rampe de composition et le rang plan-relatif des
 * semaines.
 *
 * @param phases une phase par semaine du **plan entier**, dans l'ordre.
 * @param firstWeekFromDay le jour ISO du départ du **plan**, dont dépend la
 * première semaine évaluable ({@link firstEvaluableTestWeek}). Celui du plan, et
 * jamais celui d'une fenêtre reconstruite : la cadence se compte depuis le
 * premier jour du plan, où le chrono de référence a été déclaré.
 */
export function fitnessTestWeekNumbers(
  intent: PlanIntent,
  phases: readonly PlanPhase[],
  firstWeekFromDay: number,
): number[] {
  if (!intentRunsFitnessTests(intent)) return [];

  const minWeek = firstEvaluableTestWeek(firstWeekFromDay);

  let anchor = -1;
  for (let index = phases.length - 1; index >= 0; index -= 1) {
    if (phases[index] === 'base' && isEligible(phases, index, minWeek)) {
      anchor = index;
      break;
    }
  }
  if (anchor < 0) {
    anchor = phases.findIndex((_, index) => isEligible(phases, index, minWeek));
  }
  if (anchor < 0) return [];

  const weeks = [anchor + 1];
  let last = anchor;
  for (;;) {
    let next = last + FITNESS_TEST_CADENCE_WEEKS;
    while (next < phases.length && !isEligible(phases, next, minWeek)) next += 1;
    if (next >= phases.length) break;
    weeks.push(next + 1);
    last = next;
  }

  return weeks;
}

/**
 * Le déroulé d'un test : échauffement, les 5 km, retour au calme.
 *
 * **Étapes en distance**, comme tout ce que ce module écrit : le
 * post-traitement recalcule la distance d'une séance depuis la couverture de
 * son déroulé et remplace la distance déclarée dès que le déroulé couvre plus
 * (`imposedDistanceKm`). Un déroulé mesuré en minutes ferait sortir la semaine
 * de sa cible — c'est le piège mesuré à 98,3 % sur les créneaux de qualité (cf.
 * l'en-tête de `skeleton.ts`).
 *
 * **Couverture exacte** : les trois blocs totalisent
 * {@link FITNESS_TEST_SESSION_KM}, qui est aussi la distance déclarée par la
 * séance. Rien en aval n'a donc à arbitrer entre les deux.
 *
 * **Aucune cible sur le bloc d'effort**, et c'est tout l'objet du test : une
 * allure prescrite sur un effort maximal serait une contradiction dans les
 * termes, et une cible cardiaque dirait de ralentir au moment précis où l'on
 * demande de tout donner. C'est `TEST_KIND_PATTERN` (`plan-schema.ts`) qui le
 * garantit en aval ; ici, on n'écrit simplement rien — comme partout ailleurs
 * dans ce module, les allures ne s'écrivent pas à la source.
 *
 * La note du bloc d'effort ne nomme **aucun créneau** que `STEP_NOTE_ZONES`
 * saurait reconnaître (« seuil », « allure objectif »…) : elle en poserait un,
 * et le test recevrait la cible qu'on vient de lui refuser.
 */
export function fitnessTestSteps(): PlanSessionSteps {
  return [
    {
      repeat: 1,
      steps: [
        distanceStep(
          'warmup',
          FITNESS_TEST_WARMUP_M,
          'Échauffement confortable, puis 3 ou 4 accélérations de 20 s avant de partir',
        ),
      ],
    },
    {
      repeat: 1,
      steps: [
        distanceStep(
          'run',
          FITNESS_TEST_EFFORT_M,
          '5 km à fond, chronomètre déclenché : pars vite mais tenable, et finis vidée',
        ),
      ],
    },
    {
      repeat: 1,
      steps: [distanceStep('cooldown', FITNESS_TEST_COOLDOWN_M, 'Retour au calme trotté')],
    },
  ];
}

/**
 * Les budgets de la semaine, un créneau de qualité converti en **test** et la
 * différence prise aux footings — `null` quand la conversion casserait un
 * invariant, à charge de l'appelant de laisser la semaine telle quelle (elle
 * garde alors sa séance de qualité ordinaire, et n'a pas de test).
 *
 * Même mécanique et même prudence que le plafond de sortie longue
 * (`long-run-cap.ts`) : la somme ne bouge jamais d'un dixième — ce qui est
 * donné au test est repris aux footings —, et au moindre invariant menacé la
 * semaine repart intacte. Trois invariants, tous vérifiés par
 * `validatePlanBusinessRules` en aval :
 *
 * - la **sortie longue reste la séance la plus longue** de sa semaine (une
 *   semaine à petit volume dont la sortie longue fait 6 km ne peut pas porter
 *   un test de 7,5 km) ;
 * - aucune séance ne sort des **bornes du contrat** (0,5 à 80 km) ;
 * - la sortie longue n'est **pas touchée**, et la somme non plus : sa part
 *   réglementaire (20 à 40 % du volume) reste donc exactement celle que la
 *   décomposition a calculée. C'est aussi pourquoi la cible de la semaine n'est
 *   pas un paramètre ici, contrairement au plafond de sortie longue — rien de ce
 *   qui se mesure en part du volume ne bouge.
 *
 * Le test prend la place du **premier** créneau de qualité de la liste ; le
 * choix ne porte à conséquence ni sur les kilomètres (tous les créneaux d'une
 * semaine ont le même budget) ni sur le jour, que l'appelant choisit à part
 * ({@link pickFitnessTestDay}).
 */
export function fitnessTestBudgets(budgets: readonly SessionBudget[]): SessionBudget[] | null {
  const quality = budgets.find((budget) => budget.role === 'quality');
  const long = budgets.find((budget) => budget.role === 'long');
  const easyCount = budgets.filter((budget) => budget.role === 'easy').length;
  // Sans créneau de qualité, il n'y a rien à remplacer ; sans footing, il n'y a
  // nulle part où prendre la différence.
  if (quality === undefined || long === undefined || easyCount === 0) return null;

  const testTenths = tenths(FITNESS_TEST_SESSION_KM);
  const deltaTenths = testTenths - tenths(quality.km);

  // Le partage se fait au dixième, les premiers footings servis absorbant le
  // reliquat de la division : ils restent au plus à un dixième les uns des
  // autres, ce qui est déjà l'écart que la décomposition leur laisse.
  const perEasy = Math.trunc(deltaTenths / easyCount);
  const remainder = Math.abs(deltaTenths - perEasy * easyCount);
  const step = Math.sign(deltaTenths);

  let qualitySeen = 0;
  let easyIndex = 0;
  const converted = budgets.map((budget) => {
    if (budget.role === 'quality') {
      qualitySeen += 1;
      return qualitySeen === 1 ? { role: budget.role, km: FITNESS_TEST_SESSION_KM } : budget;
    }
    if (budget.role !== 'easy') return budget;
    const taken = perEasy + (easyIndex < remainder ? step : 0);
    easyIndex += 1;
    return { role: budget.role, km: (tenths(budget.km) - taken) / 10 };
  });

  return breaksInvariants(converted, long.km) ? null : converted;
}

/**
 * La semaine convertie casse-t-elle un des invariants que le squelette doit
 * satisfaire par construction ?
 *
 * Volontairement conservatrice, comme celle du plafond de sortie longue : au
 * moindre doute, la semaine d'origine repart telle quelle et le plan perd un
 * test — ce qui est sans conséquence, là où une semaine invalide sortirait en
 * incohérence interne (`InvalidGeneratedPlanError`) puisque c'est l'appli qui
 * l'a écrite.
 */
function breaksInvariants(budgets: readonly SessionBudget[], longKm: number): boolean {
  for (const budget of budgets) {
    if (budget.role === 'long') continue;
    // La sortie longue reste la séance la plus longue de la semaine —
    // l'égalité suffit, la validation accepte plusieurs maxima.
    if (budget.km > longKm) return true;
    if (budget.km < PLAN_OUTPUT_BOUNDS.distanceKm.min) return true;
    if (budget.km > PLAN_OUTPUT_BOUNDS.distanceKm.max) return true;
  }
  return false;
}

/** Le nombre de jours écoulés depuis `other` jusqu'à `day`, la semaine refermée sur elle-même. */
function daysSince(day: number, other: number): number {
  return (day - other + 7) % 7;
}

/**
 * Le jour de qualité sur lequel poser le test : celui dont les **jambes sont
 * les plus fraîches** — `null` quand la semaine ne pose aucune qualité.
 *
 * Un test se court sur des jambes reposées, sans quoi il ne mesure pas la
 * forme mais la fatigue de la veille — et le chiffre obtenu, lui, ira calibrer
 * toutes les allures du plan restant. La fraîcheur se mesure ici comme
 * l'espacement partout ailleurs dans ce module : le nombre de jours qui
 * séparent le candidat du **jour dur précédent**, la semaine étant refermée
 * sur elle-même (une sortie longue du dimanche précède bien un mardi).
 *
 * Le candidat le mieux isolé l'emporte ; à égalité, le plus tôt dans la semaine
 * — un départage arbitraire, mais déterministe, et c'est ce qui compte pour que
 * création et reconstruction posent le test le même jour.
 *
 * Cela ne **garantit** pas une veille facile : sur une semaine dense, aucun
 * placement ne laisse deux jours durs séparés (cf. l'en-tête de `days.ts`, où
 * 293 cellules sur 1 372 sont dans ce cas). Ce que cette fonction garantit est
 * qu'on prend le meilleur des jours disponibles, et `placeSessionDays` a déjà
 * maximisé cet espacement en amont.
 *
 * @param qualityDays les jours ISO des créneaux de qualité de la semaine.
 * @param hardDays **tous** les jours durs de la semaine, sortie longue et
 * créneaux de qualité compris — le candidat lui-même en fait donc partie, et
 * il est ignoré.
 */
export function pickFitnessTestDay(
  qualityDays: readonly number[],
  hardDays: readonly number[],
): number | null {
  let best: number | null = null;
  let bestFreshness = -1;

  for (const day of qualityDays) {
    let freshness = Number.POSITIVE_INFINITY;
    for (const other of hardDays) {
      if (other === day) continue;
      freshness = Math.min(freshness, daysSince(day, other));
    }
    if (freshness > bestFreshness) {
      best = day;
      bestFreshness = freshness;
    }
  }

  return best;
}
