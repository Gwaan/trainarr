"use client";

import { useDraggable } from "@dnd-kit/core";

import { cn } from "@/lib/utils";

import { sessionDragId } from "../_lib/calendar-dnd";
import type { CalendarSessionView } from "../_lib/calendar-model";

import { CalendarSessionChip } from "./calendar-chips";

/**
 * Une séance qu'on peut soulever.
 *
 * `touch-manipulation` et non `touch-none` : le capteur tactile s'arme après un
 * délai, et couper `touch-action` empêcherait de faire défiler la page en
 * partant d'une séance — c'est le défaut n°1 des calendriers déplaçables au
 * doigt. Ce réglage-là ne supprime que le double-tap de zoom.
 *
 * Une séance figée (courue, ou déjà passée) ne reçoit **ni** les écouteurs
 * **ni** les attributs ARIA de dnd-kit : la rendre focalisable pour ne rien
 * pouvoir en faire serait un piège au clavier. Elle porte son cadenas, et la
 * carte le dit à l'œil.
 */
export function CalendarSessionDraggable({ session }: { session: CalendarSessionView }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: sessionDragId(session.id),
    disabled: !session.movable,
    // Le rôle annoncé est en français : « draggable », le défaut de dnd-kit,
    // serait lu tel quel par un lecteur d'écran configuré en français.
    attributes: { roleDescription: "séance déplaçable" },
  });

  if (!session.movable) {
    return <CalendarSessionChip session={session} />;
  }

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cn(
        "touch-manipulation rounded-[8px] outline-none",
        isDragging ? "cursor-grabbing" : "cursor-grab",
      )}
    >
      <CalendarSessionChip session={session} isDragging={isDragging} />
    </div>
  );
}
