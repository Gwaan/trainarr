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
 * **La semaine d'un test ne porte que le test comme séance dure.** Il ne
 * s'ajoute pas aux créneaux de qualité, et il ne se contente pas d'en remplacer
 * un : tous les autres redeviennent des footings ({@link fitnessTestBudgets}).
 *
 * Ce n'est pas de la prudence de principe, c'est ce que la mesure a imposé. Sur
 * le plan réel de l'utilisatrice (`faster`, 4 séances, 4 h, 8 semaines), le test
 * ne remplaçait qu'un créneau — et la semaine qui le portait devenait la plus
 * dure du plan :
 *
 * - le test, c'est **5 km à fond**, courus plus vite que l'allure de seuil ;
 * - la semaine gardait **en plus** un créneau de seuil de 2,2 km d'effort ;
 * - soit **7,2 km d'intensité sur 29,2 km — 24,7 %**, contre 10,7 à 15,5 % sur
 *   toutes les autres semaines du même plan ;
 * - et le seuil tombait **48 h après** l'effort maximal (test mardi, seuil
 *   jeudi), là où l'espacement des jours durs ne voyait qu'un créneau de qualité
 *   ordinaire.
 *
 * Le test est **plus dur** que la séance qu'il remplace : le remplacement seul
 * fait donc monter la charge de la semaine au lieu de la faire baisser. Et il
 * échappe par construction aux plafonds de volume d'intensité
 * (`quality-load.ts`), qui se calculent par zone d'allure — un effort maximal
 * libre n'en a aucune. Retirer les autres séances dures est le seul garde-fou
 * qui morde.
 *
 * Deux raisons, dont une n'est pas un confort :
 *
 * - un test couru sur des jambes fatiguées produit un VDOT faux, et ce VDOT
 *   recalcule ensuite **toutes** les allures du plan. La fraîcheur est la
 *   condition de validité de la mesure elle-même ;
 * - la semaine de test cesse d'être une semaine surchargée déguisée en semaine
 *   ordinaire. Mesuré après correction sur le même plan : 17,1 % au lieu de
 *   24,7 %.
 *
 * **Ce que la correction ne peut pas faire**, et il faut le dire ici plutôt que
 * de laisser croire l'inverse : une semaine de test ne descendra jamais sous la
 * plus chargée des semaines ordinaires. Son intensité vaut désormais
 * *exactement* les 5 km du test — vérifié sur 8 200 semaines de test d'un
 * balayage (intentions × durées × comptes de séances × volumes), toutes à 5,0 km
 * contre 9,4 km au pire avant —, et c'est un **coût fixe** là où l'intensité
 * d'une semaine ordinaire suit son volume (3 à 4,6 km sur ces plans-là). Sur une
 * semaine à 29,2 km, 5 km font 17,1 % ; sur une semaine à 18,4 km, 27,2 %. Il
 * n'y a plus rien à retirer : ce qui reste est la mesure elle-même.
 *
 * Les budgets kilométriques, eux, ne se perdent pas : celui du créneau que le
 * test consomme et ceux des créneaux effacés retournent au pot des footings, la
 * différence entre le coût du test ({@link FITNESS_TEST_SESSION_KM}) et le
 * budget d'un créneau (15 à 19 % de la semaine, 4,5 km sur 30) y étant reprise.
 * La sortie longue n'est jamais touchée et la somme ne bouge pas d'un dixième :
 * la semaine retombe sur sa cible ({@link fitnessTestBudgets}).
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
 * **Quatre**, et c'est exactement la règle que le verdict applique
 * ({@link REFERENCE_UPDATE_MIN_GAP_DAYS}, 28 jours) : le bas de la fourchette de
 * Daniels (4 à 6 semaines). Ces deux chiffres disaient la même chose et ne
 * s'accordaient pas — la règle à quatre semaines, le placement à cinq. Le plan
 * prescrivait donc une mesure de moins que ce qu'il s'autorisait à lire.
 *
 * Le bas de la fourchette plutôt que son milieu parce qu'un test n'est **pas une
 * séance perdue**, même quand il ne montre rien : un 5 km à fond est un stimulus
 * d'entraînement à part entière, et souvent le plus dur de la semaine. Le seul
 * coût réel d'un test qui rend « pas mieux » est la fatigue d'un effort maximal
 * — et l'information « je stagne » a de la valeur.
 *
 * ## Le piège que quatre semaines rouvre, et où il se referme
 *
 * À cinq semaines, l'écart en jours était tenu **par construction** : 35 jours à
 * jour de placement égal, 29 au pire glissement (un test le dimanche, le suivant
 * le lundi), donc toujours au-dessus des 28 exigés. À quatre, l'écart tombe
 * **pile** sur 28 : il ne survit qu'à jour de placement égal ou plus tardif. Or
 * le jour se choisit plus tard ({@link pickFitnessTestDay}), à partir des jours
 * durs de la semaine — qui dépendent de la phase, donc peuvent bouger d'un test
 * au suivant. Un glissement d'un seul jour vers l'amont ramènerait l'écart à 27
 * et **le test suivant partirait en `too-soon`**, mesure prescrite et jetée.
 *
 * Ce n'est donc plus la cadence en semaines qui tient le plancher : c'est
 * `buildPlanSkeleton`, qui refuse d'écrire un test à moins de
 * {@link REFERENCE_UPDATE_MIN_GAP_DAYS} du précédent **réellement placé**, jour
 * compris, et le décale ou y renonce (cf. le paramètre `minDay` de
 * {@link pickFitnessTestDay}). Le plancher du **premier** test, qui se compte
 * depuis le départ du plan, reste l'affaire de {@link firstEvaluableTestWeek}.
 */
