/**
 * Mise en forme du calendrier d'entraînement — fonctions pures, testées.
 *
 * Un seul modèle pour **deux mises en page** : l'agenda vertical du téléphone et
 * la grille de sept colonnes du grand écran ne diffèrent que par leur CSS. Tout
 * ce qui se décide — le découpage en semaines, le rangement des séances et des
 * sorties par jour, les libellés, le volume d'une semaine, l'état d'une séance —
 * se calcule ici, une fois, et se teste sans monter le moindre composant.
 *
 * Les dates manipulées sont des dates civiles `YYYY-MM-DD` : leur repère de
 * calcul est minuit UTC et leur formatage se fait dans le fuseau de l'athlète
 * (cf. `lib/dates/civil.ts`). Aucun `server-only` : ce module est lu par le
 * composant client du calendrier, qui reconstruit le modèle à chaque
 * déplacement optimiste.
 */

/*
 * Les libellés de séance et le total d'un déroulé restent chez le **plan** :
 * c'est lui qui écrit ces séances, et deux définitions du volume d'une séance
 * finiraient par diverger. Le calendrier, lui, ne fait que les afficher.
 */
import {
  formatCivilDay,
  formatDayNumber,
  formatWeekdayShort,
  ISO_DAY_LABELS,
} from "@/app/(app)/plan/_lib/format-plan";
import { planSessionTotals } from "@/app/(app)/plan/_lib/session-detail";
import { APP_TIME_ZONE } from "@/config/time";
import type {
  CalendarActivityDto,
  CalendarDayWeatherDto,
  CalendarSessionDto,
} from "@/data/calendar";
import type { WeatherForecastDto } from "@/data/weather-forecast";
import { sessionPaceZone } from "@/lib/ai/plan-schema";
import { civilDateToMs, shiftCivilDate } from "@/lib/dates/civil";
import { SESSION_KINDS } from "@/lib/plan-skeleton";
import { resolveDayForecast, type DailyForecast } from "@/lib/weather/forecast-plan";
import { describeWeatherCode, type WeatherIconName } from "@/lib/weather/wmo";

import {
  capitalize,
  formatDistance,
  formatDuration,
  formatFullDate,
} from "../../_lib/format";
import {
  ACTIVITY_WEATHER_ABSENCE,
  FORECAST_ABSENCE,
  formatObservationHour,
  formatPercent,
  formatPrecipitation,
  formatTemperature,
  formatTemperatureCompact,
  formatTemperatureRange,
} from "../../_lib/format-weather";

/**
 * Bornes du plan actif, telles que le calendrier les reçoit du DAL.
 *
 * Redéclarées ici plutôt qu'importées de `CalendarRangeDto` : c'est tout ce dont
 * la mise en forme a besoin, et le composant client ne doit pas dépendre de la
 * forme complète d'une lecture serveur.
 */
export type CalendarPlanBounds = {
  startsOn: string;
  /** Dernier jour couvert, **inclus**. */
  endsOn: string;
  raceDate: string | null;
  /** Jour ISO de la sortie longue : 1 = lundi … 7 = dimanche. */
  longRunDay: number;
};

/**
 * Où en est une séance — trois états, et trois seulement.
 *
 * « Aujourd'hui » n'en est pas un : c'est le **jour** qui se distingue, pas la
 * séance. Une séance du jour non courue est encore à venir, et c'est bien ce
 * qu'on veut lire.
 */
export type CalendarSessionState = "completed" | "missed" | "upcoming";

/**
 * Ce que la séance pèse dans la semaine, et donc le traitement qu'elle reçoit.
 *
 * Le système n'a **qu'un seul accent** : il ne sert donc pas à distinguer cinq
 * types de séance, mais à repérer les deux qui structurent le plan — la course
 * objectif et les journées dures (qualité, sortie longue, test chronométré).
 */
export type CalendarSessionEmphasis = "race" | "hard" | "normal";

