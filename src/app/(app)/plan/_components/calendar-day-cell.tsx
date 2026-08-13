"use client";

import type { ReactNode } from "react";
import { useDroppable } from "@dnd-kit/core";

import { cn } from "@/lib/utils";

import { dayDropId } from "../_lib/calendar-dnd";
import type { CalendarDayView } from "../_lib/calendar-model";

/**
 * La case d'un jour — cible de dépôt, et **une seule** géométrie pour les deux
 * mises en page.
 *
 * Sous `lg`, la case est une **ligne d'agenda** : pleine largeur, le jour à
 * gauche en colonne fixe, le contenu à droite. À 390 px, une grille de sept
 * colonnes donnerait des cases de 50 px — illisibles, et des cibles qu'on rate.
 * À partir de `lg`, la même case devient une **cellule de grille** : le parent
 * passe en `grid-cols-7`, la case en colonne, et le quantième remonte en tête.
 * Le libellé du jour de la semaine disparaît alors, l'en-tête de colonne le
 * porte.
 *
 * Deux mises en page, un seul DOM : c'est ce qui permet à dnd-kit de n'avoir
 * qu'un identifiant par jour. Rendre les deux vues côte à côte dupliquerait
 * chaque cible de dépôt et chaque séance.
 *
 * Hauteur minimale de 44 px (`min-h-11`) sous `lg` : une cible tactile ne se
 * discute pas, et un jour vide en est une au même titre qu'un jour chargé.
 *
 * ## Une case ne teinte que son fond, jamais l'alpha de son contenu
 *
 * Une case qui ne peut rien recevoir se **creuse** (le token `bg` sous la
 * `surface` du calendrier) au lieu de s'estomper. C'est un choix de contraste,
 * pas de goût : une `opacity` posée sur la case s'applique à tout son sous-arbre
 * et se **multiplie** avec celles que les pastilles portent déjà pour dire leur
 * état (une séance passée non courue est à 70 %). Les deux atténuations
 * cumulées faisaient tomber un titre `text-fg` à 3,2:1 — sous les 4,5:1 exigés
 * par WCAG AA — et la situation est banale : un mois antérieur au démarrage du
 * plan aligne des séances passées sur des jours hors plan.
 *
 * Le creux, lui, passe **derrière** les pastilles, qui portent leur propre fond
 * opaque : leur texte garde son contraste entier, et la case recule quand même.
 * C'est le vocabulaire déjà employé par la pastille « hors plan » de
 * `calendar-chips.tsx` — un fond creusé sous une surface — et le principe même
 * du système, dont « le contraste vient des fonds superposés ».
 */

export type CalendarDayCellProps = {
  day: CalendarDayView;
  /**
   * Pendant un glissement : ce jour accepte-t-il la séance soulevée ?
   * `null` quand rien n'est en cours de déplacement.
   */
  accepted: boolean | null;
  children: ReactNode;
};

export function CalendarDayCell({ day, accepted, children }: CalendarDayCellProps) {
  const { isOver, setNodeRef } = useDroppable({ id: dayDropId(day.date) });

  const hasContent = day.sessions.length > 0 || day.activities.length > 0;

  /*
   * Rien ne peut se poser ici : soit le jour est hors des bornes du plan — il
   * existe au calendrier, mais aucun dépôt n'y est permis —, soit le glissement
   * en cours le refuse. Les deux se disent du même creux : pendant un
   * glissement, un jour hors plan est précisément un jour refusé.
   */
  const dropRefused = accepted === false || (accepted === null && !day.inPlan);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "relative flex min-h-11 items-start gap-2.5 border-t border-border px-3 py-2 first:border-t-0",
        "transition-colors duration-150 ease-out",
        "lg:min-h-28 lg:flex-col lg:gap-1 lg:border-t-0 lg:border-r lg:px-1.5 lg:py-1.5 lg:last:border-r-0",
        day.isToday && "bg-accent-soft",
      )}
    >
      {/* Halo de dépôt : un calque, plutôt que les bordures de la case — celles-ci
          portent déjà la trame du calendrier et changer leur couleur déformerait
          la grille. Il porte aussi le creux des jours qui ne reçoivent rien : il
          est **sous** le contenu, donc il recule la case sans toucher au
          contraste d'un seul texte (cf. l'en-tête du fichier). */}
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-px rounded-[6px] border-2 border-transparent",
          "transition-colors duration-150 ease-out",
          dropRefused && !isOver && "bg-bg/80",
          accepted === true && !isOver && "border-accent/25 bg-accent-soft/40",
          accepted === true && isOver && "border-accent bg-accent-soft",
          accepted === false && isOver && "border-dashed border-negative/50 bg-negative/10",
        )}
      />

      <p className="num relative flex w-[3.4rem] shrink-0 items-center gap-1 text-[0.72rem] lg:w-auto">
        {/* Le jour entier est nommé une fois pour les lecteurs d'écran : les deux
            fragments visibles (`Lun`, `10`) ne s'y ajoutent pas — sur grand
            écran, le jour de la semaine n'est même plus affiché. */}
        <span className="sr-only">
          {day.isToday ? "Aujourd'hui, " : null}
          {day.label}
        </span>
        <span
          aria-hidden="true"
          className={cn("lg:hidden", day.inMonth ? "text-fg-faint" : "text-fg-faint/50")}
        >
          {day.weekdayLabel}
        </span>
        <span
          aria-hidden="true"
          className={cn(
            day.isToday
              ? "inline-flex size-5 items-center justify-center rounded-full bg-accent font-semibold text-bg"
              : day.inMonth
                ? "text-fg-muted"
                : "text-fg-faint/50",
          )}
        >
          {day.dayNumber}
        </span>
        {day.isRaceDay ? (
          <span className="rounded-[5px] bg-accent-soft px-1 py-px text-[0.58rem] font-semibold tracking-[0.08em] text-accent uppercase">
            Jour J
          </span>
        ) : null}
      </p>

      <div className="relative flex min-w-0 flex-1 flex-col gap-1.5 self-stretch">
        {children}
        {!hasContent && day.inPlan ? (
          <p className="text-[0.7rem] leading-none text-fg-faint/70">Repos</p>
        ) : null}
      </div>
    </div>
  );
}