export const FITNESS_TEST_CADENCE_WEEKS = 4;

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
 * Ce que cette fonction rend est une **périodisation**, pas un calendrier :
 * quatre semaines d'écart valent 28 jours au jour de placement près, et c'est
 * `buildPlanSkeleton` qui referme cet écart-là en jours, une fois le jour connu
 * ({@link FITNESS_TEST_CADENCE_WEEKS}). Une semaine désignée ici peut donc
 * repartir sans test, comme elle le fait déjà quand ses budgets ne financent pas
 * la séance ({@link fitnessTestBudgets}).
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
 * Les budgets de la semaine, **une seule séance dure** : le test. Le premier
 * créneau de qualité devient le test, tous les autres deviennent des footings,
 * et le pot des footings se repartage à égalité — `null` quand la conversion
 * casserait un invariant, à charge de l'appelant de laisser la semaine telle
 * quelle (elle garde alors ses séances de qualité ordinaires, et n'a pas de
 * test).
 *
 * Le pourquoi du dépeuplement — la mesure à 24,7 % contre 10,7 à 15,5 % — est
 * dans l'en-tête du module. Ce qu'il faut savoir ici est comment les kilomètres
 * se conservent :
 *
 * 1. le budget du créneau consommé et ceux des créneaux effacés entrent au pot
 *    des footings ;
 * 2. le coût du test ({@link FITNESS_TEST_SESSION_KM}) en sort ;
 * 3. le pot se repartage **à égalité** entre tous les footings de la semaine,
 *    les créneaux reconvertis compris — au dixième, les premiers servis
 *    absorbant le reliquat de la division, exactement comme
 *    `weeklySessionBudgets` le fait à la décomposition.
 *
 * Le repartage égal plutôt que le simple changement de rôle : une semaine de
 * test doit ressembler à une semaine ordinaire à un seul créneau, pas à une
 * semaine bancale où un footing porterait le kilométrage d'un créneau supprimé.
 *
 * Même prudence que le plafond de sortie longue (`long-run-cap.ts`) : la somme
 * ne bouge jamais d'un dixième, et au moindre invariant menacé la semaine
 * repart intacte. Trois invariants, tous vérifiés par
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
  const testIndex = budgets.findIndex((budget) => budget.role === 'quality');
  const long = budgets.find((budget) => budget.role === 'long');
  // Sans créneau de qualité, il n'y a rien à remplacer ; sans sortie longue, pas
  // de plafond auquel comparer ce qu'on écrit.
  if (testIndex < 0 || long === undefined) return null;

  // Tout ce qui n'est ni la sortie longue ni le test devient un footing : les
  // créneaux de qualité qui restaient s'effacent devant lui.
  const easyIndexes: number[] = [];
  budgets.forEach((budget, index) => {
    if (index !== testIndex && budget.role !== 'long') easyIndexes.push(index);
  });
  // Sans footing, il n'y a nulle part où prendre la différence.
  if (easyIndexes.length === 0) return null;

  const easyTenths =
    easyIndexes.reduce((sum, index) => sum + tenths(budgets[index].km), 0) +
    tenths(budgets[testIndex].km) -
    tenths(FITNESS_TEST_SESSION_KM);

  const perEasy = Math.floor(easyTenths / easyIndexes.length);
  const remainder = easyTenths - perEasy * easyIndexes.length;

  const easyKm = new Map<number, number>();
  easyIndexes.forEach((index, rank) => {
    easyKm.set(index, (perEasy + (rank < remainder ? 1 : 0)) / 10);
  });

  const converted = budgets.map((budget, index): SessionBudget => {
    if (index === testIndex) return { role: 'quality', km: FITNESS_TEST_SESSION_KM };
    const km = easyKm.get(index);
    return km === undefined ? budget : { role: 'easy', km };
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
 * ## Quels jours durs précèdent, exactement
 *
 * C'est là que le dépeuplement de la semaine de test (cf. l'en-tête, et
 * {@link fitnessTestBudgets}) change le calcul, et il fallait le refaire :
 *
 * - la **sortie longue** est dure dans les deux semaines, celle du test comme
 *   la précédente — elle compte toujours ;
 * - les **autres créneaux de qualité** ne sont durs que dans la semaine
 *   **précédente**, puisque le test les efface dans la sienne. Un créneau
 *   n'est donc à compter que s'il tombe *après* le candidat dans l'ordre de la
 *   semaine : c'est alors son occurrence de la semaine d'avant qui précède le
 *   test. Un créneau placé avant le candidat, lui, est devenu un footing.
 *
 * La semaine précédente est bien réputée porter les mêmes créneaux : la cadence
 * des tests est de cinq semaines, jamais deux d'affilée, et le placement des
 * jours ne dépend pas du numéro de semaine (`placeSessionDays`).
 *
 * Ce que cela change, sur la semaine exacte du plan de l'utilisatrice — sortie
 * longue le samedi, créneaux le mardi et le jeudi : l'ancien calcul pénalisait
 * le jeudi du mardi qui le précède (deux jours) et posait le test le **mardi**,
 * la séance de seuil du jeudi tombant alors 48 h après un effort maximal. Le
 * nouveau le pose le **jeudi**, à cinq jours de la sortie longue, derrière un
 * mardi devenu footing.
 *
 * Le candidat le mieux isolé l'emporte ; à égalité, le plus tôt dans la semaine
 * — un départage arbitraire, mais déterministe, et c'est ce qui compte pour que
 * création et reconstruction posent le test le même jour.
 *
 * Cela ne **garantit** pas une veille facile : sur une semaine dense, aucun
 * placement ne laisse deux jours durs séparés (cf. l'en-tête de `days.ts`, où
 * 293 cellules sur 1 372 sont dans ce cas). Ce que cette fonction garantit est
 * qu'on prend le meilleur des jours disponibles, et `placeSessionDays` a déjà
 * maximisé cet espacement en amont. Ce qui est en revanche garanti est l'**aval**
 * du test : les jours qui le suivent dans sa propre semaine ne portent plus que
 * des footings et, au plus, la sortie longue.
 *
 * ## Le plancher de cadence, quand il y en a un
 *
 * `minDay` est le premier jour de la semaine qui laisse
 * {@link REFERENCE_UPDATE_MIN_GAP_DAYS} depuis le test précédent (cf.
 * {@link FITNESS_TEST_CADENCE_WEEKS}). Les jours qui lui sont antérieurs sont
 * **écartés d'emblée**, avant tout arbitrage de fraîcheur : un test que la
 * cadence rejettera n'est pas un test, et un jour frais ne rachète pas une
 * mesure jetée. Quand aucun créneau ne le satisfait, la fonction rend `null` et
 * la semaine repart avec sa qualité ordinaire — le plan perd une mesure, jamais
 * une séance.
 *
 * @param qualityDays les jours ISO des créneaux de qualité de la semaine.
 * @param longRunDay le jour ISO de la sortie longue — `null` quand la semaine
 * n'en place pas.
 * @param minDay le premier jour ISO acceptable, `null` quand la semaine n'a
 * aucun test avant elle à qui rendre des comptes.
 */
export function pickFitnessTestDay(
  qualityDays: readonly number[],
  longRunDay: number | null,
  minDay: number | null = null,
): number | null {
  let best: number | null = null;
  let bestFreshness = -1;

  for (const day of qualityDays) {
    if (minDay !== null && day < minDay) continue;
    let freshness = longRunDay === null ? Number.POSITIVE_INFINITY : daysSince(day, longRunDay);
    for (const other of qualityDays) {
      // Les créneaux d'avant le candidat sont devenus des footings ; ceux
      // d'après ne pèsent que par leur occurrence de la semaine précédente.
      if (other <= day) continue;
      freshness = Math.min(freshness, daysSince(day, other));
    }
    if (freshness > bestFreshness) {
      best = day;
      bestFreshness = freshness;
    }
  }

  return best;
}