export type CalendarSessionView = {
  id: number;
  date: string;
  kind: string;
  title: string;
  /** `12,4 km · 1 h 05`, réduit à ce qui est connu — `null` si rien ne l'est. */
  summary: string | null;
  state: CalendarSessionState;
  emphasis: CalendarSessionEmphasis;
  /** Déplaçable : ni courue, ni passée. */
  movable: boolean;
  /** Ce qu'annonce un lecteur d'écran, ex. « Seuil, 6 × 800 m ». */
  label: string;
};

/**
 * Une sortie réellement courue qu'aucune séance ne réalise.
 *
 * Pas de `sportType` : le DAL le rend en anglais brut, tel qu'il sort du fichier
 * FIT (`Run`, `TrailRun`, `Ride`), et l'interface est en français. Le nom de
 * l'activité dit déjà ce que c'était.
 */
export type CalendarActivityView = {
  id: number;
  date: string;
  name: string;
  /** `10,2 km · 52 min` — ce qui a réellement été couru. */
  summary: string | null;
};

/**
 * La météo d'une case de calendrier.
 *
 * **Une icône et une température**, pas davantage : la place est comptée, et une
 * case de 50 px de large sur téléphone doit d'abord montrer la séance. Le détail
 * (ressenti, vent, cumul de pluie, heure du relevé) vit sur la page de
 * l'activité et sur la séance du jour du tableau de bord, où il a la place
 * d'être écrit proprement.
 *
 * `label` porte la phrase entière — celle que lit un lecteur d'écran et celle
 * qu'affiche l'infobulle. C'est **toujours** une phrase, et elle dit d'où elle
 * vient : une mesure et une estimation ne se lisent pas pareil. Quand il n'y a
 * ni l'une ni l'autre, elle dit pourquoi — un blanc se lirait « beau temps ».
 */
export type CalendarDayWeather = {
  /** `null` quand il n'y a rien à afficher : rien à dessiner, mais tout à dire. */
  icon: WeatherIconName | null;
  /** `25°` — la mesure du jour passé, la maximale prévue sinon. */
  temperature: string | null;
  label: string;
};

export type CalendarDayView = {
  date: string;
  /** `10` */
  dayNumber: string;
  /** `Lun` */
  weekdayLabel: string;
  /** `lundi 10 août` — l'`aria-label` de la case et le sujet des annonces. */
  label: string;
  isToday: boolean;
  /** Faux pour les jours de débord, ceux qui complètent la première et la dernière semaine. */
  inMonth: boolean;
  /** Le plan actif couvre-t-il ce jour ? Hors bornes, aucun dépôt n'est permis. */
  inPlan: boolean;
  isRaceDay: boolean;
  sessions: CalendarSessionView[];
  activities: CalendarActivityView[];
  /**
   * La météo du jour : **relevée** quand il a été couru, **prévue** quand il est
   * à venir (cf. {@link dayWeather}).
   *
   * `null` quand il n'y a ni l'une ni l'autre **et** que le jour est vide : un
   * mois entier de tirets à quarante jours d'échéance ne dirait rien de plus
   * qu'une case nue. Dès qu'un jour porte une séance ou une sortie, l'absence,
   * elle, s'écrit et se justifie.
   */
  weather: CalendarDayWeather | null;
};

export type CalendarWeekView = {
  startsOn: string;
  endsOn: string;
  /** `Semaine du 10 août` */
  label: string;
  /** Somme des volumes annoncés, `null` si aucune séance n'en porte. */
  volumeM: number | null;
  isCurrent: boolean;
  /** Toujours sept, du lundi au dimanche. */
  days: CalendarDayView[];
};

/** En-tête de la grille de sept colonnes : `Lun` … `Dim`. */
export const WEEKDAY_HEADERS: readonly string[] = ISO_DAY_LABELS.map((label) =>
  label.slice(0, 3),
);

