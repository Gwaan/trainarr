"use client";

import {
  useMemo,
  useOptimistic,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  rectIntersection,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
  type DropAnimation,
  type KeyboardCoordinateGetter,
  type ScreenReaderInstructions,
} from "@dnd-kit/core";
import { Undo2 } from "lucide-react";

import { Banner } from "@/components/banner";
import { SESSION_TYPE_DOT } from "@/components/session-type";
import { Button } from "@/components/ui/button";
import type { CalendarDayWeatherDto, CalendarSessionDto } from "@/data/calendar";
import type { WeatherForecastDto } from "@/data/weather-forecast";
import { judgeSessionMove, type MoveSession } from "@/lib/plan-calendar/move-rules";
import { sessionTypesPresent, type SessionType } from "@/lib/plan-session-type";
import { cn } from "@/lib/utils";

import { moveSessionAction } from "../_lib/calendar-actions";
import {
  announceDragCancel,
  announceDragEnd,
  announceDragOver,
  announceDragStart,
  CALENDAR_DRAG_INSTRUCTIONS,
  parseDayDropId,
  parseSessionDragId,
} from "../_lib/calendar-dnd";
import {
  enclosingNavigableId,
  nextNavigableId,
  type NavigableRect,
  type NavigationDirection,
} from "../_lib/calendar-keyboard";
import {
  buildCalendarMonth,
  formatDayLabel,
  formatMoveDetail,
  formatWeekVolume,
  WEEKDAY_HEADERS,
  type CalendarActivityView,
  type CalendarPlanBounds,
  type CalendarSessionView,
  type CalendarWeekView,
} from "../_lib/calendar-model";

import { CalendarActivityChip, CalendarSessionChip } from "./calendar-chips";
import { CalendarDayCell } from "./calendar-day-cell";
import { CalendarSessionCard } from "./calendar-session-card";

/**
 * Le calendrier d'entraînement : ce qui est prévu, ce qui a été couru, et le
 * geste qui déplace une séance d'un jour à l'autre.
 *
 * ## Le partage des rôles avec le serveur
 *
 * Les règles de déplacement vivent dans un module **pur**
 * (`lib/plan-calendar/move-rules.ts`) que cet écran et la Server Action
 * partagent. L'écran s'en sert pour ne **pas proposer** un dépôt qui serait
 * refusé — un jour interdit s'efface pendant le glissement, et un dépôt tenté
 * dessus rend le motif immédiatement, sans aller-retour. Mais l'autorité reste
 * entière au serveur : rien n'est écrit sans que `moveSessionAction` ne rejoue
 * la décision, et c'est **son** verdict qui décide de ce qui reste à l'écran.
 *
 * Les avertissements, eux, ne sont jamais calculés ici. Ils dépendent de tout le
 * plan (l'espacement des jours durs, le plafond de volume d'une semaine), là où
 * cette page n'a lu qu'un mois : seul le serveur en tient la liste juste.
 *
 * ## Le déplacement, du doigt à la base
 *
 * 1. la séance saute au jour visé (`useOptimistic`) — l'écran ne fait pas
 *    attendre un aller-retour ;
 * 2. `moveSessionAction` tranche. La valeur optimiste tient toute la durée de la
 *    transition, revalidation comprise, et cède la place aux données fraîches
 *    sans clignotement ;
 * 3. refus → la séance revient d'elle-même à sa place (l'optimisme retombe) et
 *    le motif s'affiche, tel que l'action l'a rédigé ;
 * 4. succès → on propose le déplacement **inverse**. C'est ce qui rend le geste
 *    sans risque : un dépôt raté se défait d'un bouton.
 */

