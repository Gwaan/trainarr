import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { CircleCheck, CircleDashed, Footprints, GripVertical, Lock } from "lucide-react";

import { SESSION_TYPE_RAIL, SESSION_TYPE_SOFT } from "@/components/session-type";
import { sessionType } from "@/lib/plan-session-type";
import { cn } from "@/lib/utils";

import type {
  CalendarActivityView,
  CalendarSessionState,
  CalendarSessionView,
} from "../_lib/calendar-model";

/**
 * Les pastilles du calendrier — le seul endroit où une séance et une sortie
 * prennent forme, quel que soit le format d'affichage.
 *
 * ## Ce que la couleur fait, et ce qu'elle ne fait pas
 *
 * Le **filet de gauche porte le type de la séance** : c'est le code couleur du
 * système (`--color-type-*`, huit teintes validées ensemble), et la course
 * objectif y ajoute un aplat de la même teinte. Rien d'autre n'est teinté — ni
 * le titre, ni le micro-label, qui sont du texte et portent des tokens de
 * texte. Une séance dont le `kind` sort du vocabulaire de l'appli n'a pas de
 * filet du tout : pas de couleur par défaut, qui mentirait sur sa nature.
 *
 * Le type reste **écrit en toutes lettres** sur chaque pastille : la couleur
 * accompagne le mot, elle ne le remplace jamais. C'est la garantie qui vaut
 * au-delà du validateur daltonien.
 *
 * L'état, lui, se double toujours d'un signe nommé, jamais d'une couleur seule :
 * une pastille réalisée porte sa coche, une pastille manquée son cercle
 * pointillé — la même grammaire que les lignes de séance du plan
 * (`plan/_components/plan-session-row.tsx`), qui est le vocabulaire déjà
 * établi. Aucun de ces signes n'emprunte au code couleur des types : le type et
 * l'état se lisent sur deux canaux séparés.
 */

/** Le signe d'état, `null` pour une séance à venir : elle n'a rien à annoncer. */
const STATE_MARKS: Record<
  CalendarSessionState,
  { icon: LucideIcon; label: string; className: string } | null
> = {
  completed: { icon: CircleCheck, label: "Réalisée", className: "text-positive" },
  // Une séance passée sans activité rapprochée n'a pas eu lieu. Ce n'est pas une
  // alerte physiologique : elle reste en gris, jamais en `negative`.
  missed: { icon: CircleDashed, label: "Manquée", className: "text-fg-faint" },
  upcoming: null,
};

/**
 * La forme du micro-label de type, écrite au long plutôt qu'empruntée à
 * l'utilitaire `.eyebrow` : celui-ci fixe aussi sa couleur, et la remplacer
 * dépendrait de l'ordre d'émission des utilitaires. Même parti pris que le
 * `ROLE_LABEL` de `plan-session-detail.tsx`.
 *
 * Il reste en `fg-faint` pour **tout** le monde, course objectif comprise : à
 * 0,68 rem c'est du texte, donc 4,5:1 exigés, que cinq des huit jetons
 * n'atteignent pas sur `surface-2` — `type-easy` y est à 3,1:1, `type-event` à
 * 3,3:1. La couleur du type vit dans le filet, jamais dans les lettres.
 */
const KIND_LABEL =
  "text-[0.68rem] leading-[1.1] font-medium tracking-[0.1em] text-fg-faint uppercase";

export type CalendarSessionChipProps = {
  session: CalendarSessionView;
  /** La pastille est en cours de déplacement : sa place se creuse. */
  isDragging?: boolean;
  /** Rendu dans le calque de glissement — pas dans le flux de la page. */
  lifted?: boolean;
  className?: string;
};

/**
 * La pastille d'une séance.
 *
 * Purement visuelle : elle ne sait rien du glisser-déposer. C'est
 * `CalendarSessionDraggable` qui l'accroche à dnd-kit, et le calque de
 * glissement qui la re-rend telle quelle — même composant, donc rigoureusement
 * la même carte sous le doigt et sous le curseur.
 */
