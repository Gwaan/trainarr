import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Cadre de panneau, repris à l'identique du composant `Panel`. */
function PanelFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-card border border-border bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-3 w-20" />
      </div>
      {children}
    </div>
  );
}

/** Un histogramme par seau : gouttière de graduations + cadre de barres. */
function BarsFrame() {
  return (
    <div className="flex gap-2 p-4 sm:p-5">
      <Skeleton className="h-40 w-9 shrink-0 sm:h-48 sm:w-12" />
      <Skeleton className="h-40 min-w-0 flex-1 sm:h-48" />
    </div>
  );
}

/**
 * Un tableau de quatre colonnes : en-tête, puis `rows` lignes. Même emprise que
 * les tableaux des chronos prévus et des records, dont les cellules font la
 * même hauteur.
 */
function TableFrame({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2 sm:px-5">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-12" />
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={row}
          className="flex items-center justify-between gap-3 border-b border-border px-4 py-2 last:border-b-0 sm:px-5"
        >
          <Skeleton className="h-3.5 w-14" />
          <Skeleton className="h-3.5 w-20" />
        </div>
      ))}
    </div>
  );
}

/**
 * Un paragraphe : `mobile` lignes sous `sm`, `wide` au-delà.
 *
 * Deux comptes, parce qu'un même texte n'occupe pas le même nombre de lignes de
 * part et d'autre de la gouttière — la colonne fait ~310 px sur téléphone et
 * ~900 px sur `max-w-5xl`, soit trois fois plus de caractères par ligne. Un
 * squelette taillé pour l'un saute sur l'autre, dans un sens ou dans l'autre.
 * Les lignes en trop sont masquées plutôt que rendues, pour que la gouttière
 * flex ne les compte pas.
 *
 * La dernière ligne de chaque paragraphe est plus courte : un bloc de lignes
 * toutes pleines se lit comme un cadre, pas comme du texte.
 */
function TextLines({
  mobile,
  wide,
  lineClass,
  className,
}: {
  mobile: number;
  wide: number;
  lineClass: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: mobile }, (_, line) => (
        <Skeleton
          key={line}
          className={cn(
            lineClass,
            line === mobile - 1 ? "w-2/3" : "w-full",
            // Au-delà de `wide` lignes, la ligne n'existe que sur mobile.
            line >= wide && "sm:hidden",
            // …et la dernière ligne visible sur large doit, elle aussi, être
            // plus courte que les précédentes.
            line === wide - 1 && mobile > wide && "sm:w-2/3",
          )}
        />
      ))}
    </div>
  );
}

/**
 * Squelette de la page « Progression ».
 *
 * Même géométrie que la page réelle (en-tête, filtre, indicateurs, panneaux de
 * courbes puis d'histogrammes) : à l'arrivée des données, rien ne doit sauter.
 * Toute modification de la mise en page doit être répercutée ici.
 */
