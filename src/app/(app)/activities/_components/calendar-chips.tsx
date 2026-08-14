import type { ReactNode } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { CircleCheck, CircleDashed, Footprints, GripVertical, Lock } from "lucide-react";

import {
  SESSION_TYPE_BAR,
  SESSION_TYPE_BLOCK,
  SESSION_TYPE_EDGE_STRONG,
} from "@/components/session-type";
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
 * **La pastille entière est un bloc de la couleur de son type** : un bandeau de
 * tête plein sur toute sa largeur (4 px), un fond teinté de la même teinte, une
 * bordure teintée. C'est le code couleur du système (`--color-type-*`, huit
 * teintes validées ensemble), et il se lit d'un coup d'œil sur un mois entier —
 * un filet de 2 px au bord gauche, non : c'est ce qu'on a essayé, et c'était
 * trop discret pour dire la répartition d'un mois.
 *
 * Rien d'autre n'est teinté — ni le titre, ni le micro-label, qui sont du texte
 * et portent des tokens de texte (les dosages de fond sont calibrés pour ça, cf.
 * {@link SESSION_TYPE_BLOCK}). Une séance dont le `kind` sort du vocabulaire de
 * l'appli n'a ni bandeau ni teinte, et reste la carte `surface-2` d'avant : pas
 * de couleur par défaut, qui mentirait sur sa nature.
 *
 * Le fond des pastilles est **opaque** : il se compose au build par un
 * `color-mix` sur `bg`, jamais à l'écran sur ce qui passe dessous. C'est ce qui
 * permet à `calendar-day-cell.tsx` de creuser une case sans toucher au
 * contraste d'un seul texte, et à une pastille de garder le même contraste
 * qu'elle tombe un jour ordinaire, aujourd'hui, ou sous un halo de dépôt.
 *
 * Le type reste **écrit en toutes lettres** sur chaque pastille : la couleur
 * accompagne le mot, elle ne le remplace jamais. C'est la garantie qui vaut
 * au-delà du validateur daltonien.
 *
 * ## Deux interactifs, et jamais imbriqués
 *
 * La pastille **s'ouvre** sur le détail de sa séance, et sa poignée **se
 * saisit**. Les deux boutons lui sont passés (`action`, `handle`) plutôt que
 * construits ici : le calque de glissement re-rend la même carte sans aucun des
 * deux, et une séance figée n'a pas de poignée. Le partage des gestes — souris,
 * doigt, clavier — est documenté sur `calendar-session-card.tsx`, qui les
 * fabrique.
 *
 * L'état, lui, se double toujours d'un signe nommé, jamais d'une couleur seule :
 * une pastille réalisée porte sa coche, une pastille manquée son cercle
 * pointillé — la même grammaire que les lignes de séance du plan
 * (`plan/_components/plan-session-row.tsx`), qui est le vocabulaire déjà
 * établi. Aucun de ces signes n'emprunte au code couleur des types : le type et
 * l'état se lisent sur deux canaux séparés.
 */

/**
 * Le signe d'état, `null` pour une séance à venir : elle n'a rien à annoncer.
 *
 * Exporté parce que la modale de détail le reprend tel quel : l'état d'une
 * séance se dit d'un seul vocabulaire, du calendrier à la boîte qui l'ouvre.
 */
export const CALENDAR_STATE_MARKS: Record<
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
 * Il reste dans un token **texte** pour tout le monde, course objectif
 * comprise : à 0,68 rem c'est du texte, donc 4,5:1 exigés, que cinq des huit
 * jetons de type n'atteignent pas — la couleur du type vit dans le bandeau et
 * le fond, jamais dans les lettres.
 *
 * `fg-muted` et non `fg-faint` : sur les fonds teintés des pastilles,
 * `fg-faint` plafonne à 4,33:1 — sous AA, et aucun réglage d'opacité du fond
 * ne l'y remonte (le plafond à alpha nul est déjà 4,33 sur `surface-2`).
 * `fg-muted` y tient 7,6 à 8,4:1, et rend au passage le type plus affirmé —
 * ce qui est exactement le reproche fait à la première livraison.
 */
const KIND_LABEL =
  "text-[0.68rem] leading-[1.1] font-medium tracking-[0.1em] text-fg-muted uppercase";