/**
 * La séance mérite-t-elle l'accent, et à quel titre ?
 *
 * Le classement vient de `sessionPaceZone` — la fonction qui décide déjà des
 * allures prescrites, donc celle qui dit ce qu'une séance **est** dans cette
 * appli — et de `SESSION_KINDS`, le vocabulaire que le squelette écrit. C'est la
 * même lecture que `lib/plan-calendar/move-rules.ts` fait pour ses journées
 * dures : deux définitions du mot « dur » finiraient par diverger.
 */
export function sessionEmphasis(kind: string): CalendarSessionEmphasis {
  if (kind === SESSION_KINDS.race) return "race";
  if (kind === SESSION_KINDS.longRun) return "hard";
  return sessionPaceZone(kind) === "easy" ? "normal" : "hard";
}

/** Où en est la séance — `completed` prime, une séance courue est de l'histoire. */
export function calendarSessionState(
  session: Pick<CalendarSessionDto, "date" | "completed">,
  today: string,
): CalendarSessionState {
  if (session.completed) return "completed";
  // Comparaison lexicographique : sur des dates civiles `YYYY-MM-DD` bien
  // formées, elle coïncide avec l'ordre chronologique.
  return session.date < today ? "missed" : "upcoming";
}

/**
 * `12,4 km · 1 h 05` — le volume annoncé par le plan, sinon celui que le déroulé
 * totalise. Rien n'est estimé : `planSessionTotals` ne rend que ce qui est écrit.
 */
function sessionSummary(session: CalendarSessionDto): string | null {
  const { distanceM, durationS } = planSessionTotals(session);
  const parts: string[] = [];
  if (distanceM !== null) parts.push(formatDistance(distanceM));
  if (durationS !== null) parts.push(formatDuration(durationS));
  return parts.length === 0 ? null : parts.join(" · ");
}

export function toCalendarSessionView(
  session: CalendarSessionDto,
  today: string,
): CalendarSessionView {
  return {
    id: session.id,
    date: session.date,
    kind: session.kind,
    title: session.title,
    summary: sessionSummary(session),
    state: calendarSessionState(session, today),
    emphasis: sessionEmphasis(session.kind),
    // Recalculé plutôt que repris du DTO : après un déplacement optimiste, la
    // date affichée n'est plus celle que le serveur avait jugée. La formule est
    // celle du DAL (`toCalendarSessionDto`), au caractère près.
    movable: !session.completed && session.date >= today,
    label: `${session.kind}, ${session.title}`,
  };
}

function activitySummary(activity: CalendarActivityDto): string | null {
  const parts: string[] = [];
  if (activity.distanceM > 0) parts.push(formatDistance(activity.distanceM));
  if (activity.movingTimeS > 0) parts.push(formatDuration(activity.movingTimeS));
  return parts.length === 0 ? null : parts.join(" · ");
}

export function toCalendarActivityView(activity: CalendarActivityDto): CalendarActivityView {
  return {
    id: activity.id,
    date: activity.date,
    name: activity.name,
    summary: activitySummary(activity),
  };
}

const monthLabelFormatter = new Intl.DateTimeFormat("fr-FR", {
  month: "long",
  year: "numeric",
  timeZone: APP_TIME_ZONE,
});

/** `Août 2026` — l'intitulé du mois affiché, capitale initiale comprise. */
export function formatMonthLabel(month: string): string {
  return capitalize(monthLabelFormatter.format(new Date(civilDateToMs(`${month}-01`))));
}

/** `lundi 10 août` — la date entière, en minuscules comme le reste de l'appli. */
export function formatDayLabel(civilDate: string): string {
  return formatFullDate(new Date(civilDateToMs(civilDate)));
}

/** `Semaine du 10 août` — l'intitulé que porte chaque bloc de sept jours. */
export function formatWeekLabel(weekStart: string): string {
  return `Semaine du ${formatCivilDay(weekStart)}`;
}

