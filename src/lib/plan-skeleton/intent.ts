/**
 * L'**intention** d'un plan : ce que l'athlète vient y chercher, et ce que la
 * structure du plan en déduit.
 *
 * ## Pourquoi quatre intentions, et pas un objectif libre
 *
 * L'objectif était jusqu'ici du texte libre, dont le squelette ne tirait qu'une
 * distance quand il en trouvait une. Tout le reste — périodisation, grille de
 * qualité, part de qualité, sortie longue — était celui d'une **préparation à
 * une course**, y compris pour une athlète qui n'en visait aucune. Mesuré en
 * production sur un objectif libre : huit séances « Spécifique allure course »,
 * c'est-à-dire à l'allure d'une course qui n'existe pas.
 *
 * Quatre intentions, parce que ce sont les quatre demandes qui appellent des
 * structures **différentes**, pas quatre nuances d'une même. Chacune est décrite
 * ici par une poignée de paramètres, et chacun de ces paramètres porte ce qui le
 * fonde : ce module est le lieu où la recherche est consignée, et il n'existe que
 * pour ça. Un paramètre qu'on modifierait sans mesure qui contredise sa source
 * ferait perdre au plan ce qui le distingue d'un gabarit.
 *
 * ## Ce que ce module ne décide pas
 *
 * **Les volumes.** `weeklyVolumeTargets` chiffre les kilomètres, et aucune
 * intention n'y touche : ce qui change d'une intention à l'autre est la *forme*
 * de la semaine, jamais son poids. Une reprise court moins parce que son taux de
 * croissance est celui d'une débutante (l'appelant le dit par `level`), pas parce
 * que ce module aurait retiré des kilomètres.
 *
 * **L'affûtage.** Il se déduit de la présence d'une date de course
 * (`taperWeekCount`), et pas de l'intention : trois des quatre intentions n'ont
 * pas de date, donc pas d'affûtage, et le déduire une seconde fois ici ferait
 * diverger la périodisation des volumes cibles — qui, eux, ne connaissent que la
 * date.
 *
 * Module **pur** : ni base, ni réseau, ni `server-only`, ni horloge, ni aléa. Tout
 * ce qu'il rend est fonction de l'intention et du rang, jamais d'un état — c'est
 * ce qui permet à une reconstruction de fin de plan de reproduire exactement ce
 * que la création avait écrit.
 */

import type { PlanLevel } from '@/data/db/schema';

/**
 * Ce que l'athlète demande à son plan.
 *
 * - `race` : préparer une course datée. C'est la structure historique du module,
 *   et la seule des quatre à avoir un jour J, donc un affûtage et une semaine de
 *   course.
 * - `faster` : courir plus vite, sans échéance. Une progression sans fin
 *   programmée : on développe, on spécifie, on ne relâche jamais pour une date
 *   qui n'existe pas.
 * - `weight_loss` : perdre du poids. Le levier est la **dépense**, donc le volume
 *   facile ; l'intensité n'y sert qu'à la santé cardiorespiratoire.
 * - `return` : reprendre la course. Le seul risque à gérer est la **charge
 *   cumulée**, et le seul confort démontré est la marche/course.
 */
export type PlanIntent = 'race' | 'faster' | 'weight_loss' | 'return';

/** Les quatre intentions, dans l'ordre du sélecteur — pour balayer sans en oublier. */
export const PLAN_INTENTS = ['race', 'faster', 'weight_loss', 'return'] as const satisfies readonly PlanIntent[];

/**
 * La part de la fenêtre de développement que prend la **base**, par intention.
 *
 * Le reste se partage entre développement et spécificité comme il l'a toujours
 * fait (4 contre 3, cf. `phases.ts`) : ce qui change d'une intention à l'autre
 * est la longueur du socle, pas la façon dont ce qui reste se répartit.
 *
 * - **`race` — 30 %.** La segmentation 30/40/30 d'origine (Lydiard pour la base
 *   longue, Daniels et Pfitzinger pour la spécificité terminale). Inchangée : une
 *   préparation datée est le cas pour lequel elle a été écrite.
 * - **`faster` — 25 %.** Le bas de la fourchette 25-30 % : sans date, ce qui fait
 *   courir plus vite est le travail de seuil et de VMA, et la base n'est là que
 *   pour le rendre encaissable. Lui donner un tiers du plan reviendrait à
 *   retarder d'autant ce que l'athlète est venue chercher.
 * - **`weight_loss` — 35 %.** Le bas de la fourchette 35-40 %, pour la raison
 *   symétrique : ce qui compte est la dépense, et c'est le **build prolongé** —
 *   toute la fin du plan — qui la porte. La base reste large parce qu'un volume
 *   qui monte trop vite sur un corps qui porte du poids se paie en arrêt.
 * - **`return` — 50 %, et 60 % avec un antécédent de blessure.** La moitié du
 *   plan en construction pure. L'antécédent de blessure est le prédicteur le plus
 *   fort de tout le dossier — OR 7,56 chez Relph 2023 (revue systématique), retrouvé
 *   par Buist 2010 sur les coureurs débutants —, et c'est la seule variable qui
 *   déplace franchement un paramètre de ce module.
 */
