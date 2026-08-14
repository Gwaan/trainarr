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

import type {
  PlanContextDto,
  TrainingSnapshotDto,
  UpcomingSessionDto,
  WellnessContextDayDto,
  WellnessContextDto,
} from '@/data/coach-context';
import type { PaceZone } from '@/lib/metrics/vdot';
import type { PlanIntent } from '@/lib/plan-skeleton/intent';
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

/**
 * Une plage d'allure, ex. `5:35–6:10/km` — l'unité une seule fois, comme dans un déroulé. */
export function formatPaceRange(zone: PaceZone): string {
  const fast = formatPace(zone.minSecPerKm);
  const slow = formatPace(zone.maxSecPerKm);
  return fast === slow ? fast : `${fast.replace('/km', '')}–${slow}`;
}

/*
 * Décomposition d'une cible hebdomadaire entre les séances.
 *
 * Il n'en reste que les **types**. Les deux formateurs qui les imprimaient
 * (`formatWeeklyVolumeTargets`, `formatWeeklySessionBudgets`) n'existaient que
 * pour le prompt de plan entier, disparu avec la bascule sur squelette : l'appli
 * n'annonce plus ses chiffres au modèle, elle écrit les séances elle-même.
 * `plan-schema.ts` produit toujours ces budgets (`weeklySessionBudgets`), et
 * c'est le squelette qui les consomme.
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

/*
 * Contexte de plan — bloc **distinct** de l'état d'entraînement.
 *
 * Séparé de {@link formatTrainingSnapshot} à dessein : ce dernier alimente aussi
 * la génération de plan, la révision, le feedback et les tests chronométrés. Y
 * verser les séances rendrait le prompt de génération circulaire (le plan
 * décrivant le plan) et ferait bouger quatre prompts éprouvés. Un seul appelant
 * consomme ce qui suit : le chat.
 */

/** Ce que l'athlète prépare, en toutes lettres — un `intent` brut ne se lit pas. */
const PLAN_INTENT_LABELS: Record<PlanIntent, string> = {
  race: 'préparer une course',
  faster: 'courir plus vite',
  weight_loss: 'perdre du poids',
  return: 'reprendre la course',
};

/**
 * Le volume d'une séance : sa distance, à défaut sa durée, et rien quand elle ne
 * porte ni l'une ni l'autre — un « 0 km » serait une donnée inventée.
 */
function formatSessionVolume(session: UpcomingSessionDto): string {
  if (session.volumeM !== null) return ` · ${formatDistanceKm(session.volumeM)}`;
  if (session.durationS !== null) return ` · ${formatDuration(session.durationS)}`;
  return '';
}

/**
 * L'état d'une séance : ce qu'elle est **de fait**, en trois mots et sans
 * jugement.
 *
 * Trois états et non deux, depuis que la fenêtre remonte de quelques jours dans
 * le passé (cf. `COACH_RECENT_DAYS`) : une séance dont le jour est passé et que
 * rien n'a réalisée n'est ni « déjà courue » ni « à venir », et la confondre avec
 * l'une ou l'autre ferait dire au coach une chose fausse — soit qu'elle a été
 * faite, soit qu'il reste à la faire.
 *
 * La formulation reste strictement descriptive : « passée, non courue » énonce
 * un fait, là où « manquée » ou « sautée » y ajouterait un reproche. Ce que
 * cette séance-là veut dire, c'est au coach de le dire, pas au formateur.
 */
function formatSessionState(session: UpcomingSessionDto, today: string): string {
  if (session.done) return 'déjà courue';
  // Les dates civiles `YYYY-MM-DD` s'ordonnent lexicographiquement.
  return session.date < today ? 'passée, non courue' : 'à venir';
}

/**
 * Une séance sur une ligne : jour, état, type, intitulé, volume, déroulé.
 *
 * La date est écrite en toutes lettres, **jour de la semaine compris** : un petit
 * modèle raisonne mal sur `2026-08-13` (il ne sait pas que c'est un jeudi) alors
 * que la question posée est presque toujours « je cours quoi jeudi ? ».
 *
 * L'état vient en deuxième position, avant tout le reste : une séance déjà courue
 * qu'on annoncerait comme prochaine est exactement l'erreur que ce bloc existe
 * pour empêcher.
 */
function formatUpcomingSession(session: UpcomingSessionDto, today: string): string {
  const state = formatSessionState(session, today);
  // Le déroulé arrive brut du DAL : c'est ici, et non dans `src/data/`, que la
  // mise en forme des prompts se fait.
  const steps = session.steps === null ? '' : ` · ${formatPlanSteps(session.steps)}`;
  return `- ${formatCivilDate(session.date)} — ${state} · ${session.kind} : ${session.title}${formatSessionVolume(session)}${steps}`;
}

/**
 * Le plan actif et les séances qui entourent aujourd'hui, tels que le **chat**
 * les lit.
 *
 * Sans plan, la fonction le **dit** au lieu de rendre une chaîne vide : c'est
 * précisément ce qui permet au coach de répondre « tu n'as pas de plan en
 * cours » plutôt que de broder. Un bloc vide, lui, ne serait qu'un trou de plus —
 * et le trou est la cause du bug qu'on répare.
 *
 * Comptez ~50 tokens d'en-tête, ~25 par séance sans déroulé et ~60 avec, soit
 * ~340 tokens sur une fenêtre à six séances dont trois de qualité (1 024
 * caractères mesurés, ~3 caractères par token en français — le même ratio que
 * les ~120 tokens de {@link formatTrainingSnapshot}). Les trois jours de passé
 * récent y ajoutent au plus une séance ou deux. Sans plan : ~15 tokens. Un ordre
 * de grandeur à retenir : le bloc pèse trois fois l'état d'entraînement, et
 * c'est le prix du seul contexte qui répond à « c'est quoi ma prochaine
 * séance ? ».
 */