/**
 * `« 6 × 800 m » est passée au mardi 11 août.` — le détail du bandeau qui suit
 * un déplacement.
 *
 * Rédigé à partir de la **date seule**, jamais d'un libellé cherché dans la
 * grille affichée : entre la soumission et la réponse du serveur, l'athlète a pu
 * changer de mois, et une grille qui ne contient plus ce jour-là rendrait alors
 * une date ISO brute (« est passée au 2026-08-12 ») dans une interface
 * française. {@link formatDayLabel} nomme n'importe quel jour civil, à l'écran
 * ou non.
 */
export function formatMoveDetail(title: string, toDate: string): string {
  return `« ${title} » est passée au ${formatDayLabel(toDate)}.`;
}

/** Une absence : pas d'icône, pas de valeur, mais une phrase qui la justifie. */
function weatherAbsence(label: string): CalendarDayWeather {
  return { icon: null, temperature: null, label };
}

/** Ce qu'a donné le relevé d'une sortie du jour. */
function observedWeather(observation: CalendarDayWeatherDto): CalendarDayWeather {
  const condition = describeWeatherCode(observation.weatherCode);
  const measured =
    observation.temperatureC === null
      ? condition.label
      : `${condition.label}, ${formatTemperature(observation.temperatureC)}`;
  /*
   * L'heure du relevé plutôt que le jour : le jour, c'est la case elle-même. Et
   * c'est elle qui dit que la phrase est une **mesure** — la prévision, en face,
   * s'annonce « Météo prévue ». Le repli n'arrive pas en pratique (un relevé
   * `observed` porte toujours son heure, cf. `ActivityWeatherDto`) mais il ne
   * doit pas laisser une observation passer pour un bulletin.
   */
  const reading =
    observation.observedAt === null
      ? "Météo relevée"
      : formatObservationHour(observation.observedAt);

  return {
    icon: condition.icon,
    temperature:
      observation.temperatureC === null
        ? null
        : formatTemperatureCompact(observation.temperatureC),
    label: `${measured}. ${reading}.`,
  };
}

/** Ce qu'annonce la prévision d'un jour à venir. */
function forecastWeather(day: DailyForecast): CalendarDayWeather {
  const condition = describeWeatherCode(day.weatherCode);

  const sentences = [
    day.temperatureMinC === null || day.temperatureMaxC === null
      ? `Météo prévue : ${condition.label}`
      : `Météo prévue : ${condition.label}, ${formatTemperatureRange(day.temperatureMinC, day.temperatureMaxC)}`,
  ];

  // « du jour », toujours : c'est un cumul de journée, pas la pluie qui tombera
  // pendant la séance.
  if (day.precipitationSumMm !== null && day.precipitationSumMm > 0) {
    const probability =
      day.precipitationProbabilityMaxPct === null
        ? ""
        : ` (${formatPercent(day.precipitationProbabilityMaxPct)})`;
    sentences.push(
      `Pluie du jour : ${formatPrecipitation(day.precipitationSumMm)}${probability}`,
    );
  }

  return {
    icon: condition.icon,
    // La maximale : c'est elle qui décide de la tenue d'une sortie de journée.
    temperature:
      day.temperatureMaxC === null ? null : formatTemperatureCompact(day.temperatureMaxC),
    label: `${sentences.join(". ")}.`,
  };
}

