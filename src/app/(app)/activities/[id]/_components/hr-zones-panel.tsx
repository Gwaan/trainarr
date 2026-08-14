import { Panel } from "@/components/panel";
// Le module précis, pas le tonneau `@/lib/metrics` : ce composant n'a besoin que
// du type de l'ancrage, pas de tous les calculs physio.
import type { HrZoneAnchor } from "@/lib/metrics/hr-zones";
import { cn } from "@/lib/utils";

import { MetricInfo } from "../../../_components/metric-info";
import { formatNumber } from "../../../_lib/format";
import { formatClock } from "../_lib/format-detail";
import { totalZoneSeconds, zoneBarClass, zoneBarWidthPct } from "../_lib/hr-zones-model";

/** Temps passé dans une zone cardio, tel que le calcule le DAL. */
export type ZoneRow = {
  /** Numéro de zone, de 1 à 5. */
  zone: number;
  timeS: number;
  /** Part de la durée totale, dans [0, 1] — calculée par le DAL. */
  share: number;
};

/**
 * Sur quoi les cinq zones sont calées, en une phrase.
 *
 * Les mêmes barres ne veulent pas dire la même chose selon l'ancrage : Z2 est
 * « 60–70 % de FC max » dans un cas, « 85–89 % du seuil » dans l'autre. Le
 * panneau le dit donc au lieu de le laisser deviner — la fiche ⓘ développe.
 */
function anchorCaption(anchor: HrZoneAnchor): string {
  return anchor.kind === "lthr"
    ? `Zones calées sur ta FC seuil (${anchor.bpm} bpm).`
    : `Zones calées sur ta FC max (${anchor.bpm} bpm).`;
}

/**
 * Répartition du temps par zone cardio.
 *
 * Barres horizontales Z1→Z5 dans la rampe séquentielle du design system (une
 * seule teinte, luminosité croissante : les zones sont une magnitude ordonnée).
 * Chaque barre porte son étiquette — zone, durée, part — la couleur ne dit
 * jamais rien à elle seule.
 */
export function HrZonesPanel({
  zones,
  anchor,
  className,
}: {
  zones: readonly ZoneRow[];
  /** La référence des bornes. Jamais `null` ici : sans elle, aucune zone n'existe. */
  anchor: HrZoneAnchor;
  className?: string;
}) {
  const total = totalZoneSeconds(zones.map((zone) => zone.timeS));

  return (
    <Panel
      title="Zones cardio"
      // Un seul ⓘ pour les cinq zones : elles n'ont qu'un jeu de bornes, et
      // cinq déclencheurs dans une liste de barres de 16 px se marcheraient
      // dessus au doigt.
      info={<MetricInfo id="hr-zones" />}
      meta={<span className="num">{formatClock(total)}</span>}
      className={className}
    >
      {/* Gaps de 2 px entre segments : les barres restent un groupe lisible. */}
      <ul className="flex flex-col gap-0.5">
        {zones.map((zone) => (
          <li key={zone.zone} className="flex items-center gap-2">
            <span className="num w-5 shrink-0 text-[0.72rem] font-medium text-fg-muted">
              Z{zone.zone}
            </span>

            {/* Rail en `bg` et non `surface-2` : c'est lui que les cinq
                remplissages doivent contraster à 3:1 (cf. design.md), et le
                creux le plus profond de la palette est ce qui l'autorise sans
                écraser le bas de la rampe. */}
            <span aria-hidden="true" className="h-4 min-w-8 flex-1 rounded-[3px] bg-bg">
              <span
                className={cn("block h-full rounded-[3px]", zoneBarClass(zone.zone))}
                style={{ width: `${zoneBarWidthPct(zone.share).toFixed(1)}%` }}
              />
            </span>

            <span className="num w-[3.4rem] shrink-0 text-right text-[0.72rem] text-fg">
              {formatClock(zone.timeS)}
            </span>
            <span className="num w-[2.8rem] shrink-0 text-right text-[0.72rem] text-fg-faint">
              {formatNumber(zone.share * 100, 0)} %
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-3 text-[0.72rem] leading-relaxed text-fg-faint">
        {anchorCaption(anchor)}
      </p>
    </Panel>
  );
}
