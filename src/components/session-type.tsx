import { cn } from "@/lib/utils";
import { sessionType, type SessionTypeToken } from "@/lib/plan-session-type";

/**
 * Le **code couleur par type de séance**, côté rendu : les tables jeton →
 * classes, et la puce qui accompagne un type écrit en toutes lettres.
 *
 * La correspondance `kind` → jeton, elle, vit dans `lib/plan-session-type.ts` :
 * elle est pure et testée, et ce module ne fait que l'habiller.
 *
 * ## Les classes sont écrites en toutes lettres, et c'est la seule façon
 *
 * Tailwind lit le source, pas l'exécution : `` `border-l-${token}` `` ne
 * produirait aucune règle et le filet sortirait transparent. Les tables
 * ci-dessous sont donc **totales et littérales** — chaque classe y apparaît
 * telle qu'elle sera émise.
 *
 * ## Où la couleur a le droit de vivre
 *
 * Dans le filet, le bandeau, la puce et les aplats — **jamais dans les
 * lettres**. Les huit jetons tiennent les 3:1 exigés d'un élément graphique
 * contre le fond, mais un micro-label de 0,68 rem est du texte : il lui faudrait
 * 4,5:1, que cinq des huit n'atteignent pas sur `surface-2` (`type-easy` 3,1:1,
 * `type-recovery` 3,8:1, `type-threshold` 2,8:1, `type-repetition` 2,7:1,
 * `type-event` 3,3:1). Le libellé de type reste donc en `fg-faint`, et c'est le
 * signe coloré qui porte la teinte — un élément graphique, pour qui 3:1 suffit.
 */

/**
 * Le filet de gauche d'une **ligne de séance** du plan, où c'est la hauteur de
 * la ligne qui donne à la couleur sa surface. La pastille du calendrier, elle,
 * n'a pas cette hauteur : elle porte un bandeau de tête
 * ({@link SESSION_TYPE_BAR}) sur toute sa largeur.
 */
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
 * Le **bloc de couleur d'une pastille** : son fond, teinté de la couleur du
 * type, et sa bordure.
 *
 * ## Un fond **opaque**, obtenu par `color-mix`
 *
 * `bg-type-easy/20` poserait un vert translucide, dont le rendu dépendrait de
 * ce qu'il y a dessous — et sous une pastille du calendrier, il y a tout : la
 * `surface` d'une case ordinaire, l'`accent-soft` d'aujourd'hui, le creux
 * `bg/80` d'un jour qui ne reçoit rien, le halo d'un dépôt en cours. Le
 * contraste du titre changerait de case en case, et `calendar-day-cell.tsx`
 * compte explicitement sur des pastilles au fond opaque pour poser son creux
 * sans toucher au contraste d'un seul texte.
 *
 * `color-mix(in srgb, <jeton> N%, var(--color-bg))` produit donc la **même
 * couleur, pleine**, que le jeton posé à N % sur `bg` — `in srgb` et pas
 * `in oklab` précisément pour que ce soit, au bit près, la composition alpha
 * qu'on a calculée. Aucune teinte nouvelle : deux jetons du système et un
 * pourcentage.
 *
 * ## Pourquoi un pourcentage **par jeton**
 *
 * À alpha égal, huit teintes ne coûtent pas le même contraste : le doré
 * `type-specific` éclaircit le fond bien plus que le vert `type-easy`. Chaque
 * dosage est donc le **plus fort** que deux planchers autorisent :
 *
 * 1. le micro-label `fg-faint` garde au moins le **4,33:1** qu'il a
 *    aujourd'hui sur `surface-2` (mesuré : 4,35 à 4,84 selon le jeton) ;
 * 2. le bandeau plein reste à **3:1** du fond qu'il coiffe (mesuré : 3,01 à
 *    5,58), sans quoi la couleur pleine se noierait dans sa propre teinte.
 *
 * D'où 14 % pour les teintes claires (`type-long`, `type-specific`) et jusqu'à
 * 20 % pour le vert sombre de l'endurance. Effet de bord heureux : les huit
 * fonds se retrouvent à une luminance quasi commune (1,00 à 1,11 contre la
 * case), et ne diffèrent donc plus que par la **teinte** — ce que l'œil lit
 * d'un coup d'œil sur un mois entier.
 *
 * La couleur pleine, elle, ne bouge pas d'un iota : c'est le bandeau
 * ({@link SESSION_TYPE_BAR}) qui la porte, avec le zigzag de luminosité validé
 * au validateur daltonien. Le fond teinté n'est qu'un renfort.
 */