export function ProgressionSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Chargement de la progression"
      className="flex flex-col gap-5 sm:gap-6"
    >
      <div className="min-w-0">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-2.5 h-8 w-56 max-w-full sm:h-9" />
        <Skeleton className="mt-2 h-3.5 w-72 max-w-full" />
      </div>

      <Skeleton className="h-8 w-56" />

      {/* Trois tuiles, mais pas trois fois la même : la fraîcheur TSB est une
          jauge (cf. `TsbGauge`), et elle occupe la deuxième case. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <div className="rounded-card border border-border bg-surface p-4 sm:p-5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-3 h-[1.9rem] w-20 sm:h-[2.3rem]" />
          <Skeleton className="mt-2.5 h-3 w-32 max-w-full" />
        </div>

        {/* Même géométrie que `Gauge` — libellé, arc **carré** (son viewBox
            l'est) centré sous les 10 rem du composant, puis la note centrée.
            Une tuile plate ici ferait grandir la rangée de ~140 px à l'arrivée
            des données. */}
        <div className="rounded-card border border-border bg-surface p-4 sm:p-5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mx-auto mt-3 aspect-square w-full max-w-[10rem]" />
          <Skeleton className="mx-auto mt-2.5 h-3 w-32 max-w-full" />
        </div>

        <div className="col-span-2 rounded-card border border-border bg-surface p-4 sm:p-5 md:col-span-1">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-3 h-[1.9rem] w-20 sm:h-[2.3rem]" />
          <Skeleton className="mt-2.5 h-3 w-32 max-w-full" />
        </div>
      </div>

      <PanelFrame>
        <div className="flex flex-col gap-4 p-4 sm:p-5">
          <Skeleton className="h-4 w-full" />
          {/* Un seul panneau depuis que CTL, ATL et TSB se superposent : même
              hauteur que `LOAD_PANEL`, titre + légende sur une ligne. */}
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-full" />
            <div className="flex gap-2">
              <Skeleton className="h-3 w-9 shrink-0 sm:w-12" />
              <Skeleton className="h-56 min-w-0 flex-1 sm:h-72" />
            </div>
          </div>
        </div>
      </PanelFrame>

      {/* Monotonie et contrainte : un panneau à deux axes, donc deux gouttières
          de graduations, et la note de lecture sous le graphe. */}
      <PanelFrame>
        <div className="flex flex-col gap-4 p-4 sm:p-5">
          <Skeleton className="h-4 w-full" />
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-full" />
            <div className="flex gap-2">
              <Skeleton className="h-44 w-9 shrink-0 sm:h-56 sm:w-12" />
              <Skeleton className="h-44 min-w-0 flex-1 sm:h-56" />
              <Skeleton className="h-44 w-9 shrink-0 sm:h-56 sm:w-12" />
            </div>
          </div>
          {/* La note de lecture (`MonotonyReading`) : ~270 caractères en
              `text-[0.82rem] leading-relaxed`, soit six lignes sur mobile et
              deux sur large — ~130 px et ~45 px. Un `h-8` (32 px) faisait
              grandir la card de cent pixels à l'arrivée des données. */}
          <TextLines mobile={6} wide={2} lineClass="h-3.5" />
        </div>
      </PanelFrame>

      <PanelFrame>
        <div className="flex gap-2 p-4 sm:p-5">
          <Skeleton className="h-40 w-9 shrink-0 sm:h-52 sm:w-12" />
          <Skeleton className="h-40 min-w-0 flex-1 sm:h-52" />
        </div>
      </PanelFrame>

      {/* Courses déclarées : le tableau, puis le pied qui explique le facteur
          correctif (un titre court et deux à trois phrases en `text-[0.78rem]
          leading-relaxed`, soit quatre lignes sur mobile et deux sur large).
          Le nombre de lignes n'est pas connu d'avance — trois est la géométrie
          d'un athlète qui a commencé à déclarer ses courses, et l'état vide,
          lui, occupe à peu près la même hauteur. */}
      <PanelFrame>
        <TableFrame rows={3} />
        <div className="border-t border-border px-4 py-3 sm:px-5">
          <Skeleton className="h-3 w-40" />
          <TextLines className="mt-2" mobile={4} wide={2} lineClass="h-3" />
        </div>
      </PanelFrame>

      {/* Chronos prévus : quatre distances, puis le pied qui porte l'ancre et
          la réserve de fiabilité. Trois paragraphes, pas deux lignes — la ligne
          « Chrono de référence », la phrase de source (avec sa note de
          recalibration éventuelle, ~270 caractères) et la réserve de fiabilité
          (jusqu'à trois phrases, ~350 caractères) en `text-[0.78rem]
          leading-relaxed`. Sur mobile le pied réel occupe 150 à 200 px, là où
          deux lignes en réservaient 64. */}
      <PanelFrame>
        <TableFrame rows={4} />
        <div className="border-t border-border px-4 py-4 sm:px-5">
          <div className="flex items-baseline justify-between gap-3">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3.5 w-24" />
          </div>
          <TextLines className="mt-2" mobile={3} wide={1} lineClass="h-3" />
          <TextLines className="mt-2.5" mobile={4} wide={2} lineClass="h-3" />
        </div>
      </PanelFrame>

      <PanelFrame>
        <BarsFrame />
      </PanelFrame>

      <PanelFrame>
        <BarsFrame />
      </PanelFrame>

      {/* Records personnels : six distances de référence, sans pied — la note
          « provisoires » n'apparaît que si le rattrapage reste à faire. */}
      <PanelFrame>
        <TableFrame rows={6} />
      </PanelFrame>

      {/* Bien-être : quatre mesures en deux colonnes, chacune libellé + valeur,
          courbe, puis compte de mesures. Même géométrie que `WellnessPanel`. */}
      <PanelFrame>
        <div className="grid gap-5 p-4 sm:grid-cols-2 sm:gap-6 sm:p-5">
          {[0, 1, 2, 3].map((measure) => (
            <div key={measure}>
              <div className="flex items-baseline justify-between gap-2">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-4 w-14" />
              </div>
              <Skeleton className="mt-3 h-14 w-full sm:h-16" />
              <Skeleton className="mt-2.5 h-3 w-32 max-w-full" />
            </div>
          ))}
        </div>
      </PanelFrame>

      <span className="sr-only">Chargement de la progression…</span>
    </div>
  );
}