export function CalendarSessionChip({
  session,
  isDragging = false,
  lifted = false,
  className,
}: CalendarSessionChipProps) {
  const mark = STATE_MARKS[session.state];
  const type = sessionType(session.kind);

  return (
    <div
      className={cn(
        "min-w-0 rounded-[8px] border px-2 py-1.5",
        // La course objectif est la seule séance qui structure le plan à elle
        // seule : elle garde son aplat, désormais dans la teinte de sa famille
        // (`type-event`) au lieu de l'accent, qui est l'interaction.
        type !== null && session.emphasis === "race"
          ? SESSION_TYPE_SOFT[type.token]
          : "border-border bg-surface-2",
        session.state === "missed" && "border-dashed opacity-70",
        session.state === "completed" && "opacity-90",
        // La place laissée par la carte soulevée : un creux, pas un trou — la
        // ligne garde sa hauteur, rien ne saute autour d'elle.
        isDragging && "opacity-30",
        // La carte soulevée garde son traitement — c'est la même séance — et ne
        // gagne qu'un liseré accent : le système ne pose pas d'ombre portée,
        // l'élévation s'y lit au contraste des fonds.
        lifted && "border-accent/60",
        // **En dernier** : le filet de type reprend le bord gauche à tout ce qui
        // précède, aplat de course et liseré de glissement compris. Sans quoi
        // l'accent de l'interaction recouvrirait la couleur de la donnée le
        // temps d'un déplacement.
        type === null ? null : cn("border-l-2", SESSION_TYPE_RAIL[type.token]),
        className,
      )}
    >
      <p className="flex min-w-0 items-center gap-1">
        {mark === null ? null : (
          <mark.icon
            aria-hidden="true"
            strokeWidth={2}
            className={cn("size-3 shrink-0", mark.className)}
          />
        )}
        <span className={cn(KIND_LABEL, "min-w-0 flex-1 truncate")}>{session.kind}</span>
        {mark === null ? null : <span className="sr-only">{mark.label}</span>}
        {session.movable ? (
          <GripVertical
            aria-hidden="true"
            strokeWidth={1.8}
            className="size-3 shrink-0 text-fg-faint/70"
          />
        ) : (
          <Lock aria-hidden="true" strokeWidth={1.8} className="size-3 shrink-0 text-fg-faint/40" />
        )}
      </p>

      <p
        className={cn(
          "mt-0.5 line-clamp-2 text-[0.78rem] leading-snug",
          session.emphasis === "race" ? "font-semibold text-fg" : "font-medium",
          session.state === "completed" ? "text-fg-muted" : "text-fg",
        )}
      >
        {session.title}
      </p>

      {session.summary === null ? null : (
        <p className="num mt-0.5 truncate text-[0.68rem] text-fg-muted">{session.summary}</p>
      )}
    </div>
  );
}

/**
 * Une sortie réellement courue hors plan.
 *
 * Elle se lit tout de suite comme autre chose qu'une séance : fond creusé (`bg`
 * sous une surface), filet neutre à gauche là où une séance dure porte l'accent,
 * et le mot « hors plan » écrit. Elle ne se déplace pas — c'est de l'histoire —
 * et mène au détail de l'activité.
 */
export function CalendarActivityChip({ activity }: { activity: CalendarActivityView }) {
  return (
    <Link
      href={`/activities/${activity.id}`}
      className="block min-w-0 rounded-[8px] border border-l-2 border-border border-l-fg-faint/50 bg-bg/60 px-2 py-1.5 transition-colors duration-150 ease-out hover:border-fg-faint/40 hover:bg-bg"
    >
      <p className="flex min-w-0 items-center gap-1">
        <Footprints
          aria-hidden="true"
          strokeWidth={1.8}
          className="size-3 shrink-0 text-fg-faint"
        />
        <span className={cn(KIND_LABEL, "min-w-0 flex-1 truncate")}>Hors plan</span>
      </p>

      <p className="mt-0.5 line-clamp-2 text-[0.78rem] leading-snug font-medium text-fg-muted">
        {activity.name}
      </p>

      {activity.summary === null ? null : (
        <p className="num mt-0.5 truncate text-[0.68rem] text-fg-faint">{activity.summary}</p>
      )}
    </Link>
  );
}
