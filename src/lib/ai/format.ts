/**
 * Mise en forme des données chiffrées **destinées aux prompts** du coach.
 *
 * Fonctions pures, sans `server-only` : elles ne lisent ni base ni
 * environnement, et les tests s'en saisissent directement.
 *
 * ## Pourquoi ne pas réutiliser `src/app/(app)/_lib/format.ts`
 *
 * Ces helpers-là sont colocalisés à des routes : `src/lib/` ne dépend pas de
 * `src/app/`, et les deux publics n'ont pas les mêmes exigences. L'affichage
 * peut se permettre « 1 h 05 » sans unité au bout ou un signe moins
 * typographique ; un prompt doit rester **non ambigu pour un petit modèle** et
 * aussi court que possible — chaque caractère se paie en tokens sur les 32 k de
 * contexte disponibles.
 *
 * Conventions retenues, cohérentes avec l'UI française du projet : virgule
 * décimale, allures `m:ss/km`, distances au dixième de kilomètre, durées
 * `h mm`.
 */

import type { TrainingSnapshotDto } from '@/data/coach-context';
import type { PaceZone, ReferenceDistance, TrainingPaces } from '@/lib/metrics/vdot';
import type { PlanSessionSteps, PlanStep, PlanStepBlock, PlanStepRole } from '@/lib/plan-steps/schema';

/** Jours ISO en toutes lettres : `day` vaut 1 pour lundi … 7 pour dimanche. */
const ISO_DAY_NAMES = [
  'lundi',
  'mardi',
  'mercredi',
  'jeudi',
  'vendredi',
  'samedi',
  'dimanche',
] as const;

/**
 * Jours ISO abrégés, pour les listes compactes : `SL sam` plutôt que
 * `SL samedi`. Trois lettres suffisent à lever l'ambiguïté en français, et
 * chaque caractère se paie en tokens sur une ligne par semaine.
 */
const ISO_DAY_SHORT_NAMES = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'] as const;

const DAY_MS = 86_400_000;

/**
 * Dates civiles en toutes lettres. Fuseau UTC assumé : une date civile
 * `YYYY-MM-DD` est convertie en son repère de minuit UTC (cf.
 * `src/lib/dates/civil.ts`), formater dans un autre fuseau la décalerait d'un
 * jour.
 */
const civilDateFormatter = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Nombre arrondi à `fractionDigits`, virgule décimale, signe moins ASCII. */
export function formatNumber(value: number, fractionDigits = 0): string {
  return value.toFixed(fractionDigits).replace('.', ',');
}

