"use client";

import { useState } from "react";
import { Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { metricSheet, type MetricSheetId } from "../_lib/metric-sheets";

/**
 * Le déclencheur ⓘ posé à côté d'une abréviation, et la fiche qu'il ouvre.
 *
 * Composant client minimal : il ne fait qu'ouvrir une modale sur du contenu
 * **statique**, importé depuis `_lib/metric-sheets`. Aucun fetch, aucune Server
 * Action — une fiche ne dépend d'aucune donnée de l'athlète.
 *
 * **Cible tactile.** L'icône fait 14 px, sinon elle concurrencerait la valeur
 * qu'elle annote. La zone cliquable, elle, est étendue à 44 px par un
 * pseudo-élément : c'est le minimum tactile, et le doigt ne vise pas un
 * pictogramme de la taille d'un point.
 *
 * Aucun accent ici : le système en réserve un seul par écran, et il est pris
 * ailleurs. Le déclencheur vit en `fg-faint`, l'accent n'apparaît qu'au survol
 * et au focus — c'est-à-dire quand il devient l'élément actif.
 */
export function MetricInfo({
  id,
  className,
}: {
  id: MetricSheetId;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const sheet = metricSheet(id);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={sheet.question}
          className={cn(
            "relative inline-flex size-4 shrink-0 items-center justify-center rounded-full align-middle",
            "text-fg-faint transition-colors duration-150 ease-out hover:text-accent",
            "focus-visible:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            // Zone tactile de 44 px autour d'une icône de 14 : le doigt vise la
            // bande, l'œil ne voit que le pictogramme.
            "before:absolute before:-inset-3.5 before:content-['']",
            className,
          )}
        >
          <Info aria-hidden="true" strokeWidth={1.8} className="size-3.5" />
        </button>
      </DialogTrigger>

      <DialogContent>
        <header className="shrink-0 border-b border-border px-4 py-3.5 sm:px-5">
          <DialogTitle>
            {sheet.abbreviation} — {sheet.name}
          </DialogTitle>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4 sm:px-5 sm:py-5">
          <section>
            <h3 className="eyebrow">Ce que c&apos;est</h3>
            {/* `DialogDescription` : Radix le lie en `aria-describedby`, c'est
                donc lui qui doit porter la définition, pas un `<p>` nu. */}
            <DialogDescription className="mt-2 text-[0.85rem] leading-relaxed text-fg-muted">
              {sheet.what}
            </DialogDescription>
          </section>

          <SheetList title="Comment la lire" items={sheet.interpret} />
          <SheetList title="Comment elle est calculée" items={sheet.computed} />

          {sheet.caveat === undefined ? null : (
            <p className="rounded-button border border-border bg-surface-2 px-3 py-2.5 text-[0.82rem] leading-relaxed text-fg-muted">
              <span className="eyebrow block">Ce que ça ne dit pas</span>
              <span className="mt-1.5 block">{sheet.caveat}</span>
            </p>
          )}
        </div>

        {/* Plein écran sur mobile : sans `Esc` ni extérieur à cliquer, ce bouton
            est la seule sortie — et il doit dégager l'indicateur d'accueil. */}
        <div className="flex shrink-0 items-center border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5 sm:pb-3">
          <Button
            type="button"
            variant="ghost"
            className="ml-auto"
            onClick={() => setOpen(false)}
          >
            Fermer
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SheetList({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <section>
      <h3 className="eyebrow">{title}</h3>
      <ul className="mt-2 flex flex-col gap-2">
        {items.map((item) => (
          <li
            key={item}
            className="flex gap-2.5 text-[0.85rem] leading-relaxed text-fg-muted"
          >
            <span
              aria-hidden="true"
              className="mt-[0.55em] size-1 shrink-0 rounded-full bg-fg-faint"
            />
            <span className="min-w-0">{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
