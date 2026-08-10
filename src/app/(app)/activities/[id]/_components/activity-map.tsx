"use client";

import { useEffect, useRef } from "react";
import { LngLatBounds, MapLibreMap, type StyleSpecification } from "maplibre-gl";

import "maplibre-gl/dist/maplibre-gl.css";

/** Un point de la trace, dans l'ordre du DAL : `[latitude, longitude]`. */
export type LatLng = readonly [number, number];

/**
 * Couleur du design system, lue sur le document : les couches MapLibre sont
 * peintes en WebGL et n'héritent pas des variables CSS. Aucune valeur en dur —
 * `globals.css` reste la source unique des tokens.
 */
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Fond OpenStreetMap raster, assombri pour tenir dans « Night Track » sans
 * devenir illisible : désaturation partielle et plafond de luminosité, la trace
 * accent devant garder son contraste sur les zones claires (routes, bâti).
 */
function osmStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 19,
        // Attribution OSM obligatoire — affichée par le contrôle par défaut.
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
      },
    },
    layers: [
      {
        id: "fond",
        type: "background",
        paint: { "background-color": token("--color-bg") },
      },
      {
        id: "osm",
        type: "raster",
        source: "osm",
        paint: {
          "raster-saturation": -0.5,
          "raster-brightness-max": 0.66,
          "raster-contrast": 0.05,
          "raster-opacity": 0.85,
        },
      },
    ],
  };
}

/** Textes des gestes coopératifs — l'UI est en français. */
const LOCALE = {
  "CooperativeGesturesHandler.WindowsHelpText": "Ctrl + molette pour zoomer",
  "CooperativeGesturesHandler.MacHelpText": "⌘ + molette pour zoomer",
  "CooperativeGesturesHandler.MobileHelpText": "Deux doigts pour déplacer la carte",
};

/**
 * Trace de la séance sur fond OSM.
 *
 * Chargée dynamiquement (cf. `activity-map-panel.tsx`) : MapLibre pèse plusieurs
 * centaines de kilo-octets et n'a rien à faire dans le bundle initial.
 *
 * Gestes coopératifs actifs : sur mobile, un doigt fait défiler la page — la
 * carte ne piège jamais le scroll ; deux doigts la manipulent.
 */
export default function ActivityMap({
  path,
  className,
}: {
  path: readonly LatLng[];
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null || path.length < 2) return;

    // MapLibre attend [longitude, latitude] — l'inverse du couple du DAL.
    const coordinates = path.map(([lat, lng]): [number, number] => [lng, lat]);
    const bounds = coordinates.reduce(
      (box, coordinate) => box.extend(coordinate),
      new LngLatBounds(coordinates[0], coordinates[0]),
    );

    const map = new MapLibreMap({
      container,
      style: osmStyle(),
      bounds,
      // Pas d'animation d'entrée : la carte s'ouvre déjà cadrée sur la trace.
      fitBoundsOptions: { padding: 28, animate: false },
      cooperativeGestures: true,
      locale: LOCALE,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      maxPitch: 0,
    });

    map.on("load", () => {
      map.addSource("trace", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates },
        },
      });
      map.addLayer({
        id: "trace",
        type: "line",
        source: "trace",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": token("--color-accent"), "line-width": 3 },
      });
    });

    return () => map.remove();
  }, [path]);

  return (
    <div
      ref={containerRef}
      className={className}
      role="img"
      aria-label="Carte du parcours de la séance"
    />
  );
}