/** Allure `m:ss/km`, ex. `4:18/km`. */
export function formatPace(secPerKm: number): string {
  const total = Math.round(secPerKm);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}/km`;
}

/** Distance au dixième de kilomètre, ex. `18,2 km`. */
export function formatDistanceKm(meters: number): string {
  return `${formatNumber(meters / 1000, 1)} km`;
}

/** Durée lisible : `45 s`, `48 min`, `1 h 05`. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} s`;

  const minutes = Math.round(total / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours} h ${String(rest).padStart(2, '0')}` : `${rest} min`;
}

/** Chrono de course : `48:30`, `1:52:04` — le format qu'un coureur lit sur sa montre. */
export function formatClockTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const tail = `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${tail}` : `${minutes}:${String(rest).padStart(2, '0')}`;
}

/** Jour ISO en toutes lettres — `1` → `lundi`. Hors bornes : le numéro brut. */
export function formatIsoDay(day: number): string {
  return ISO_DAY_NAMES[day - 1] ?? `jour ${day}`;
}

/** Date civile en toutes lettres, ex. `lundi 17 août 2026`. */
export function formatCivilDate(date: string): string {
  return civilDateFormatter.format(new Date(Date.parse(`${date}T00:00:00Z`)));
}

/** Pourcentage signé au dixième, ex. `+4,2 %` — le signe porte le sens (dérive). */
export function formatSignedPercent(value: number): string {
  return `${value >= 0 ? '+' : '-'}${formatNumber(Math.abs(value), 1)} %`;
}

/** Écart de jours entre deux dates civiles, pour dater une comparaison. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** « il y a 12 jours », « hier », « aujourd'hui ». */
export function formatDaysAgo(date: string, today: string): string {
  const days = daysBetween(date, today);
  if (days <= 0) return "aujourd'hui";
  if (days === 1) return 'hier';
  return `il y a ${days} jours`;
}

/*
 * Déroulé structuré d'une séance, pour les prompts.
 */

/**
 * Rôles en toutes lettres. Le rôle `run` n'est pas nommé : c'est le cas
 * ordinaire, et le préfixer coûterait un mot par étape d'effort pour ne rien
 * lever d'ambigu.
 */
const STEP_ROLE_LABELS: Record<PlanStepRole, string> = {
  warmup: 'échauffement',
  run: '',
  recover: 'récup',
  cooldown: 'retour au calme',
};

/**
 * Mesure d'une étape, **dans les unités du contrat** : mètres et secondes, sans
 * conversion ni virgule décimale.
 *
 * `2,0 km` ou `15 min` se lirait mieux, mais le prompt impose des mètres et des
 * secondes dans `steps` : le modèle relit ce déroulé pour réécrire la séance
 * lors d'un ajustement, et un petit modèle qui recopie `2,0` produit une sortie
 * hors schéma. La séance, elle, garde ses kilomètres et ses minutes — c'est là
 * que le contrat les attend.
 */
function formatStepMeasure(step: PlanStep): string {
  if (step.distanceM !== null) return `${Math.round(step.distanceM)} m`;
  // Le schéma garantit l'autre mesure quand la distance manque.
  return step.durationS === null ? '' : `${Math.round(step.durationS)} s`;
}

/**
 * Cible de l'étape : allure (`@ 4:00–4:10/km`) ou zone cardiaque (`@ Z2`), et
 * rien du tout sur une étape sans consigne. Les deux sont exclusives par
 * construction, cf. `lib/plan-steps/schema`.
 */
function formatStepTarget(step: PlanStep): string {
  if (step.paceMinSecPerKm !== null && step.paceMaxSecPerKm !== null) {
    const fast = formatPace(step.paceMinSecPerKm);
    const slow = formatPace(step.paceMaxSecPerKm);
    // Une seule fois l'unité sur une fourchette : `4:00–4:10/km` se lit mieux
    // que `4:00/km–4:10/km`, et coûte trois tokens de moins.
    return fast === slow ? ` @ ${fast}` : ` @ ${fast.replace('/km', '')}–${slow}`;
  }
  if (step.hrZone !== null) return ` @ Z${step.hrZone}`;
  return '';
}

function formatStep(step: PlanStep): string {
  const label = STEP_ROLE_LABELS[step.role];
  const prefix = label === '' ? '' : `${label} `;
  return `${prefix}${formatStepMeasure(step)}${formatStepTarget(step)}`;
}

function formatStepBlock(block: PlanStepBlock): string {
  const inner = block.steps.map(formatStep).join(' + ');
  return block.repeat > 1 ? `${block.repeat} × (${inner})` : inner;
}

/**
 * Le déroulé d'une séance sur **une ligne**, ex. `échauffement 900 s @ Z2 +
 * 6 × (400 m @ 3:40/km + récup 90 s) + retour au calme 600 s`.
 *
 * Destiné au prompt d'ajustement : le modèle doit pouvoir réécrire une séance
 * en sachant ce qu'elle contient déjà. Les notes des étapes sont volontairement
 * omises — elles peuvent faire 200 caractères chacune, et le déroulé chiffré
 * suffit à décider ce qu'on garde.
 */
export function formatPlanSteps(steps: PlanSessionSteps): string {
  return steps.map(formatStepBlock).join(' + ');
}

/*
 * Table d'allures VDOT, pour les prompts.
 */

/**
 * Distances de référence en toutes lettres.
 *
 * Volontairement distinctes des libellés du formulaire (`plan/_lib/form-options`)
 * pour la raison donnée en tête de fichier : là-bas c'est une option de liste
 * déroulante (« Semi »), ici une phrase que le modèle relit (« un semi-marathon »).
 */
const REFERENCE_DISTANCE_LABELS: Record<ReferenceDistance, string> = {
  '5k': '5 km',
  '10k': '10 km',
  half: 'semi-marathon',
  marathon: 'marathon',
};

/** Une plage d'allure, ex. `5:35–6:10/km` — l'unité une seule fois, comme dans un déroulé. */
export function formatPaceRange(zone: PaceZone): string {
  const fast = formatPace(zone.minSecPerKm);
  const slow = formatPace(zone.maxSecPerKm);
  return fast === slow ? fast : `${fast.replace('/km', '')}–${slow}`;
}

/**
 * La table d'allures d'entraînement, telle que le prompt la **prescrit**.
 *
 * Comptez ~110 tokens : c'est le prix d'un plan dont les allures sont calculées
 * (Daniels, méthode VDOT) plutôt que devinées par le modèle à partir d'une allure
 * d'entraînement moyenne — la cause des « allures délirantes » constatées.
 *
 * Les cinq créneaux sont nommés par leur lettre **et** par leur usage : un petit
 * modèle qui lit « T » sans glose ne fait pas le lien avec le mot « seuil » qu'il
 * écrira dans `kind`.
 */
export function formatTrainingPaces(
  paces: TrainingPaces,
  race: { distance: ReferenceDistance; timeS: number },
): string {
  return [
    `Chrono de référence : ${REFERENCE_DISTANCE_LABELS[race.distance]} en ${formatClockTime(race.timeS)} → VDOT ${formatNumber(paces.vdot, 1)}.`,
    `- E (endurance fondamentale, sortie longue) : ${formatPaceRange(paces.easy)}`,
    `- M (allure marathon, allure objectif) : ${formatPaceRange(paces.marathon)}`,
    `- T (seuil) : ${formatPaceRange(paces.threshold)}`,
    `- I (VMA) : ${formatPaceRange(paces.interval)}`,
    `- R (répétitions courtes) : ${formatPaceRange(paces.repetition)}`,
  ].join('\n');
}

/*
 * Volumes hebdomadaires cibles, pour les prompts.
 */

/**
 * Un volume cible, **toujours au dixième de kilomètre**.
 *
 * L'arrondi à l'entier au-dessus de 10 km a été retiré, et ce n'est pas une
 * question de goût. Ce qui contraint le chiffre annoncé n'est pas la bande de
 * ±10 % — large — mais la **marge d'un dixième** que le planificateur laisse
 * sous ses plafonds (`floorKm` dans `plan-schema.ts`) : semaine allégée à 0,85 ×
 * exactement, ancrage de la première semaine pleine sur le volume réellement
 * couru, hausse maximale. Un dixième arrondi vers le haut consomme toute cette
 * marge : des cibles 23,9 / 25,8 / 27,8 / 23,6 imprimées « 24 · 26 · 28 · 24 »
 * font une allégée à 0,857 de la semaine précédente, au-dessus des 0,85 permis —
 * et le plan qui recopie fidèlement les chiffres du prompt se fait refuser. Sur
 * la grille exhaustive des configurations, 2 716 combinaisons sur 4 860 étaient
 * dans ce cas.
 *
 * Le dixième coûte un token de plus par semaine. Le test de bout en bout de
 * `plan-schema.test.ts` rejoue toute la grille sur les valeurs **imprimées** :
 * c'est lui qui interdit d'y revenir.
 */
function formatTargetKm(km: number): string {
  return `${formatNumber(km, 1)} km`;
}

/**
 * Les volumes hebdomadaires cibles, en **une ligne** : `S1 ~14 km (≈1 h 56) ·
 * S2 ~15 km (≈2 h 04) · …`.
 *
 * C'est la consigne la plus chargée du prompt de génération — une donnée par
 * semaine du plan — d'où la compacité : ~12 tokens par semaine, contre la
 * cinquantaine qu'une phrase par semaine coûterait. Sur seize semaines, l'écart
 * décide de la place qui reste pour le plan lui-même.
 *
 * Le temps accompagne les kilomètres parce que c'est lui la contrainte de vie :
 * « 45 km » ne dit rien à qui a deux heures par semaine, « 45 km (≈4 h 30) » si.
 *
 * La seconde ligne rétablit ce que « à ±10 % » laissait croire : la bande est le
 * critère de **refus**, pas un espace où se promener. Les règles de progression
 * se vérifient sur les volumes réellement écrits, or une montée visée à 8 %
 * contre un plafond de 12 % ne tolère qu'environ 1,8 % de jeu relatif entre deux
 * semaines, et une allégée posée à 0,85 × exactement n'en tolère aucun — deux
 * semaines tirées au hasard dans leur bande sont refusées à peu près à coup sûr
 * (493 fois sur 500, mesuré). Le prompt annonce donc la cible comme un chiffre à
 * viser, la tolérance comme un filet.
 *
 * @param firstWeekNumber numéro de la première semaine listée, dans la
 * numérotation du **plan entier** : une tranche annonce S7 à S11, pas S1 à S5.
 */
export function formatWeeklyVolumeTargets(
  targets: readonly { targetKm: number; targetMinutes: number }[],
  firstWeekNumber = 1,
): string {
  const cells = targets.map(
    (target, index) =>
      `S${firstWeekNumber + index} ~${formatTargetKm(target.targetKm)} (≈${formatDuration(target.targetMinutes * 60)})`,
  );
  return [
    `Volumes hebdomadaires cibles (à ±10 %) : ${cells.join(' · ')}`,
    'Vise CHAQUE cible au plus près — la tolérance de ±10 % est un filet, pas un espace de liberté : ' +
      'les règles de progression (hausse ≤ 12 %, semaine allégée à 85 %) se vérifient sur les volumes ' +
      'réellement écrits, semaine contre semaine.',
  ].join('\n');
}

/*
 * Décomposition d'une cible hebdomadaire entre les séances, pour les prompts.
 */

/**
 * Ce qu'une séance est, du point de vue de la décomposition d'un volume
 * hebdomadaire.
 *
 * Trois rôles et pas la typologie complète : ce qui décide de la part d'une
 * séance dans sa semaine, c'est qu'elle soit la sortie longue, une séance de
 * qualité (échauffement et récupérations comprises) ou un footing — pas qu'elle
 * soit du seuil ou de la VMA.
 */
export type SessionBudgetRole = 'long' | 'quality' | 'easy';

/**
 * Le budget d'**une** séance, en kilomètres.
 *
 * Le type vit ici, et non dans `plan-schema.ts` où `weeklySessionBudgets` le
 * produit : ce module est la feuille de l'arbre de dépendances (`plan-schema`
 * l'importe déjà), l'inverse fermerait un cycle.
 */
export type SessionBudget = { role: SessionBudgetRole; km: number };

/** La décomposition d'**une** semaine, telle que le prompt l'imprime. */
export type WeeklySessionBudget = {
  /** Numéro de la semaine dans la numérotation du **plan entier**. */
  weekNumber: number;
  targetKm: number;
  /** Les séances, sortie longue en tête puis qualité puis footings. */
  sessions: readonly SessionBudget[];
};

/**
 * Un groupe de séances de même rôle : `qualité ~4,5 km`, `4 footings ~3,5 km ≈ 26 min`.
 *
 * Un seul chiffre pour tout le groupe — celui de la première séance : les
 * séances d'un même rôle portent le même budget, à un dixième de kilomètre près
 * sur les footings, qui absorbent le reliquat de la division.
 * Le compte n'est écrit que quand il y en a plusieurs, et le pluriel avec.
 *
 * @param easyPaceSecPerKm l'allure d'endurance qui convertit ces kilomètres en
 * minutes, `null` pour ne pas écrire de durée du tout — c'est le cas du groupe
 * de qualité, dont la durée dépend de la structure de la séance (échauffement,
 * récupérations, retour au calme) et non de son seul kilométrage. Annoncer
 * « 3,0 km ≈ 13 min » sur une VMA serait faux d'un facteur trois.
 */
function formatBudgetGroup(
  sessions: readonly SessionBudget[],
  singular: string,
  plural: string,
  easyPaceSecPerKm: number | null,
): string | null {
  const first = sessions[0];
  if (first === undefined) return null;
  const label = sessions.length === 1 ? singular : `${sessions.length} ${plural}`;
  const distance = `${label} ~${formatNumber(first.km, 1)} km`;
  return easyPaceSecPerKm === null
    ? distance
    : `${distance} ≈ ${formatDuration(first.km * easyPaceSecPerKm)}`;
}

/**
 * La décomposition de chaque cible **entre ses séances**, une ligne par
 * semaine : `S1 (~27,2 km) : SL sam ~8,0 km ≈ 1 h 00 · qualité ~4,5 km ·
 * 4 footings ~3,7 km ≈ 28 min`.
 *
 * Ce qu'elle corrige, constaté sur les premiers plans de production : le modèle
 * reçoit une cible hebdomadaire et écrit des semaines à 44 puis 70 km pour des
 * cibles de 27 à 37 — non par désobéissance, mais parce que « répartir 27 km
 * sur 6 séances dont une sortie longue et une séance de qualité » est une
 * division qu'un petit modèle ne pose pas de tête. L'appli la pose pour lui,
 * comme elle pose déjà les volumes hebdomadaires et les allures.
 *
 * Compacité : une ligne par semaine, groupée par rôle — pas une ligne par
 * séance. Comptez ~25 tokens par semaine, à comparer aux ~12 de la ligne des
 * cibles seules ({@link formatWeeklyVolumeTargets}).
 *
 * Les chiffres imprimés **tombent sur la cible** — à un dixième de kilomètre
 * près, ce que la répartition du reliquat sur les footings laisse d'écart entre
 * le chiffre d'un groupe et la somme réelle (cf. `weeklySessionBudgets`). Une
 * aide au calcul dont la somme ne fait pas son total ferait écrire au modèle des
 * semaines systématiquement sous leur cible.
 *
 * Les **durées** accompagnent les kilomètres depuis le constat de production
 * suivant : à 4 h de budget pour 6 séances, le modèle recevait « ~2,3 km » par
 * footing et écrivait des semaines à 40-49 km pour des cibles de 19 à 31. Un
 * kilométrage ne dit rien à ses priors ; « ≈ 17 min » leur parle directement,
 * parce que c'est en durée qu'il se représente une sortie. Le groupe de qualité
 * n'en porte pas — sa durée dépend de sa structure, pas de son kilométrage.
 *
 * @param longRunDay jour ISO de la sortie longue — la seule séance dont le
 * décompte nomme le jour, parce que c'est le seul qui soit imposé.
 * @param easyPaceSecPerKm l'allure d'endurance qui convertit ces kilomètres en
 * minutes — la même que celle des cibles hebdomadaires, sans quoi les deux
 * lignes du prompt se contrediraient.
 */
export function formatWeeklySessionBudgets(
  weeks: readonly WeeklySessionBudget[],
  longRunDay: number,
  easyPaceSecPerKm: number,
): string {
  const day = ISO_DAY_SHORT_NAMES[longRunDay - 1] ?? formatIsoDay(longRunDay);

  const rows = weeks.map((week) => {
    const of = (role: SessionBudgetRole) => week.sessions.filter((session) => session.role === role);
    const cells = [
      formatBudgetGroup(of('long'), `SL ${day}`, `SL ${day}`, easyPaceSecPerKm),
      formatBudgetGroup(of('quality'), 'qualité', 'qualité', null),
      formatBudgetGroup(of('easy'), 'footing', 'footings', easyPaceSecPerKm),
    ].filter((cell): cell is string => cell !== null);

    return `S${week.weekNumber} (~${formatNumber(week.targetKm, 1)} km) : ${cells.join(' · ')}`;
  });

  return [
    'Décomposition de chaque cible entre ses séances (échauffement et récupérations compris) — ' +
      'ces chiffres tombent exactement sur la cible, pars de là plutôt que de refaire la division. ' +
      'Les durées (≈) sont celles de ces kilomètres courus en endurance : écris des séances de cette ' +
      'longueur-là, même si elles te paraissent courtes :',
    ...rows,
  ].join('\n');
}

/** Le profil sur une ligne. Les champs absents ne sont pas mentionnés. */
function formatProfile(profile: TrainingSnapshotDto['profile']): string {
  const parts: string[] = [];
  if (profile.ageYears !== undefined) parts.push(`${profile.ageYears} ans`);
  if (profile.sex !== undefined) parts.push(profile.sex === 'male' ? 'homme' : 'femme');
  if (profile.maxHrBpm !== undefined) parts.push(`FC max ${profile.maxHrBpm} bpm`);
  if (profile.restingHrBpm !== undefined) parts.push(`FC repos ${profile.restingHrBpm} bpm`);
  if (profile.weightKg !== undefined) parts.push(`${formatNumber(profile.weightKg, 1)} kg`);

  return parts.length === 0 ? 'Profil : non renseigné.' : `Profil : ${parts.join(' · ')}.`;
}

/** Ce que l'appelant retire du snapshot, quand son prompt ne doit pas le voir. */
export type SnapshotFormatOptions = {
  /**
   * Faire figurer l'« Allure moyenne des dernières sorties » ? `true` par
   * défaut — le feedback la garde, c'est la donnée qu'il commente.
   *
   * Les prompts de plan qui portent une table VDOT la retirent : constaté en
   * production, c'est **l'ancre parasite** du modèle local, qui prescrivait des
   * séances autour de cette allure d'entraînement lente au lieu d'appliquer la
   * table (cf. l'en-tête de `plan-schema.ts`). Les allures y étant désormais
   * posées par l'appli, la ligne n'a plus aucun rôle et ne peut plus qu'égarer.
   */
  withRecentPace?: boolean;
};

/**
 * L'état d'entraînement en quelques lignes — le bloc de contexte commun aux
 * prompts de génération de plan et de feedback.
 *
 * Ce qui n'est pas calculable est **dit comme tel**, jamais omis en silence :
 * c'est ce qui autorise le coach à annoncer un plan conservateur plutôt que
 * d'extrapoler une charge qu'il n'a pas. Comptez ~120 tokens.
 */
export function formatTrainingSnapshot(
  snapshot: TrainingSnapshotDto,
  options: SnapshotFormatOptions = {},
): string {
  const lines: string[] = [formatProfile(snapshot.profile)];

  lines.push(
    snapshot.fitness === null
      ? 'Charge (CTL/ATL/TSB) : non calculable, données insuffisantes.'
      : `Charge : CTL ${formatNumber(snapshot.fitness.ctl)} · ATL ${formatNumber(snapshot.fitness.atl)} · TSB ${formatNumber(snapshot.fitness.tsb)}.`,
  );

  lines.push(
    snapshot.vo2max === null
      ? 'VO2max estimée : non calculable.'
      : `VO2max estimée : ${formatNumber(snapshot.vo2max, 1)}.`,
  );

  if (snapshot.weeks.length > 0) {
    lines.push('Volume de course des dernières semaines :');
    for (const week of snapshot.weeks) {
      lines.push(
        `- semaine du ${week.startsOn} : ${formatNumber(week.distanceKm, 1)} km · ${formatDuration(week.movingTimeS)} · ${week.sessions} séance${week.sessions > 1 ? 's' : ''}`,
      );
    }
  }

  if (options.withRecentPace !== false) {
    lines.push(
      snapshot.recentAvgPaceSecPerKm === null
        ? 'Allure de référence : inconnue (aucune course récente).'
        : `Allure moyenne des dernières sorties : ${formatPace(snapshot.recentAvgPaceSecPerKm)}.`,
    );
  }

  return lines.join('\n');
}