export type TrainingCalendarProps = {
  /** Mois mis en avant, `YYYY-MM`. */
  month: string;
  /** Premier et dernier jour de la grille (semaines ISO entières). */
  range: { from: string; to: string };
  /** Jour civil courant, calculé côté serveur dans le fuseau de l'athlète. */
  today: string;
  /**
   * FC max du profil, `null` tant qu'elle n'est pas saisie — elle traduit en
   * battements les zones cardiaques du détail des séances. Résolue à
   * l'affichage, jamais stockée dans la séance : une correction du profil suit
   * tout le plan, exactement comme sur la page Plan.
   */
  maxHrBpm: number | null;
  plan: CalendarPlanBounds | null;
  sessions: CalendarSessionDto[];
  /**
   * Déjà projetées par le serveur : le DTO du DAL porte le type de sport et
   * l'allure moyenne, dont cet écran ne fait rien.
   */
  activities: CalendarActivityView[];
  /**
   * La météo **relevée** des jours courus de la plage — au plus une par jour,
   * le DAL ayant déjà tranché entre deux sorties d'une même journée.
   */
  weather: CalendarDayWeatherDto[];
  /**
   * Le relevé de prévisions du matin — seize jours au plus, et **aucune
   * coordonnée** : le DAL les exclut de son DTO, elles n'ont rien à faire dans
   * un document envoyé au navigateur.
   */
  forecast: WeatherForecastDto;
};

/**
 * Ce qu'un jour répond à la séance soulevée.
 *
 * Le motif du refus est retenu, pas seulement le fait qu'il y en ait un : c'est
 * lui que le lecteur d'écran annonce au relâchement, et il vient du module de
 * règles que le serveur rejouera.
 */
type DayAcceptance = { allowed: true } | { allowed: false; reason: string };

type CalendarFeedback = {
  tone: "positive" | "negative";
  /** Le message de l'action, affiché tel quel. */
  message: string;
  /** Ce que le déplacement casse — rédigé par le serveur, jamais réécrit. */
  warnings: string[];
  detail: string | null;
  /** Le déplacement inverse, quand il y en a un à proposer. */
  undo: { session: CalendarSessionDto; toDate: string } | null;
};

/** Le DTO du calendrier, réduit à ce que la décision de déplacement lit. */
function toMoveSession(session: CalendarSessionDto): MoveSession {
  return {
    id: session.id,
    date: session.date,
    kind: session.kind,
    completed: session.completedActivityId !== null,
    volumeM: session.volumeM,
    steps: session.steps,
  };
}

const DIRECTIONS: Record<string, NavigationDirection | undefined> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/**
 * Où mène une flèche pendant un déplacement au clavier.
 *
 * Le défaut de dnd-kit translate la carte de 25 px par appui : dans un agenda
 * dont les lignes font 44 px, il faudrait deux appuis pour changer de jour et
 * l'on s'arrêterait entre deux cases. Ici, chaque appui **saute d'une case à la
 * suivante**, et la carte est recentrée sur elle — la détection de collision
 * retombe donc à coup sûr sur le jour visé.
 */
const calendarCoordinateGetter: KeyboardCoordinateGetter = (event, { context }) => {
  const direction = DIRECTIONS[event.code];
  if (direction === undefined) return;

  event.preventDefault();

  const { collisionRect, droppableContainers, droppableRects } = context;
  if (collisionRect === null) return;

  const rects: NavigableRect[] = [];
  for (const container of droppableContainers.getEnabled()) {
    if (typeof container.id !== "string" || parseDayDropId(container.id) === null) continue;
    const rect = droppableRects.get(container.id);
    if (rect === undefined) continue;
    rects.push({
      id: container.id,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });
  }
  if (rects.length === 0) return;

  const center = {
    x: (collisionRect.left + collisionRect.right) / 2,
    y: (collisionRect.top + collisionRect.bottom) / 2,
  };
  const currentId = enclosingNavigableId(center, rects);
  if (currentId === null) return;

  const nextId = nextNavigableId(currentId, rects, direction);
  const target = rects.find((rect) => rect.id === nextId);
  if (target === undefined) return;

  return {
    x: target.left + target.width / 2 - collisionRect.width / 2,
    y: target.top + target.height / 2 - collisionRect.height / 2,
  };
};

const SCREEN_READER_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable: CALENDAR_DRAG_INSTRUCTIONS,
};

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onStoreChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
}

