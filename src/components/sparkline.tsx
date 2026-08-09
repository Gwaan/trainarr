import { cn } from "@/lib/utils";

/** Repère interne du SVG — étiré horizontalement via `preserveAspectRatio="none"`. */
const VIEW_W = 100;
const VIEW_H = 40;
const PAD_X = 1;
const PAD_Y = 5;

export type SparklineProps = {
  /** Série chronologique (au moins 2 points). */
  data: readonly number[];
  /** Description accessible du graphe. */
  label: string;
  /** La hauteur est fixée par l'appelant (`h-*`, `flex-1`…). */
  className?: string;
};

type Point = { x: number; y: number };

function toPoints(data: readonly number[]): Point[] {
  // Un NaN/Infinity dans la série contaminerait min/max et produirait un path
  // « M NaN NaN » : courbe invisible et silencieuse. Les calculs physio pouvant
  // légitimement produire une valeur non calculable, on les écarte ici.
  const finite = data.filter((value) => Number.isFinite(value));
  if (finite.length < 2) return [];

  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min;
  const innerW = VIEW_W - PAD_X * 2;
  const innerH = VIEW_H - PAD_Y * 2;

  return finite.map((value, index) => ({
    x: PAD_X + (index / (finite.length - 1)) * innerW,
    // Série plate : on centre au lieu de diviser par zéro.
    y:
      span === 0
        ? PAD_Y + innerH / 2
        : PAD_Y + innerH - ((value - min) / span) * innerH,
  }));
}

/** Cubiques à tangentes horizontales : lissage sans dépassement des valeurs réelles. */
function toCurve(points: Point[]): string {
  const round = (n: number) => n.toFixed(2);
  let d = `M ${round(points[0].x)} ${round(points[0].y)}`;

  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1];
    const to = points[i];
    const midX = round((from.x + to.x) / 2);
    d += ` C ${midX} ${round(from.y)}, ${midX} ${round(to.y)}, ${round(to.x)} ${round(to.y)}`;
  }

  return d;
}

/** Sparkline SVG écrite à la main — aucune librairie de graphes. */
export function Sparkline({ data, label, className }: SparklineProps) {
  const points = toPoints(data);
  if (points.length < 2) return null;

  const curve = toCurve(points);
  const last = points[points.length - 1];
  const area = `${curve} L ${last.x.toFixed(2)} ${VIEW_H} L ${points[0].x.toFixed(2)} ${VIEW_H} Z`;
  const gridLines = [PAD_Y, VIEW_H / 2, VIEW_H - PAD_Y];

  return (
    <div className={cn("relative w-full", className)}>
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        className="size-full overflow-visible"
      >
        <defs>
          {/* Remplissage accent à 12 %, estompé vers le pied de la courbe. */}
          <linearGradient id="sparkline-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.12" />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {gridLines.map((y) => (
          <line
            key={y}
            x1="0"
            y1={y}
            x2={VIEW_W}
            y2={y}
            className="stroke-border"
            strokeOpacity="0.4"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        <path d={area} fill="url(#sparkline-fill)" />
        <path
          d={curve}
          fill="none"
          className="stroke-accent"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {/* Point terminal en HTML : reste parfaitement rond malgré l'étirement du SVG. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-4 ring-accent/20"
        style={{
          left: `${(last.x / VIEW_W) * 100}%`,
          top: `${(last.y / VIEW_H) * 100}%`,
        }}
      />
    </div>
  );
}