/**
 * La météo d'une journée du calendrier — **une mesure, une estimation, ou une
 * raison de n'avoir ni l'une ni l'autre**.
 *
 * L'ordre est celui de la certitude, et il vaut pour tous les jours :
 *
 * 1. **le relevé de la sortie du jour**, s'il a mesuré quelque chose. C'est une
 *    observation : elle bat n'importe quelle estimation du même jour, y compris
 *    celle d'aujourd'hui — le temps qu'il a fait pendant la séance n'est plus
 *    une question ouverte ;
 * 2. **la prévision**, pour aujourd'hui et les jours suivants, dans la limite
 *    des seize jours d'Open-Meteo. Un tapis de course ce matin ne doit pas
 *    effacer le bulletin de la séance de ce soir : c'est pourquoi un relevé sans
 *    mesure ne court-circuite pas cette étape sur un jour non passé ;
 * 3. **l'absence, et son motif**, dans le vocabulaire qui existe déjà —
 *    `ACTIVITY_WEATHER_ABSENCE` pour un relevé qui n'a rien pu mesurer,
 *    `FORECAST_ABSENCE` pour le reste (au-delà de l'horizon, relevé du matin en
 *    panne, jour passé sans sortie).
 *
 * Une seule exception au « toujours une phrase » : un jour **vide** dont on n'a
 * rien à dire ne rend rien du tout ({@link CalendarDayView.weather}). C'est ce
 * qui garde la grille lisible — quarante cases barrées d'un tiret ne
 * l'informeraient de rien.
 */
export function dayWeather(input: DayWeatherInput): CalendarDayWeather | null {
  const { observation } = input;

  if (observation !== null) {
    if (observation.status === "observed") return observedWeather(observation);

    // Un relevé qui n'a rien pu mesurer ne dit rien du jour **à venir** : un
    // tapis de course ce matin n'efface pas le bulletin de ce soir.
    if (!isPast(input)) return upcomingWeather(input);

    return input.hasContent
      ? weatherAbsence(ACTIVITY_WEATHER_ABSENCE[observation.status])
      : null;
  }

  if (!isPast(input)) return upcomingWeather(input);

  return input.hasContent ? weatherAbsence(FORECAST_ABSENCE.past) : null;
}

type DayWeatherInput = {
  date: string;
  today: string;
  /** Le jour porte-t-il une séance ou une sortie ? */
  hasContent: boolean;
  /** Le relevé retenu pour ce jour, `null` si l'athlète n'y a pas couru. */
  observation: CalendarDayWeatherDto | null;
  forecast: WeatherForecastDto;
};

/**
 * Comparaison lexicographique : sur des dates civiles `YYYY-MM-DD` bien formées,
 * elle coïncide avec l'ordre chronologique. Aujourd'hui n'est **pas** passé —
 * la journée n'est pas finie, et le bulletin la couvre encore.
 */
function isPast(input: { date: string; today: string }): boolean {
  return input.date < input.today;
}

/** Le bulletin du jour, ou la raison de ne pas en avoir. */
function upcomingWeather(input: DayWeatherInput): CalendarDayWeather | null {
  const resolved = resolveDayForecast({
    status: input.forecast.status,
    days: input.forecast.days,
    date: input.date,
    today: input.today,
  });

  if (resolved.day !== null) return forecastWeather(resolved.day);
  return input.hasContent ? weatherAbsence(FORECAST_ABSENCE[resolved.availability]) : null;
}

export type BuildCalendarMonthInput = {
  /** Premier jour de la grille — un lundi (cf. `monthGridRange`). */
  from: string;
  /** Dernier jour de la grille, **inclus** — un dimanche. */
  to: string;
  /** Mois mis en avant, `YYYY-MM` : le reste de la grille est du débord. */
  month: string;
  /** Jour civil courant, calculé côté serveur dans le fuseau de l'athlète. */
  today: string;
  plan: CalendarPlanBounds | null;
  sessions: readonly CalendarSessionDto[];
  /**
   * Déjà projetées par le serveur ({@link toCalendarActivityView}) : le DTO du
   * DAL porte le type de sport et l'allure moyenne, que le calendrier n'affiche
   * pas, et rien de superflu ne doit franchir la frontière client.
   */
  activities: readonly CalendarActivityView[];
  /**
   * La météo **relevée** des jours courus, au plus une par jour (le DAL a déjà
   * tranché entre deux sorties d'une même journée).
   */
  weather: readonly CalendarDayWeatherDto[];
  /**
   * Le relevé de prévisions du matin, tel que le DAL le rend — au plus seize
   * jours, aucune coordonnée.
   */
  forecast: WeatherForecastDto;
};

