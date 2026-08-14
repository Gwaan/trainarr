"use client";

import { useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { GripVertical } from "lucide-react";

import { cn } from "@/lib/utils";

import { sessionDragId } from "../_lib/calendar-dnd";
import type { CalendarDayWeather, CalendarSessionView } from "../_lib/calendar-model";

import { CalendarSessionChip } from "./calendar-chips";
import { CalendarSessionDialog } from "./calendar-session-dialog";

/**
 * Une séance du calendrier : une pastille **qui s'ouvre** et, si elle n'est pas
 * figée, **qui se soulève**.
 *
 * ## Deux gestes, deux cibles — c'est tout le dispositif
 *
 * Un clic ouvrait le détail *ou* démarrait un glissement selon la distance
 * parcourue : deux intentions sur un même élément, que rien ne sépare au
 * clavier. Elles sont donc portées par **deux boutons distincts** :
 *
 * - **la pastille entière ouvre le détail.** Le bouton la couvre (`inset-0`) au
 *   lieu de l'envelopper : la poignée est un bouton elle aussi, et deux
 *   interactifs ne s'imbriquent pas. Il n'a aucun écouteur de dnd-kit, donc
 *   **aucun geste de glissement ne s'y termine** — le cas où un dépôt rouvre la
 *   carte qu'on vient de déplacer n'existe pas ici, il n'y a rien à neutraliser
 *   dans `handleDragEnd` ;
 * - **la poignée soulève.** C'est elle qui porte `setActivatorNodeRef`, les
 *   écouteurs et les attributs ARIA de dnd-kit ; le nœud mesuré reste
 *   l'enveloppe, donc la carte soulevée est bien la carte entière.
 *
 * Ce qui en découle, capteur par capteur :
 *
 * - **souris** : la contrainte de distance (6 px) n'a plus à arbitrer entre un
 *   clic et un geste. Un clic sur la carte ouvre, un clic sur la poignée ne fait
 *   rien, et un glissement parti de la poignée ne peut pas finir en ouverture —
 *   un `click` n'est délivré qu'au premier ancêtre commun de l'appui et du
 *   relâchement, jamais à un bouton voisin ;
 * - **doigt** : un appui bref sur la carte ouvre **immédiatement**, sans
 *   attendre les 250 ms du capteur tactile, qui ne surveille plus que la
 *   poignée. Celle-ci reçoit une zone de 24 px prise sur la marge intérieure de
 *   la pastille (`p-1.5` et autant de marge négative) : la cible grandit, le
 *   dessin ne bouge pas ;
 * - **clavier** : deux arrêts de tabulation, chacun avec une seule action.
 *   `Entrée` sur la pastille ouvre le détail ; `Entrée` ou `Espace` sur la
 *   poignée soulève, et les flèches puis `Échap` continuent d'être décrites par
 *   les annonces françaises que dnd-kit lit — la poignée porte `attributes`,
 *   donc l'`aria-describedby` qui les rattache.
 *
 * Une séance figée (courue, ou dont le jour est passé) n'a pas de poignée : elle
 * garde son cadenas, et son détail s'ouvre comme celui des autres. Consulter ne
 * demande la permission de personne.
 */
export function CalendarSessionCard({
  session,
  dayLabel,
  weather,
}: {
  session: CalendarSessionView;
  /** `vendredi 14 août` — le jour de la case, nommé par le modèle. */
  dayLabel: string;
  /** La météo de ce jour-là, telle que la case l'affiche déjà. */
  weather: CalendarDayWeather | null;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: sessionDragId(session.id),
    disabled: !session.movable,
    // Le rôle annoncé est en français : « draggable », le défaut de dnd-kit,
    // serait lu tel quel par un lecteur d'écran configuré en français.
    attributes: { roleDescription: "séance déplaçable" },
  });

  return (
    <>
      {/* `touch-manipulation` et non `touch-none` : le capteur tactile s'arme
          après un délai, et couper `touch-action` empêcherait de faire défiler
          la page en partant d'une séance — le défaut n°1 des calendriers
          déplaçables au doigt. Ce réglage-là ne supprime que le double-tap de
          zoom, sur la carte comme sur sa poignée. */}
      <div ref={setNodeRef} className="min-w-0 touch-manipulation">
        <CalendarSessionChip
          session={session}
          isDragging={isDragging}
          action={
            <button
              type="button"
              onClick={() => setIsOpen(true)}
              /* Le texte de la pastille est hors du bouton : sans nom explicite,
                 il s'annoncerait vide. Le libellé est celui des annonces de
                 glissement — une seule façon de nommer une séance. */
              aria-label={`Voir le détail : ${session.label}`}
              className={cn(
                "absolute inset-0 cursor-pointer rounded-[8px]",
                // Le voile est en jeton de texte, jamais en accent : l'accent
                // est l'action et la sélection, et une pastille survolée n'est
                // ni l'une ni l'autre.
                "transition-colors duration-150 ease-out hover:bg-fg/5",
              )}
            />
          }
          handle={
            session.movable ? (
              <button
                ref={setActivatorNodeRef}
                type="button"
                {...listeners}
                {...attributes}
                aria-label="Déplacer la séance"
                className={cn(
                  // `relative` : positionnée et postérieure au bouton
                  // d'ouverture dans le document, la poignée passe devant lui
                  // sans qu'aucun `z-index` n'ait à l'arbitrer.
                  "relative -my-1.5 -mr-1.5 shrink-0 rounded-[6px] p-1.5",
                  "text-fg-faint/70 transition-colors duration-150 ease-out hover:text-fg-muted",
                  isDragging ? "cursor-grabbing" : "cursor-grab",
                )}
              >
                <GripVertical aria-hidden="true" strokeWidth={1.8} className="size-3" />
              </button>
            ) : undefined
          }
        />
      </div>

      <CalendarSessionDialog
        session={session}
        dayLabel={dayLabel}
        weather={weather}
        isOpen={isOpen}
        onOpenChange={setIsOpen}
      />
    </>
  );
}