const INTENT_BASE_SHARE = {
  race: 0.3,
  faster: 0.25,
  weight_loss: 0.35,
  return: 0.5,
} as const satisfies Record<PlanIntent, number>;

/** La base d'une reprise **avec antécédent de blessure** : 60 % au lieu de 50 %. */
const RETURN_INJURY_BASE_SHARE = 0.6;

/**
 * Les intentions qui portent une phase de **spécificité**.
 *
 * Se spécifier veut dire converger vers quelque chose : une allure, une distance,
 * une date. Deux intentions n'ont rien vers quoi converger, et leur poser une
 * phase spécifique fabriquerait exactement l'absurdité mesurée en production — un
 * « spécifique allure course » sans course.
 *
 * - `weight_loss` : le plan se termine sur un build prolongé, c'est-à-dire sur ce
 *   qui dépense le plus.
 * - `return` : le plan se termine sur du développement, c'est-à-dire sur la
 *   première chose qui ressemble à un entraînement.
 */
const INTENT_HAS_SPECIFIC = {
  race: true,
  faster: true,
  weight_loss: false,
  return: false,
} as const satisfies Record<PlanIntent, boolean>;

/**
 * Le nombre de créneaux de qualité que l'intention **veut** par semaine — avant
 * les plafonds du squelette (les zones que la phase propose, et la place que le
 * nombre de séances laisse).
 *
 * - **`race` et `faster` : 1 pour une débutante, 2 sinon.** Le dosage classique,
 *   inchangé : une séance dure tant que le corps apprend encore à encaisser, deux
 *   ensuite, la sortie longue comptant déjà comme une troisième sollicitation.
 * - **`weight_loss` : 1, quel que soit le niveau.** C'est le paramètre le plus
 *   contre-intuitif du dossier, et le mieux étayé. La séance dure ne se justifie
 *   **pas** par la masse grasse : sur ce critère, intensité et continu sont
 *   équivalents à dépense égale (Keating 2017 ; Wewege 2017 ; Steele 2021 ;
 *   consensus ACSM 2024) — et la méta-analyse Viana 2019, qui concluait l'inverse
 *   et qui circule encore, est **rétractée**. Ce qui la justifie est la VO2max :
 *   Weeldreyer 2024 montre que le niveau de fitness annule le surrisque de
 *   mortalité associé au surpoids. Une séance dure par semaine suffit à
 *   l'entretenir ; la seconde ne ferait que prendre la place du volume facile,
 *   qui est l'actif à protéger.
 * - **`return` : 0.** Et ce n'est pas par crainte de l'intensité — Fredette 2022
 *   conclut à des preuves **contradictoires** sur l'intensité comme facteur de
 *   blessure. Ce qu'on limite est la **charge cumulée** : une séance de qualité
 *   ajoute une sollicitation longue à une semaine dont le seul but est de
 *   réinstaller la routine. Les touches de vivacité restent les variations
 *   existantes — lignes droites et côtes courtes sur les footings, 15 à 20 s à
 *   coût structurel quasi nul.
 */
export function intentQualitySlots(intent: PlanIntent, level: PlanLevel): number {
  switch (intent) {
    case 'race':
    case 'faster':
      return level === 'beginner' ? 1 : 2;
    case 'weight_loss':
      return 1;
    case 'return':
      return 0;
  }
}

/**
 * La part de la fenêtre de développement prise par la base, telle que
 * {@link planPhases} la lira.
 *
 * @param returnInjuryHistory un antécédent de blessure déclaré — ne joue qu'en
 * `return`, où il rallonge la base de dix points. Ailleurs, il n'a rien à dire :
 * une athlète qui prépare une course connaît son passé, et son plan n'est pas une
 * reprise.
 */
export function intentBasePhaseShare(intent: PlanIntent, returnInjuryHistory: boolean): number {
  if (intent === 'return' && returnInjuryHistory) return RETURN_INJURY_BASE_SHARE;
  return INTENT_BASE_SHARE[intent];
}

/** L'intention porte-t-elle une phase de spécificité ? */
export function intentHasSpecificPhase(intent: PlanIntent): boolean {
  return INTENT_HAS_SPECIFIC[intent];
}

/**
 * L'intention fait-elle **croître** la part de qualité au fil du plan
 * ({@link weeklyQualityShares}) ?
 *
 * Trois intentions sur quatre : la rampe 15 → 19 % est ce qui fait qu'une
 * semaine de développement de fin de plan ne ressemble pas à celle du début,
 * même quand le budget temps interdit au kilométrage de monter.
 *
 * `weight_loss` en est exclue, et c'est un choix de fond : **le volume facile est
 * l'actif à protéger**. Déplacer des kilomètres du facile vers la qualité au fil
 * des semaines reviendrait à échanger de la dépense contre de l'intensité, dans
 * le seul cas où la littérature dit que l'échange ne rapporte rien (cf.
 * {@link intentQualitySlots}). La part reste donc plate, à
 * `QUALITY_SHARE.outsideRamp`.
 *
 * `return` n'ouvre aucun créneau : sa part de qualité ne multiplie jamais rien.
 * Elle est plate elle aussi, pour que la valeur qu'on lit dans un squelette de
 * reprise ne raconte pas une progression qui n'a pas lieu.
 */
