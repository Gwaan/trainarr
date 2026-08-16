"use client";

import { useRef, useState, type PointerEvent, type RefObject } from "react";

import { clampRatio, nearestIndex, normalize, type Domain } from "@/lib/chart/model";

/** Ce dont le survol a besoin du modèle : l'abscisse et son domaine, rien d'autre. */
export type ScrubTarget = {
  xs: readonly number[];
  xDomain: Domain;
};

export type Scrub = {
  /** Index du point survolé, `null` hors survol. */
  hover: number | null;
  /** Position du crosshair dans le panneau, 0..1. */
  cursorRatio: number;
  /**
   * À poser sur **un** panneau, celui qui sert de repère au pointeur : tous ont
   * la même gouttière, donc la même géométrie de tracé.
   */
  plotRef: RefObject<HTMLDivElement | null>;
  /** Gestionnaires à étaler sur le conteneur des panneaux. */
  handlers: {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerLeave: (event: PointerEvent<HTMLDivElement>) => void;
  };
};

/**
 * Survol synchronisé d'un empilement de panneaux : un seul index survolé pour
 * tous, déduit de l'abscisse sous le pointeur.
 *
 * Partagé par les deux rendus (mono-série et multi-séries) : le geste est le
 * même, et deux copies finiraient par se comporter différemment au doigt.
 */
export function useScrub({ xs, xDomain }: ScrubTarget): Scrub {
  const [hover, setHover] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const scrubbing = useRef(false);

  const moveTo = (clientX: number) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) return;

    const ratio = clampRatio((clientX - rect.left) / rect.width);
    const span = xDomain.max - xDomain.min;
    setHover(nearestIndex(xs, xDomain.min + ratio * span));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    scrubbing.current = true;
    moveTo(event.clientX);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    // Souris : le survol suffit. Doigt et stylet : seulement pendant l'appui —
    // `touch-pan-y` laisse le défilement vertical de la page passer.
    if (event.pointerType === "mouse" || scrubbing.current) moveTo(event.clientX);
  };

  const stopScrub = (event: PointerEvent<HTMLDivElement>) => {
    scrubbing.current = false;
    // Le doigt parti, la lecture reste affichée ; le curseur souris, lui, emporte
    // le crosshair avec lui.
    if (event.pointerType === "mouse") setHover(null);
  };

  return {
    hover,
    cursorRatio: hover === null ? 0 : normalize(xs[hover], xDomain),
    plotRef,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: stopScrub,
      onPointerCancel: stopScrub,
      onPointerLeave: stopScrub,
    },
  };
}