export function formatPlanContext(context: PlanContextDto): string {
  if (!context.hasPlan) {
    return ['Aucun plan actif.', "Aucune séance n'est planifiée."].join('\n');
  }

  const lines: string[] = [`Plan actif — objectif : ${PLAN_INTENT_LABELS[context.goal.intent]}.`];

  if (context.goal.note !== null) {
    lines.push(`Note de l'athlète sur son objectif : « ${context.goal.note} ».`);
  }
  if (context.raceDate !== null) {
    lines.push(`Course le ${formatCivilDate(context.raceDate)}.`);
  }
  lines.push(`Dernier jour du plan : ${formatCivilDate(context.endsOn)}.`);

  if (context.upcoming.length === 0) {
    // Un plan actif dont la fenêtre est vide (fin de plan, semaine de coupure)
    // est un fait à énoncer : sans cette ligne, le bloc s'arrêterait sur
    // l'échéance et laisserait le modèle deviner ce qu'il y a entre les deux.
    lines.push("Aucune séance planifiée ces jours-ci.");
    return lines.join('\n');
  }

  lines.push(
    'Séances des derniers et des prochains jours — cette liste est complète, tu ne connais aucune autre séance :',
  );
  for (const session of context.upcoming) {
    lines.push(formatUpcomingSession(session, context.today));
  }

  return lines.join('\n');
}

/*
 * Bien-être récent — bloc **distinct** lui aussi, et pour la même raison que le
 * plan : il n'entre que dans le prompt du chat, jamais dans l'état
 * d'entraînement partagé par la génération, la revue, le feedback et les tests.
 */

/** Les mesures d'un relevé, dans l'ordre où elles se lisent, avec leur unité. */
const WELLNESS_MEASURES: readonly {
  label: string;
  read: (day: WellnessContextDayDto) => string | null;
}[] = [
  {
    label: 'FC de repos',
    read: (day) => (day.restingHrBpm === null ? null : `${day.restingHrBpm} bpm`),
  },
  {
    // « rMSSD » explicite : c'est la seule façon d'empêcher un modèle de comparer
    // cette valeur à un score de HRV d'une autre échelle.
    label: 'HRV (rMSSD)',
    read: (day) => (day.hrvRmssdMs === null ? null : `${formatNumber(day.hrvRmssdMs, 0)} ms`),
  },
  {
    label: 'sommeil',
    read: (day) => (day.sleepTimeS === null ? null : formatDuration(day.sleepTimeS)),
  },
  {
    label: 'score de sommeil',
    read: (day) => (day.sleepScore === null ? null : `${formatNumber(day.sleepScore, 0)}/100`),
  },
  { label: 'poids', read: (day) => (day.weightKg === null ? null : `${formatNumber(day.weightKg, 1)} kg`) },
];

/** Une journée sur une ligne : sa date, puis ses seules mesures existantes. */
function formatWellnessDay(day: WellnessContextDayDto): string {
  const measures = WELLNESS_MEASURES.map((measure) => {
    const value = measure.read(day);
    return value === null ? null : `${measure.label} ${value}`;
  }).filter((measure): measure is string => measure !== null);

  return `- ${formatCivilDate(day.date)} — ${measures.join(' · ')}`;
}

/**
 * Le bien-être des derniers jours, tel que le **chat** le lit.
 *
 * Trois précautions, et chacune répare une faute qu'un petit modèle commet
 * spontanément devant ces chiffres :
 *
 * 1. **La provenance est écrite** : ces mesures viennent de la montre, pas d'un
 *    calcul de Trainarr. Sans ça, le modèle les traite comme les indicateurs
 *    qu'il voit ailleurs dans le prompt et se met à en « déduire » une charge.
 * 2. **Les mesures jamais renseignées sont nommées**, une fois, en fin de bloc :
 *    une HRV absente de toutes les lignes se lit sinon comme un oubli de
 *    formatage, et un modèle qui veut bien faire en invente une valeur.
 * 3. **La fenêtre est bornée à l'écrit** : ce qui n'est pas listé n'existe pas
 *    pour lui.
 *
 * Comptez ~35 tokens d'en-tête et ~30 par journée — soit ~250 tokens sur une
 * semaine complète, l'ordre de grandeur de l'état d'entraînement. Sans mesure :
 * ~20 tokens.
 */
export function formatWellnessContext(context: WellnessContextDto): string {
  if (context.days.length === 0) {
    return [
      'Aucune mesure de bien-être sur les 7 derniers jours.',
      "Tu ne sais donc rien de son sommeil, de sa HRV ni de sa FC de repos récente : ne les commente pas.",
    ].join('\n');
  }

  const lines = [
    'Relevés de sa montre (Trainarr ne les calcule pas, il les rapatrie) — cette liste est complète, tu ne connais aucune autre mesure :',
    ...context.days.map(formatWellnessDay),
  ];

  const missing = WELLNESS_MEASURES.filter((measure) =>
    context.days.every((day) => measure.read(day) === null),
  ).map((measure) => measure.label);

  if (missing.length > 0) {
    lines.push(`Jamais mesuré sur cette période : ${missing.join(', ')}.`);
  }

  return lines.join('\n');
}