export function intentRampsQualityShare(intent: PlanIntent): boolean {
  return intent === 'race' || intent === 'faster';
}

/**
 * La part maximale du volume hebdomadaire que la sortie longue peut prendre sous
 * cette intention — `null` quand seule la règle générale s'applique (20 à 40 %,
 * cf. `VOLUME_RULES.longRunShare`).
 *
 * `return` : **30 %**. Une reprise n'a pas besoin d'une sortie longue qui pèse
 * deux fois le reste de sa semaine ; ce qui la fait progresser est la
 * **fréquence**, et le pic d'une séance isolée est justement le paramètre de
 * charge que Frandsen 2025 (5 205 coureurs) associe au risque. Trente points au
 * lieu de quarante, c'est la même semaine avec un jour de moins à encaisser.
 *
 * Ce plafond **cède devant les invariants** : sous cinq séances, la
 * décomposition relève la sortie longue au-dessus de 30 % pour qu'elle reste la
 * séance la plus longue de la semaine (cf. `long-run-cap.ts`), et une sortie
 * longue qui ne serait plus la plus longue séance ferait échouer la validation.
 * Le plafond est un souhait, la cohérence de la semaine est une règle.
 */
export function intentLongRunShareCap(intent: PlanIntent): number | null {
  return intent === 'return' ? 0.3 : null;
}

/**
 * L'intention programme-t-elle des **tests chronométrés** dans sa
 * périodisation ({@link fitnessTestWeekNumbers}) ?
 *
 * Deux intentions sur quatre, et chaque exclusion a sa raison.
 *
 * - **`faster` : oui, et c'est le cas qui fait exister ce paramètre.** Un plan
 *   sans échéance dérive toutes ses allures d'un chrono de référence qui, lui,
 *   ne bouge jamais : l'athlète progresse, le plan reste calé sur ce qu'elle
 *   valait au premier jour. Le test est la seule **mesure externe** qui remette
 *   ce chrono à jour ; c'est aussi la méthode de Daniels, qui calcule un VDOT à
 *   partir de n'importe quelle performance récente, test de terrain compris.
 * - **`weight_loss` : oui.** Elle porte une séance dure par semaine, dont
 *   l'objet est la VO2max (cf. {@link intentQualitySlots}) : mesurer où en est
 *   cette VO2max est exactement dans le sujet, et c'est la seule progression
 *   que ce plan-là puisse montrer à qui ne regarde pas la balance.
 * - **`return` : non.** Elle n'ouvre aucun créneau de qualité, donc aucun
 *   créneau qu'un test puisse remplacer ; et une reprise se joue sur la
 *   fréquence, pas sur un 5 km à fond.
 * - **`race` : non**, et c'est le seul arbitrage discutable des quatre. La
 *   course elle-même est une mesure externe datée, qui satisfait déjà la
 *   cadence de Daniels (une mise à jour toutes les 4 à 6 semaines). Surtout,
 *   une mise à jour du chrono de référence en cours de préparation
 *   **déplacerait l'allure objectif** que la phase spécifique fait répéter
 *   (zone `marathon`, cf. `quality.ts`) : le plan changerait, en silence, la
 *   cible d'une course à laquelle l'athlète s'est déjà engagée. Ce n'est pas
 *   une décision d'algorithme. Un test d'échauffement à mi-préparation reste
 *   une pratique valide — il se courra comme une course, et l'athlète mettra
 *   son chrono à jour elle-même.
 */
export function intentRunsFitnessTests(intent: PlanIntent): boolean {
  return intent === 'faster' || intent === 'weight_loss';
}

/**
 * Combien de **premières semaines de base** se courent en marche/course —
 * `0` hors reprise.
 *
 * Deux semaines, quatre avec un antécédent de blessure (la même variable qui
 * rallonge la base, cf. {@link intentBasePhaseShare}).
 *
 * ## Ce que la marche/course est, et ce qu'elle n'est pas
 *
 * C'est le **seul** format de reprise à avoir un essai contrôlé randomisé
 * derrière lui : Hottenrott 2016 rapporte, à performance égale, moins de douleurs
 * et moins de fatigue perçue qu'une course continue chez des coureurs de loisir.
 * C'est donc un argument de **confort démontré**, et il faut le présenter comme
 * tel — aucune donnée ne dit qu'elle prévient les blessures, et le prétendre
 * ferait de ce module un vendeur de promesses.
 *
 * Le ratio ouvre à ~1:2 (une portion courue pour deux marchées) et finit à ~2:1 :
 * la fenêtre n'est pas une béquille qu'on garde, c'est une rampe qu'on remonte.
 */
export function intentWalkRunBaseWeeks(intent: PlanIntent, returnInjuryHistory: boolean): number {
  if (intent !== 'return') return 0;
  return returnInjuryHistory ? 4 : 2;
}
