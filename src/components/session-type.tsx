import { cn } from "@/lib/utils";
import { sessionType, type SessionTypeToken } from "@/lib/plan-session-type";

/**
 * Le **code couleur par type de séance**, côté rendu : la table jeton →
 * classes, et la puce qui accompagne un type écrit en toutes lettres.
 *
 * La correspondance `kind` → jeton, elle, vit dans `lib/plan-session-type.ts` :
 * elle est pure et testée, et ce module ne fait que l'habiller.
 *
 * ## Les classes sont écrites en toutes lettres, et c'est la seule façon
 *
 * Tailwind lit le source, pas l'exécution : `` `border-l-${token}` `` ne
 * produirait aucune règle et le filet sortirait transparent. Les trois tables
 * ci-dessous sont donc **totales et littérales** — chaque classe y apparaît
 * telle qu'elle sera émise.
 *
 * ## Où la couleur a le droit de vivre
 *
 * Dans le filet, la puce et l'aplat soft — **jamais dans les lettres**. Les huit
 * jetons tiennent les 3:1 exigés d'un élément graphique contre le fond, mais un
 * micro-label de 0,68 rem est du texte : il lui faudrait 4,5:1, que cinq des
 * huit n'atteignent pas sur `surface-2` (`type-easy` 3,1:1, `type-recovery`
 * 3,8:1, `type-threshold` 2,8:1, `type-repetition` 2,7:1, `type-event` 3,3:1).
 * Le libellé de type reste donc en `fg-faint`, et c'est la puce qui porte sa
 * couleur — un élément graphique, pour qui 3:1 suffit.
 */

/** Le filet de gauche d'une pastille ou d'une ligne de séance. */
export const SESSION_TYPE_RAIL = {
  "type-recovery": "border-l-type-recovery",
  "type-easy": "border-l-type-easy",
  "type-long": "border-l-type-long",
  "type-specific": "border-l-type-specific",
  "type-threshold": "border-l-type-threshold",
  "type-interval": "border-l-type-interval",
  "type-repetition": "border-l-type-repetition",
  "type-event": "border-l-type-event",
} as const satisfies Record<SessionTypeToken, string>;

/** La puce qui précède un type écrit — et l'échantillon d'une légende. */
export const SESSION_TYPE_DOT = {
  "type-recovery": "bg-type-recovery",
  "type-easy": "bg-type-easy",
  "type-long": "bg-type-long",
  "type-specific": "bg-type-specific",
  "type-threshold": "bg-type-threshold",
  "type-interval": "bg-type-interval",
  "type-repetition": "bg-type-repetition",
  "type-event": "bg-type-event",
} as const satisfies Record<SessionTypeToken, string>;

/**
 * L'aplat d'une séance qui structure le plan — la course objectif, aujourd'hui
 * la seule à en porter un.
 *
 * 15 % et une bordure à 45 % : exactement le dosage de l'`accent-soft` (.14)
 * qu'il remplace, pour que la carte garde son poids sans que la couleur du type
 * ne devienne un aplat plein.
 */
export const SESSION_TYPE_SOFT = {
  "type-recovery": "border-type-recovery/45 bg-type-recovery/15",
  "type-easy": "border-type-easy/45 bg-type-easy/15",
  "type-long": "border-type-long/45 bg-type-long/15",
  "type-specific": "border-type-specific/45 bg-type-specific/15",
  "type-threshold": "border-type-threshold/45 bg-type-threshold/15",
  "type-interval": "border-type-interval/45 bg-type-interval/15",
  "type-repetition": "border-type-repetition/45 bg-type-repetition/15",
  "type-event": "border-type-event/45 bg-type-event/15",
} as const satisfies Record<SessionTypeToken, string>;

/**
 * Le type d'une séance, **écrit** et précédé de sa puce.
 *
 * Le texte affiché est le `kind` tel qu'il est stocké, suffixe compris (« VMA
 * courte · piste ») : c'est lui qui dit la séance, la puce ne fait que la
 * ranger dans sa famille. Un `kind` hors vocabulaire perd sa puce et garde son
 * libellé — jamais l'inverse.
 *
 * La puce est `aria-hidden` : elle ne dit rien que le libellé ne dise déjà.
 */
export function SessionTypeLabel({ kind, className }: { kind: string; className?: string }) {
  const type = sessionType(kind);

  return (
    <span className={cn("eyebrow inline-flex min-w-0 items-center gap-1.5", className)}>
      {type === null ? null : (
        <span
          aria-hidden="true"
          className={cn("size-1.5 shrink-0 rounded-full", SESSION_TYPE_DOT[type.token])}
        />
      )}
      <span className="min-w-0 truncate">{kind}</span>
    </span>
  );
}