export const SESSION_TYPE_BLOCK = {
  "type-recovery":
    "border-type-recovery/45 bg-[color-mix(in_srgb,var(--color-type-recovery)_16%,var(--color-bg))]",
  "type-easy":
    "border-type-easy/45 bg-[color-mix(in_srgb,var(--color-type-easy)_20%,var(--color-bg))]",
  "type-long":
    "border-type-long/45 bg-[color-mix(in_srgb,var(--color-type-long)_14%,var(--color-bg))]",
  "type-specific":
    "border-type-specific/45 bg-[color-mix(in_srgb,var(--color-type-specific)_14%,var(--color-bg))]",
  "type-threshold":
    "border-type-threshold/45 bg-[color-mix(in_srgb,var(--color-type-threshold)_16%,var(--color-bg))]",
  "type-interval":
    "border-type-interval/45 bg-[color-mix(in_srgb,var(--color-type-interval)_16%,var(--color-bg))]",
  "type-repetition":
    "border-type-repetition/45 bg-[color-mix(in_srgb,var(--color-type-repetition)_14%,var(--color-bg))]",
  "type-event":
    "border-type-event/45 bg-[color-mix(in_srgb,var(--color-type-event)_18%,var(--color-bg))]",
} as const satisfies Record<SessionTypeToken, string>;

/**
 * Le cran de plus d'une séance qui structure le plan — la course objectif,
 * aujourd'hui la seule à en porter un.
 *
 * Une bordure presque pleine là où les autres l'ont à 45 % : le bloc est
 * **cerné**, et se voit de loin comme le point d'arrivée de la grille. Le fond
 * et le bandeau, eux, restent ceux de son type : la course ne se distingue pas
 * en changeant de couleur, elle se distingue en l'affirmant.
 *
 * S'applique **après** {@link SESSION_TYPE_BLOCK} et **avant** le bandeau — cf.
 * l'ordre expliqué sur {@link SESSION_TYPE_BAR}.
 */
export const SESSION_TYPE_EDGE_STRONG = {
  "type-recovery": "border-type-recovery/85",
  "type-easy": "border-type-easy/85",
  "type-long": "border-type-long/85",
  "type-specific": "border-type-specific/85",
  "type-threshold": "border-type-threshold/85",
  "type-interval": "border-type-interval/85",
  "type-repetition": "border-type-repetition/85",
  "type-event": "border-type-event/85",
} as const satisfies Record<SessionTypeToken, string>;

/**
 * Le **bandeau de tête** d'une pastille : la couleur du type, pleine, sur toute
 * la largeur du bloc. C'est lui qu'on voit avant de lire quoi que ce soit.
 *
 * C'est le bord haut de la pastille, épaissi par la géométrie
 * (`border-t-4`) et coloré ici. Un bord plutôt qu'un élément : il suit le rayon
 * de la carte tout seul, et il ne coûte ni nœud ni marge négative.
 *
 * **À écrire en dernier dans le `cn`**, après l'aplat, après le cran de la
 * course et surtout après le liseré `border-accent/60` du glissement : les
 * utilitaires de couleur par côté sont émis **après** la forme raccourcie
 * (vérifié dans le CSS compilé), donc le bandeau reprend le bord haut à tout ce
 * qui précède. Sans quoi l'accent de l'interaction recouvrirait la couleur de
 * la donnée le temps d'un déplacement.
 */
export const SESSION_TYPE_BAR = {
  "type-recovery": "border-t-type-recovery",
  "type-easy": "border-t-type-easy",
  "type-long": "border-t-type-long",
  "type-specific": "border-t-type-specific",
  "type-threshold": "border-t-type-threshold",
  "type-interval": "border-t-type-interval",
  "type-repetition": "border-t-type-repetition",
  "type-event": "border-t-type-event",
} as const satisfies Record<SessionTypeToken, string>;

/**
 * L'aplat translucide d'une **petite marque** posée dans le flux d'un texte —
 * la pastille « Jour J » du calendrier, seule à en porter un.
 *
 * 15 % et une bordure à 45 % : exactement le dosage de l'`accent-soft` (.14)
 * qu'il remplace, pour que la marque garde son poids sans que la couleur du
 * type ne devienne un aplat plein. Translucide, et c'est voulu : contrairement
 * à une pastille de séance, cette marque est *dans* la case et doit en laisser
 * passer le fond.
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