export type CalendarSessionChipProps = {
  session: CalendarSessionView;
  /** La pastille est en cours de déplacement : sa place se creuse. */
  isDragging?: boolean;
  /** Rendu dans le calque de glissement — pas dans le flux de la page. */
  lifted?: boolean;
  /**
   * Le bouton qui **couvre** la pastille et ouvre son détail.
   *
   * Il est posé ici, en premier enfant absolu, plutôt qu'autour de la carte :
   * la poignée de glissement est un bouton elle aussi, et deux interactifs ne
   * s'imbriquent pas. Venant avant elle dans le document, il passe dessous sans
   * qu'aucun `z-index` n'ait à l'arbitrer — la poignée reste donc saisissable au
   * doigt comme à la souris.
   */
  action?: ReactNode;
  /**
   * Ce qui occupe la place du signe de déplacement, en bout de la ligne de type.
   *
   * Absent, la pastille rend un signe **inerte** : la poignée grisée du calque
   * de glissement, le cadenas d'une séance figée. Le calendrier, lui, y pose la
   * vraie poignée — un bouton, avec les écouteurs de dnd-kit.
   */
  handle?: ReactNode;
  className?: string;
};

/**
 * La pastille d'une séance.
 *
 * Purement visuelle : elle ne sait rien du glisser-déposer ni de la modale.
 * C'est `CalendarSessionCard` qui l'accroche à dnd-kit et lui donne ses deux
 * interactifs, et le calque de glissement qui la re-rend sans aucun des deux —
 * même composant, donc rigoureusement la même carte sous le doigt et sous le
 * curseur.
 */
export function CalendarSessionChip({
  session,
  isDragging = false,
  lifted = false,
  action,
  handle,
  className,
}: CalendarSessionChipProps) {
  const mark = CALENDAR_STATE_MARKS[session.state];
  const type = sessionType(session.kind);

  return (
    <div
      className={cn(
        // `relative` sans `z-index` : le bouton d'ouverture s'y ancre, et la
        // poignée reste au-dessus de lui par le seul ordre du document.
        "relative min-w-0 rounded-[8px] border px-2 py-1.5",
        // Le bloc de couleur du type — bandeau de tête compris, dont seule la
        // géométrie est ici (`border-t-4`), la teinte venant en dernier.
        type === null
          ? "border-border bg-surface-2"
          : cn("border-t-4", SESSION_TYPE_BLOCK[type.token]),
        // La course objectif est la seule séance qui structure le plan à elle
        // seule : son bloc est cerné d'une bordure presque pleine.
        type !== null && session.emphasis === "race" && SESSION_TYPE_EDGE_STRONG[type.token],
        // Le cadre de la séance manquée se pointille, bandeau compris : c'est
        // l'encadrement qui dit l'état, la teinte reste celle du type.
        session.state === "missed" && "border-dashed opacity-70",
        session.state === "completed" && "opacity-90",
        // La place laissée par la carte soulevée : un creux, pas un trou — la
        // ligne garde sa hauteur, rien ne saute autour d'elle.
        isDragging && "opacity-30",
        // La carte soulevée garde son traitement — c'est la même séance — et ne
        // gagne qu'un liseré accent : le système ne pose pas d'ombre portée,
        // l'élévation s'y lit au contraste des fonds.
        lifted && "border-accent/60",
        // **En dernier** : le bandeau reprend le bord haut à tout ce qui
        // précède, cran de la course et liseré de glissement compris. Sans quoi
        // l'accent de l'interaction recouvrirait la couleur de la donnée le
        // temps d'un déplacement.
        type === null ? null : SESSION_TYPE_BAR[type.token],
        className,
      )}
    >
      {action}

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
        {handle ??
          (session.movable ? (
            <GripVertical
              aria-hidden="true"
              strokeWidth={1.8}
              className="size-3 shrink-0 text-fg-faint/70"
            />
          ) : (
            <Lock
              aria-hidden="true"
              strokeWidth={1.8}
              className="size-3 shrink-0 text-fg-faint/40"
            />
          ))}
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
 * sous une surface), filet neutre à gauche là où une séance du plan porte un
 * bandeau de couleur en tête, et le mot « hors plan » écrit. Elle ne se déplace
 * pas — c'est de l'histoire — et mène au détail de l'activité.
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