/**
 * `prefers-reduced-motion`, lu comme le réglage système qu'il est.
 *
 * `globals.css` neutralise déjà les transitions CSS, mais l'animation de dépôt
 * de dnd-kit passe par l'API Web Animations : aucune règle CSS ne l'atteint, il
 * faut la couper en JavaScript.
 *
 * `useSyncExternalStore` plutôt qu'un effet : la préférence est une source
 * extérieure à React, la valeur est juste dès le premier rendu client, et le
 * rendu serveur (qui n'a pas de `matchMedia`) répond « pas de réduction » — un
 * HTML sans animation de toute façon.
 */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
  );
}

export function TrainingCalendar({
  month,
  range,
  today,
  maxHrBpm,
  plan,
  sessions,
  activities,
  weather,
  forecast,
}: TrainingCalendarProps) {
  const [visibleSessions, applyMove] = useOptimistic(
    sessions,
    (current: readonly CalendarSessionDto[], move: { id: number; date: string }) =>
      current.map((session) =>
        session.id === move.id ? { ...session, date: move.date } : session,
      ),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<CalendarFeedback | null>(null);
  const [isPending, startTransition] = useTransition();
  const reducedMotion = usePrefersReducedMotion();

  /*
   * Changer de mois n'est qu'une navigation de `searchParams` : le composant
   * reste monté, et un verdict rédigé pour août s'afficherait tel quel en tête
   * de septembre — au-dessus d'une grille où la séance concernée n'est plus, et
   * où « Annuler le déplacement » agirait à l'aveugle (le serveur exécuterait le
   * retour, mais rien ne bougerait à l'écran). Le retour appartient au mois qui
   * l'a demandé : il s'efface avec lui.
   *
   * Ajustement d'état pendant le rendu — le pattern React, pas un effet, comme
   * `plan-adjust-form.tsx`.
   */
  const [shownMonth, setShownMonth] = useState(month);
  if (month !== shownMonth) {
    setShownMonth(month);
    setFeedback(null);
  }

  const sensors = useSensors(
    // Souris : une contrainte de **distance**, pour qu'un clic reste un clic —
    // 6 px, sous le seuil au-delà duquel un clic devient un geste, mais assez
    // pour absorber le tremblement d'un doigt sur un trackpad.
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // Doigt : une contrainte de **délai**, sans laquelle le glissement entre en
    // conflit avec le défilement de la page. 250 ms — au-dessus de la durée d'un
    // geste de défilement, et bien en deçà des ~500 ms du menu contextuel iOS,
    // donc le glissement démarre avant que le système ne s'en mêle. La tolérance
    // de 8 px laisse un défilement s'échapper pendant le décompte tout en
    // encaissant le tremblement d'un doigt posé.
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: calendarCoordinateGetter }),
  );

  const weeks = useMemo(
    () =>
      buildCalendarMonth({
        from: range.from,
        to: range.to,
        month,
        today,
        maxHrBpm,
        plan,
        sessions: visibleSessions,
        activities,
        weather,
        forecast,
      }),
    [
      range.from,
      range.to,
      month,
      today,
      maxHrBpm,
      plan,
      visibleSessions,
      activities,
      weather,
      forecast,
    ],
  );

  const sessionViews = useMemo(() => {
    const views = new Map<number, CalendarSessionView>();
    for (const week of weeks) {
      for (const day of week.days) {
        for (const session of day.sessions) views.set(session.id, session);
      }
    }
    return views;
  }, [weeks]);

  /**
   * Les types de séance que le mois affiché porte réellement — ce que la
   * légende a besoin de nommer, et rien de plus. Recalculé avec le mois : passer
   * d'octobre (base, répétitions) à mars (spécifique, allure course) change les
   * couleurs à l'écran, donc les couleurs à expliquer.
   */
  const legendTypes = useMemo(
    () => sessionTypesPresent([...sessionViews.values()].map((session) => session.kind)),
    [sessionViews],
  );

  const activeSessionId = parseSessionDragId(activeId);
  const activeSession =
    activeSessionId === null
      ? null
      : (visibleSessions.find((session) => session.id === activeSessionId) ?? null);

  /**
   * Les jours que la séance soulevée peut rejoindre, et le motif de ceux qui la
   * refusent.
   *
   * Recalculée à chaque prise, pas à chaque pixel parcouru : c'est la séance
   * soulevée et l'état du plan qui décident, jamais la position du doigt.
   */
  const acceptance = useMemo(() => {
    if (activeSession === null || plan === null) return null;

    const siblings = visibleSessions.map(toMoveSession);
    const verdicts = new Map<string, DayAcceptance>();
    for (const week of weeks) {
      for (const day of week.days) {
        const verdict = judgeSessionMove({
          session: toMoveSession(activeSession),
          toDate: day.date,
          today,
          plan: { startsOn: plan.startsOn, endsOn: plan.endsOn, longRunDay: plan.longRunDay },
          siblings,
        });
        verdicts.set(
          day.date,
          verdict.allowed
            ? { allowed: true }
            : { allowed: false, reason: verdict.refusal.message },
        );
      }
    }
    return verdicts;
  }, [activeSession, plan, today, visibleSessions, weeks]);

  function submitMove(session: CalendarSessionDto, toDate: string, isUndo: boolean) {
    const fromDate = session.date;
    // Le détail est rédigé **ici**, à la soumission, et non à la réception : la
    // réponse peut arriver après un changement de mois, et le libellé du jour ne
    // doit pas dépendre de ce qui est à l'écran quand elle arrive.
    const detail = formatMoveDetail(session.title, toDate);
    setFeedback(null);

    startTransition(async () => {
      applyMove({ id: session.id, date: toDate });

      const formData = new FormData();
      formData.set("sessionId", String(session.id));
      formData.set("toDate", toDate);

      const result = await moveSessionAction({ status: "idle" }, formData);

      if (result.status === "success") {
        setFeedback({
          tone: "positive",
          message: result.message ?? "Séance déplacée.",
          warnings: result.warnings ?? [],
          detail,
          // Après une annulation, on ne repropose pas d'annuler l'annulation :
          // l'aller-retour serait sans fin et sans information.
          undo: isUndo ? null : { session: { ...session, date: toDate }, toDate: fromDate },
        });
        return;
      }

      setFeedback({
        tone: "negative",
        message: result.message ?? "La séance n'a pas pu être déplacée.",
        warnings: [],
        detail: null,
        undo: null,
      });
    });
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);

    const sessionId = parseSessionDragId(event.active.id);
    const toDate = parseDayDropId(event.over?.id);
    if (sessionId === null || toDate === null || plan === null) return;

    const session = visibleSessions.find((candidate) => candidate.id === sessionId);
    // Reposée là où elle était : ce n'est pas un déplacement, et l'action le
    // refuserait pour cette raison exacte. Inutile de le dire.
    if (session === undefined || session.date === toDate) return;

    const verdict = judgeSessionMove({
      session: toMoveSession(session),
      toDate,
      today,
      plan: { startsOn: plan.startsOn, endsOn: plan.endsOn, longRunDay: plan.longRunDay },
      siblings: visibleSessions.map(toMoveSession),
    });

    if (!verdict.allowed) {
      // Le motif vient du module que le serveur rejouera : c'est le même texte,
      // rendu sans attendre. Rien n'a été écrit, la séance n'a pas bougé.
      setFeedback({
        tone: "negative",
        message: verdict.refusal.message,
        warnings: [],
        detail: null,
        undo: null,
      });
      return;
    }

    submitMove(session, toDate, false);
  }

  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      const view = sessionViews.get(parseSessionDragId(active.id) ?? -1);
      return view === undefined ? undefined : announceDragStart(view.label);
    },
    onDragOver: ({ active, over }) => {
      const view = sessionViews.get(parseSessionDragId(active.id) ?? -1);
      if (view === undefined) return undefined;

      const date = parseDayDropId(over?.id);
      if (date === null) return announceDragOver(view.label, null, false);

      return announceDragOver(
        view.label,
        formatDayLabel(date),
        acceptance?.get(date)?.allowed ?? false,
      );
    },
    // Le même verdict qu'au survol : un jour qui refusait le dépôt le refuse
    // encore au relâchement, et le clavier n'a que cette phrase pour l'apprendre.
    onDragEnd: ({ active, over }) => {
      const view = sessionViews.get(parseSessionDragId(active.id) ?? -1);
      if (view === undefined) return undefined;

      const date = parseDayDropId(over?.id);
      if (date === null) return announceDragEnd(view.label, null, null);

      const verdict = acceptance?.get(date);
      return announceDragEnd(
        view.label,
        formatDayLabel(date),
        verdict === undefined || verdict.allowed ? null : verdict.reason,
      );
    },
    onDragCancel: ({ active }) => {
      const view = sessionViews.get(parseSessionDragId(active.id) ?? -1);
      return view === undefined ? undefined : announceDragCancel(view.label);
    },
  };

  const dropAnimation: DropAnimation | null = reducedMotion
    ? null
    : // 150 ms, `ease-out` : la durée du système, celle de toutes les autres
      // transitions de l'appli. Le défaut de dnd-kit (250 ms) traînerait.
      { duration: 150, easing: "cubic-bezier(0, 0, 0.2, 1)" };

  const overlaySession =
    activeSessionId === null ? undefined : sessionViews.get(activeSessionId);

  return (
    <div className="flex flex-col gap-3 sm:gap-4">
      {/* Région d'annonce **permanente**, vide et masquée tant qu'il n'y a rien à
          dire : un bandeau inséré à la volée avec son propre `role="status"`
          naît en même temps que son contenu, et les lecteurs d'écran l'annoncent
          mal — ils surveillent des régions déjà présentes. Même montage que
          `plan-adjust-form.tsx`. */}
      <div
        aria-live="polite"
        className={isPending || feedback !== null ? undefined : "sr-only"}
      >
        {/* La séance a déjà sauté à sa nouvelle place ; ce bandeau dit seulement
            que le serveur n'a pas encore tranché — et occupe la place où le
            verdict s'affichera, pour que rien ne saute à son arrivée. */}
        {isPending ? <Banner tone="neutral" title="Déplacement en cours…" /> : null}

        {isPending || feedback === null ? null : (
          <Banner tone={feedback.tone} title={feedback.message}>
            {feedback.detail === null ? null : <p>{feedback.detail}</p>}

            {feedback.warnings.length > 0 ? (
              <ul className="mt-2 flex flex-col gap-1">
                {feedback.warnings.map((warning) => (
                  <li key={warning} className="text-warning">
                    {warning}
                  </li>
                ))}
              </ul>
            ) : null}

            {feedback.undo === null ? null : (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="mt-3"
                onClick={() => {
                  const target = feedback.undo;
                  if (target !== null) submitMove(target.session, target.toDate, true);
                }}
              >
                <Undo2 aria-hidden="true" strokeWidth={1.8} />
                Annuler le déplacement
              </Button>
            )}
          </Banner>
        )}
      </div>

      <DndContext
        sensors={sensors}
        // Intersection de rectangles, et non « le centre le plus proche » : un
        // relâchement hors du calendrier ne doit accrocher aucun jour. Sans
        // recouvrement, `over` est nul et la séance revient à sa place.
        collisionDetection={rectIntersection}
        accessibility={{
          announcements,
          screenReaderInstructions: SCREEN_READER_INSTRUCTIONS,
        }}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <section className="overflow-hidden rounded-card border border-border bg-surface">
          {/* En-tête de colonnes : la grille seule en a besoin. Sous `lg`, chaque
              ligne porte son propre jour de la semaine. */}
          <div
            aria-hidden="true"
            className="hidden border-b border-border bg-surface-2/40 lg:grid lg:grid-cols-7"
          >
            {WEEKDAY_HEADERS.map((label) => (
              <span key={label} className="eyebrow px-2 py-2 text-center">
                {label}
              </span>
            ))}
          </div>

          {weeks.map((week) => (
            <CalendarWeek key={week.startsOn} week={week} acceptance={acceptance} />
          ))}

          <CalendarLegend types={legendTypes} />
        </section>

        <DragOverlay dropAnimation={dropAnimation}>
          {overlaySession === undefined ? null : (
            <CalendarSessionChip session={overlaySession} lifted />
          )}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

/**
 * Une semaine : son intitulé, son volume, et ses sept jours.
 *
 * L'en-tête existe dans les deux formats. Sur téléphone, c'est lui qui donne son
 * sens à la pile de jours ; sur grand écran, il porte le volume — la seule
 * information qu'une grille de sept colonnes ne sait pas dire toute seule.
 */
function CalendarWeek({
  week,
  acceptance,
}: {
  week: CalendarWeekView;
  acceptance: Map<string, DayAcceptance> | null;
}) {
  const volume = formatWeekVolume(week.volumeM);

  return (
    <section className="border-b border-border">
      <header
        className={cn(
          "flex items-center justify-between gap-3 border-b border-border px-3 py-1.5 lg:px-4",
          week.isCurrent ? "bg-accent-soft" : "bg-surface-2/40",
        )}
      >
        <h2 className={cn("eyebrow truncate", week.isCurrent && "text-fg")}>{week.label}</h2>
        {volume === null ? null : (
          <span className="num shrink-0 text-[0.7rem] text-fg-faint">{volume}</span>
        )}
      </header>

      <div className="lg:grid lg:grid-cols-7">
        {week.days.map((day) => (
          <CalendarDayCell
            key={day.date}
            day={day}
            accepted={acceptance === null ? null : (acceptance.get(day.date)?.allowed ?? false)}
          >
            {day.sessions.map((session) => (
              <CalendarSessionCard
                key={session.id}
                session={session}
                // Le jour et sa météo viennent de la case qui les affiche déjà :
                // la modale n'a rien à relire, et surtout rien à recalculer.
                dayLabel={day.label}
                weather={day.weather}
              />
            ))}
            {day.activities.map((activity) => (
              <CalendarActivityChip key={activity.id} activity={activity} />
            ))}
          </CalendarDayCell>
        ))}
      </div>
    </section>
  );
}

/**
 * La grille de lecture des pastilles.
 *
 * Deux groupes, séparés par un trait : ce que dit la **couleur** du bloc — le
 * type de la séance —, puis ce que disent les **signes** — l'état. Les deux
 * canaux sont indépendants, et la légende les sépare comme les pastilles les
 * séparent.
 *
 * ## Pourquoi seulement les types du mois affiché
 *
 * Le système en compte huit ; un mois en porte trois à cinq. Dérouler les huit
 * ferait de ce pied de carte un dictionnaire — deux lignes entières sur
 * téléphone — dont l'essentiel ne concernerait aucune pastille à l'écran. La
 * légende ne nomme donc que les couleurs réellement posées, dans l'ordre du
 * système et non dans celui où le mois les a fait tomber
 * ({@link sessionTypesPresent}).
 *
 * Un mois qui n'affiche que des séances hors vocabulaire (plan d'avant la
 * bascule sur squelette) n'a aucune couleur à expliquer : le groupe disparaît,
 * séparateur compris, et il ne reste que les états.
 */
function CalendarLegend({ types }: { types: readonly SessionType[] }) {
  return (
    // Pas de bordure haute : la dernière semaine porte déjà la sienne, et les
    // deux se cumuleraient en un filet double.
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 text-[0.66rem] text-fg-faint lg:px-4">
      {types.map((type) => (
        <li key={type.token} className="flex items-center gap-1.5">
          {/* La même géométrie que le bandeau d'une pastille : une barre
              horizontale, pas un rond — la légende montre le signe tel qu'il
              est. */}
          <span
            aria-hidden="true"
            className={cn("h-1 w-4 rounded-full", SESSION_TYPE_DOT[type.token])}
          />
          {type.label}
        </li>
      ))}
      {types.length === 0 ? null : (
        <li aria-hidden="true" className="h-3 w-px bg-border" />
      )}
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className="size-2 rounded-full bg-positive" />
        Réalisée
      </li>
      <li className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="h-3 w-4 rounded-[3px] border border-dashed border-fg-faint"
        />
        Manquée
      </li>
      <li className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="h-3 w-4 rounded-[3px] border border-l-2 border-border border-l-fg-faint/60 bg-bg"
        />
        Sortie hors plan
      </li>
    </ul>
  );
}
