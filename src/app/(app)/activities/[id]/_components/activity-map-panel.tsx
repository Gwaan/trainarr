"use client";

import dynamic from "next/dynamic";

import { Panel } from "@/components/panel";

import type { LatLng } from "./activity-map";

/** Même géométrie que la carte : aucun saut de mise en page à l'arrivée. */
const MAP_BOX = "h-64 w-full sm:h-72 lg:h-full lg:min-h-[20rem]";

function MapLoading() {
  return (
    <div
      className={`${MAP_BOX} animate-pulse bg-surface-2`}
      role="status"
      aria-label="Chargement de la carte"
    />
  );
}

/**
 * MapLibre est chargé à la demande, jamais dans le bundle initial : la
 * bibliothèque et sa feuille de style pèsent bien plus lourd que le reste de la
 * page, et une séance sans GPS n'en a pas besoin.
 */
const ActivityMap = dynamic(() => import("./activity-map"), {
  ssr: false,
  loading: () => <MapLoading />,
});

export function ActivityMapPanel({
  path,
  className,
}: {
  path: readonly LatLng[];
  className?: string;
}) {
  return (
    <Panel title="Parcours" padded={false} className={className}>
      <ActivityMap path={path} className={MAP_BOX} />
    </Panel>
  );
}
