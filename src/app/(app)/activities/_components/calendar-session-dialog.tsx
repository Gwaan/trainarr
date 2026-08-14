"use client";

import { X } from "lucide-react";

import { PlanSessionDetailPanel } from "@/app/(app)/plan/_components/plan-session-detail";
import { SessionTypeLabel } from "@/components/session-type";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { WeatherIcon } from "@/components/weather-icon";
import { cn } from "@/lib/utils";

import { capitalize } from "../../_lib/format";
import type { CalendarDayWeather, CalendarSessionView } from "../_lib/calendar-model";

import { CALENDAR_STATE_MARKS } from "./calendar-chips";

/**
 * Le détail d'une séance planifiée, ouvert depuis sa pastille de calendrier.
 *
 * ## Un seul rendu du déroulé, et c'est celui du plan
 *
 * Le corps de la boîte est {@link PlanSessionDetailPanel}, **le composant de la
 * page Plan**, importé tel quel — pas une seconde mise en forme du même contenu.
 * Il ne demandait pour cela aucune adaptation : il prend une projection
 * (`PlanSessionDetail`) et l'identifiant de l'activité à rejoindre, et ignore
 * tout de la ligne dépliable qui l'affichait jusqu'ici. La projection, elle,
 * vient du modèle du calendrier ({@link CalendarSessionView.detail}), qui
 * appelle exactement la même fonction pure que la page Plan.
 *
 * L'import inter-route suit le précédent déjà en place : le calendrier lit déjà
 * `plan/_lib/{format-plan, session-detail, plan-weeks}`. Le plan écrit les
 * séances, il dit donc comment elles se lisent — deux définitions du déroulé
 * d'une séance finiraient par diverger.
 *
 * ## L'en-tête
 *
 * Ce qu'on cherche en ouvrant la séance du lendemain : son type (écrit, avec sa
 * puce de couleur), son intitulé, le jour, son état s'il en a un, et **la météo
 * de ce jour-là** — relevée pour un jour couru, prévue pour un jour à venir,
 * exactement ce que la case du calendrier affiche en abrégé. Elle ne coûte
 * aucune lecture de plus : le modèle l'a déjà tranchée pour la case.
 *
 * Aucun CTA accent : consulter n'est pas une action principale. La seule action
 * de la boîte est le lien vers l'activité réalisée, que le panneau rend en
 * `secondary`, et la croix de fermeture en `ghost`.
 */
export function CalendarSessionDialog({
  session,
  dayLabel,
  weather,
  isOpen,
  onOpenChange,
}: {
  session: CalendarSessionView;
  /** `vendredi 14 août`, tel que le modèle nomme le jour de la case. */
  dayLabel: string;
  /** La météo du jour, `null` quand il n'y a rien à en dire. */
  weather: CalendarDayWeather | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mark = CALENDAR_STATE_MARKS[session.state];
  // Ni déroulé, ni consigne, ni le moindre total, ni sortie à rejoindre : le
  // panneau n'aurait rien à rendre, et un cadre vide se lirait comme une panne.
  const hasPanel =
    !session.detail.isEmpty ||
    session.detail.totals.length > 0 ||
    session.completedActivityId !== null;

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* Pas de `border-b` : le corps porte déjà son propre filet haut, et les
            deux se cumuleraient en un trait double. */}
        <header className="flex items-start justify-between gap-3 px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            <SessionTypeLabel kind={session.kind} />
            <DialogTitle className="mt-1">{session.title}</DialogTitle>
            <DialogDescription>
              {capitalize(dayLabel)}
              {mark === null ? null : (
                <>
                  {" · "}
                  <span className={cn("inline-flex items-center gap-1", mark.className)}>
                    <mark.icon aria-hidden="true" strokeWidth={2} className="size-3" />
                    {mark.label}
                  </span>
                </>
              )}
            </DialogDescription>

            {weather === null ? null : (
              <p className="mt-1.5 flex items-start gap-1.5 text-[0.76rem] leading-snug text-fg-faint">
                {weather.icon === null ? null : (
                  <WeatherIcon name={weather.icon} className="mt-px size-3.5" />
                )}
                <span className="min-w-0">{weather.label}</span>
              </p>
            )}
          </div>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Fermer"
            onClick={() => onOpenChange(false)}
            className="-mr-2 shrink-0"
          >
            <X aria-hidden="true" />
          </Button>
        </header>

        {/* `bg-surface-2` porté par le corps entier, et pas seulement par le
            panneau : en plein écran, celui-ci s'arrête à son contenu et laissait
            sous lui une bande de `surface` qui ressemblait à une coupure. Le
            filet du haut, lui, reste celui du panneau — il tombe au même endroit.

            Le dernier élément doit dégager l'indicateur d'accueil de l'iPhone. */}
        <div className="min-h-0 flex-1 overflow-y-auto bg-surface-2 pb-[env(safe-area-inset-bottom)]">
          {hasPanel ? (
            <PlanSessionDetailPanel
              detail={session.detail}
              completedActivityId={session.completedActivityId}
            />
          ) : (
            <p className="border-t border-border px-4 py-4 text-[0.82rem] leading-snug text-fg-muted sm:px-5">
              Cette séance ne porte pas de déroulé : ni consigne, ni distance, ni durée
              annoncée.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