/**
 * La grille du mois : des semaines pleines, chacune de sept jours, chaque jour
 * portant ce qui y est prévu et ce qui y a été couru.
 *
 * **Tous** les jours de la plage sont rendus, y compris les vides : une case
 * vide est une cible de dépôt, et elle doit exister à l'œil. Les séances hors
 * plage sont ignorées sans bruit — un déplacement optimiste peut, le temps d'un
 * aller-retour serveur, poser une séance en dehors de ce que la page a lu.
 */
export function buildCalendarMonth(input: BuildCalendarMonthInput): CalendarWeekView[] {
  const { from, to, month, today, plan } = input;

  const sessionsByDay = new Map<string, CalendarSessionView[]>();
  const volumeByDay = new Map<string, number>();
  for (const session of input.sessions) {
    const view = toCalendarSessionView(session, today);
    const bucket = sessionsByDay.get(view.date);
    if (bucket === undefined) sessionsByDay.set(view.date, [view]);
    else bucket.push(view);

    if (session.volumeM !== null) {
      volumeByDay.set(view.date, (volumeByDay.get(view.date) ?? 0) + session.volumeM);
    }
  }

  const activitiesByDay = new Map<string, CalendarActivityView[]>();
  for (const view of input.activities) {
    const bucket = activitiesByDay.get(view.date);
    if (bucket === undefined) activitiesByDay.set(view.date, [view]);
    else bucket.push(view);
  }

  const weatherByDay = new Map<string, CalendarDayWeatherDto>();
  for (const observation of input.weather) weatherByDay.set(observation.date, observation);

  const weeks: CalendarWeekView[] = [];

  for (let weekStart = from; weekStart <= to; weekStart = shiftCivilDate(weekStart, 7)) {
    const weekEnd = shiftCivilDate(weekStart, 6);
    const days: CalendarDayView[] = [];
    let volumeM: number | null = null;

    for (let offset = 0; offset < 7; offset += 1) {
      const date = shiftCivilDate(weekStart, offset);
      const sessions = sessionsByDay.get(date) ?? [];
      const activities = activitiesByDay.get(date) ?? [];

      const dayVolumeM = volumeByDay.get(date);
      if (dayVolumeM !== undefined) volumeM = (volumeM ?? 0) + dayVolumeM;

      days.push({
        date,
        dayNumber: formatDayNumber(date),
        weekdayLabel: formatWeekdayShort(date),
        label: formatDayLabel(date),
        isToday: date === today,
        inMonth: date.slice(0, 7) === month,
        inPlan: plan !== null && date >= plan.startsOn && date <= plan.endsOn,
        isRaceDay: plan !== null && plan.raceDate === date,
        // Ordre stable : deux séances d'un même jour ne doivent pas permuter
        // d'un rendu à l'autre.
        sessions: [...sessions].sort((left, right) => left.id - right.id),
        activities,
        weather: dayWeather({
          date,
          today,
          hasContent: sessions.length > 0 || activities.length > 0,
          observation: weatherByDay.get(date) ?? null,
          forecast: input.forecast,
        }),
      });
    }

    weeks.push({
      startsOn: weekStart,
      endsOn: weekEnd,
      label: formatWeekLabel(weekStart),
      volumeM,
      isCurrent: today >= weekStart && today <= weekEnd,
      days,
    });
  }

  return weeks;
}

/** `42,0 km` — le volume annoncé d'une semaine, `null` quand rien ne l'annonce. */
export function formatWeekVolume(volumeM: number | null): string | null {
  return volumeM === null ? null : formatDistance(volumeM);
}
