/**
 * Le **volume d'effort** d'une séance de qualité, et ce qu'il ne doit pas
 * dépasser.
 *
 * ## Le trou que ce module bouche
 *
 * Tout le reste de la chaîne borne la *forme* d'une séance dure : la grammaire
 * du modèle borne ses blocs, `sessionStepViolations` exige une enveloppe et une
 * récupération dans les blocs répétés, le budget du créneau borne son **total**,
 * et le corridor d'allures borne ses vitesses. Rien, nulle part, ne bornait le
 * nombre de kilomètres courus **à l'allure dure**.
 *
 * Rien n'empêchait donc une séance de seuil budgétée 6 km d'en porter 5
 * d'effort — soit, sur une semaine de 30 km, 17 % du volume hebdomadaire au
 * seuil quand la référence en plafonne 10. C'est la seule dimension de la séance
 * que rien ne bornait, et c'est précisément celle dont l'excès est le mécanisme
 * du surentraînement.
 *
 * ## Les plafonds, et leur niveau de preuve
 *
 * **③ — consensus d'entraîneur, pas d'essai contrôlé.** Ces plafonds sont ceux
 * que publie Jack Daniels (*Daniels' Running Formula*), exprimés en part du
 * volume hebdomadaire — l'unité même dont le squelette dispose. Ils n'ont **pas**
 * pu être recoupés en ligne au moment de les encoder : ils sont repris de la
 * doctrine telle qu'elle circule, pas d'une source vérifiée pièce en main, et
 * aucun essai contrôlé ne montre qu'un athlète qui les respecte progresse mieux
 * qu'un athlète qui les dépasse. Ce qu'ils valent est ce que vaut un garde-fou
 * conservateur : ils bornent une dose dont on sait que l'excès nuit, à un niveau
 * que la profession tient pour raisonnable.
 *
 * Le dire ici plutôt que de laisser croire à une preuve qui n'existe pas — c'est
 * la même honnêteté que celle du test chronométré (`fitness-test.ts`).
 *
 * ## Ce que ce module ne plafonne pas, et pourquoi
 *
 * La zone `marathon` (« spécifique allure course ») n'a **aucun plafond ici**.
 * Daniels borne bien la séance à allure marathon, mais en *absolu* — de l'ordre
 * de 110 minutes ou d'une quinzaine de miles —, pas en part du volume
 * hebdomadaire, et la valeur exacte n'a pas pu être recoupée. Deux raisons de ne
 * rien encoder plutôt que d'approcher :
 *
 * - un plafond absolu de cet ordre ne mordrait **jamais** ici : un créneau de
 *   qualité pèse 14 à 19 % d'une semaine, soit une douzaine de kilomètres au
 *   plus, enveloppe comprise. Encoder 25 km serait de la décoration ;
 * - inventer une part hebdomadaire faute de mieux reviendrait à fabriquer une
 *   métrique physio, ce que ce projet ne fait pas.
 *
 * La zone `marathon` reste donc bornée par ce qui la bornait déjà : le budget de
 * son créneau.
 *
 * Module **pur** : ni base, ni réseau, ni `server-only`, ni horloge, ni aléa.
 */

import { stepNotePaceZone } from '@/lib/ai/plan-schema';
import { flattenSteps, type PlanSessionSteps } from '@/lib/plan-steps/schema';

import type { QualityZone } from './quality';

/** Un plafond de volume d'effort : une part du volume hebdomadaire, et parfois un absolu. */
type EffortCap = {
  /** La part du volume hebdomadaire, en fraction. */
  share: number;
  /** Le plafond absolu en km, quand la doctrine en pose un **en plus** de la part. */
  maxKm: number | null;
};

/**
 * Ce qu'une séance peut porter d'effort **à l'allure de sa zone**, par zone —
 * `null` quand rien de fondé ne la plafonne (cf. l'en-tête pour `marathon`).
 *
 * Quand les deux existent, c'est **le plus petit des deux** qui vaut : la part
 * protège l'athlète à petit volume, l'absolu protège celle à gros volume. À 8 %
 * de 150 km, la part autoriserait 12 km de VMA — ce qui n'est pas une séance,
 * c'est une course.
 *
 * - **Répétitions (R)** : 5 % du volume hebdomadaire, ou 8 km. C'est du travail
 *   de foulée à vitesse quasi maximale : la dose utile est petite, et au-delà on
 *   n'améliore plus l'économie de course, on accumule de la fatigue neuro-
 *   musculaire.
 * - **VMA (I)** : 8 %, ou 10 km. Le travail à VO2max se compte en minutes
 *   passées à l'intensité, et il faut pouvoir refaire la séance la semaine
 *   suivante.
 * - **Seuil (T)** : 10 %, sans absolu. C'est l'intensité la plus « soutenable »
 *   des trois, celle qu'on cumule le plus — d'où la part la plus haute, et
 *   d'où aussi le fait qu'elle soit la plus facile à surdoser sans s'en rendre
 *   compte.
 */
