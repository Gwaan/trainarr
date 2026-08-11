import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Squelette d'un feedback de coach : un intertitre puis un paragraphe aux
 * largeurs décroissantes — la forme qu'a le markdown rendu par `MarkdownLite`.
 *
 * Un seul dessin, deux usages : le fallback de `Suspense` du panneau (lecture en
 * base) et l'attente de la génération (plusieurs minutes sur un modèle local).
 * Purement décoratif — chaque barre est `aria-hidden` via `Skeleton`, l'attente
 * est annoncée par la région live du formulaire. L'animation `animate-pulse` est
 * neutralisée par la règle `prefers-reduced-motion` de `globals.css`.
 */
export function CoachFeedbackSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      <Skeleton className="h-3.5 w-52 max-w-full" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-11/12" />
      <Skeleton className="h-3 w-9/12" />
    </div>
  );
}