export const QUALITY_EFFORT_CAPS = {
  repetition: { share: 0.05, maxKm: 8 },
  interval: { share: 0.08, maxKm: 10 },
  threshold: { share: 0.1, maxKm: null },
  marathon: null,
} as const satisfies Record<QualityZone, EffortCap | null>;

/**
 * Le volume d'effort maximal d'une séance de cette zone, en km — `null` quand la
 * zone n'est pas plafonnée.
 *
 * @param weeklyTargetKm la cible hebdomadaire de la semaine où tombe le créneau,
 * telle que le squelette la porte ({@link QualitySlot.weeklyTargetKm}). C'est
 * bien le **volume de la semaine** et non le budget du créneau : un plafond
 * calculé sur la séance elle-même ne dirait rien de la charge que l'athlète
 * absorbe.
 */
export function qualityEffortCapKm(zone: QualityZone, weeklyTargetKm: number): number | null {
  const cap: EffortCap | null = QUALITY_EFFORT_CAPS[zone];
  if (cap === null) return null;

  const shareKm = Math.max(0, weeklyTargetKm) * cap.share;
  return cap.maxKm === null ? shareKm : Math.min(shareKm, cap.maxKm);
}

/**
 * Le **volume d'effort** d'un déroulé, en mètres : ce qui s'y court à l'allure
 * dure de la séance, répétitions comprises.
 *
 * ## La définition, et chacune de ses exclusions
 *
 * Somme des étapes de rôle `run` — multipliées par le `repeat` de leur bloc — à
 * l'exclusion de :
 *
 * - **l'échauffement et le retour au calme** (`warmup`, `cooldown`) : ils se
 *   courent en endurance, c'est leur définition ;
 * - **les récupérations** (`recover`) : elles se trottent, et c'est justement ce
 *   qui rend la dose d'effort soutenable ;
 * - **les étapes qu'une note déplace vers une autre zone**. `stepNotePaceZone`
 *   lit la note d'une étape pour lui poser un créneau d'allure autre que celui
 *   de sa séance : un bloc noté « au seuil » à l'intérieur d'une séance de VMA
 *   ne se court pas à VMA, et le compter dans le volume de VMA serait faux. Il
 *   n'est pas davantage reporté sur la zone qu'il nomme : ce compteur mesure
 *   **une** zone, celle de la séance.
 *
 * Une étape mesurée en durée ne compte pour rien : elle n'a pas de distance, et
 * en inventer une demanderait une allure que ce module n'a pas. Le cas n'est pas
 * atteignable par le remplissage d'un créneau (la grammaire du modèle rend la
 * durée inexprimable, et le déroulé déterministe n'écrit qu'en mètres), mais la
 * fonction est totale et ne suppose rien.
 *
 * @param zone la zone de la **séance** — c'est elle qui décide quelles notes
 * déplacent une étape et lesquelles ne font que confirmer.
 */
export function sessionEffortM(zone: QualityZone, steps: PlanSessionSteps): number {
  let effortM = 0;

  for (const step of flattenSteps(steps)) {
    if (step.role !== 'run') continue;
    if (step.distanceM === null) continue;

    // `null` = la note ne nomme aucun créneau, l'étape reste dans celui de sa
    // séance. Une note qui nomme **cette** zone la confirme (c'est le cas des
    // déroulés déterministes de seuil et de spécifique allure course).
    const noted = stepNotePaceZone(step.note);
    if (noted !== null && noted !== zone) continue;

    effortM += step.distanceM;
  }

  return effortM;
}

/** Le même volume, en kilomètres — l'unité dans laquelle les plafonds s'écrivent. */
export function sessionEffortKm(zone: QualityZone, steps: PlanSessionSteps): number {
  return sessionEffortM(zone, steps) / 1_000;
}
