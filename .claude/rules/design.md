---
description: Design system "Pulse" — tokens, typo, motion, composants
paths:
  - "src/app/**"
  - "src/components/**"
  - "src/styles/**"
---

# Design system — « Pulse »

Direction validée par Gwen, en remplacement de « Night Track » (accent orange
unique, jugé trop restrictif). Sombre uniquement, comme avant — ce qui change,
c'est la **couleur** (accent indigo électrique, rampe de zones multi-teintes,
un code couleur par type de séance), la **profondeur** et les **rayons**. La
typographie est **inchangée** : c'est l'identité qui fonctionne.

Toutes les valeurs ci-dessous sortent du validateur dataviz du projet
(daltonisme simulé Machado 2009, bande de luminosité, chroma, contraste).
**Statut du validateur (décidé par Gwen, 16/08/2026) : consultatif, pas
bloquant.** L'appli est personnelle (Gwen + quelques proches) : les contraintes
d'accessibilité stricte (daltonisme, seuils ΔE) ne sont pas un gate. On garde
la palette existante parce qu'elle est cohérente et lisible, pas par
conformité ; une nouvelle couleur qui sert le design s'ajoute sans repasser le
validateur. La lisibilité de base (contraste texte, données étiquetées) reste
de mise — c'est du confort de lecture, pas de la conformité.

## Tokens (Tailwind v4, `@theme` dans `globals.css`)

```css
/* Fonds (du plus profond au plus élevé) */
--color-bg:        #0B0D16;   /* page */
--color-surface:   #121624;   /* cards, panels */
--color-surface-2: #1A2032;   /* hover, éléments imbriqués */
--color-border:    #272E44;

/* Texte */
--color-fg:        #EEF0F8;   /* titres, valeurs — 17,0:1 sur bg · 15,8:1 sur surface */
--color-fg-muted:  #A9B1C6;   /* corps — 8,4:1 sur surface */
--color-fg-faint:  #7A849D;   /* labels, légendes — 4,8:1 sur surface */

/* Accent — UN SEUL, ne jamais en introduire d'autre */
--color-accent:        #8A94FF;             /* texte, icônes actives, filets — 7,2:1 sur bg */
--color-accent-strong: #5B5FE8;             /* aplats — blanc dessus : 4,9:1 */
--color-accent-soft:   rgba(99,102,241,.14);

/* Sémantique (≠ accent, réservé aux états) */
--color-positive:  #4ADE80;   /* progression, records */
--color-warning:   #FBBF24;   /* fatigue modérée */
--color-negative:  #F87171;   /* surentraînement, erreurs */
```

**Deux jetons d'accent, deux rôles.** `accent` est l'accent de trait : texte,
icône active, filet de sélection, courbe. C'est lui que portent `text-accent`,
`border-accent`, et c'est lui qu'on peut recouvrir d'un texte `bg` (#0B0D16 sur
#8A94FF : 7,2:1). `accent-strong` est l'accent d'aplat : plus dense, c'est le
seul qui supporte du **blanc** (4,9:1), et c'est lui que portent les marques
autonomes (favicon, icônes PWA) où l'aplat est vu très petit sur le fond du
système. Ne pas poser du blanc sur `accent` ni du texte `bg` sur
`accent-strong` : dans les deux cas le contraste s'effondre.

Règle conservée : **un seul CTA accent par écran**, le reste en ghost/outline.
**L'accent est l'action et la sélection, jamais une donnée.**

Mode clair : non prioritaire (l'appli est sombre par identité). S'il est ajouté
un jour, dériver les tokens — ne jamais inverser naïvement.

## Zones cardio — rampe multi-teintes vert → framboise

```css
--color-zone-1: #217C44;   /* vert */
--color-zone-2: #B3910B;   /* or */
--color-zone-3: #A74A04;   /* orange profond */
--color-zone-4: #EC5754;   /* rouge */
--color-zone-5: #BE1274;   /* framboise */
```

Preuve (validateur, mode sombre, surface #0B0D16) : bande L **0,48–0,67** ✓ ·
chroma ≥ 0,1 ✓ · **pire ΔE daltonien adjacent 11,2** (cible ≥ 8) ✓ · pire ΔE
vision normale **15,5** (plancher 15) ✓ · contraste ≥ 3:1 contre le rail ✓.

| Zone | Hex | Contraste vs rail `bg` #0B0D16 | L (OKLab) | C (OKLCh) | h |
|------|-----|-------------------------------|-----------|-----------|---|
| Z1 | `#217C44` | 3,72 | 0,520 | 0,121 | 152° |
| Z2 | `#B3910B` | 6,44 | 0,669 | 0,135 | 92° |
| Z3 | `#A74A04` | 3,35 | 0,521 | 0,140 | 48° |
| Z4 | `#EC5754` | 5,59 | 0,654 | 0,185 | 25° |
| Z5 | `#BE1274` | 3,26 | 0,530 | 0,210 | 354° |

**La séparation daltonienne repose sur un zigzag de luminosité** (foncé, clair,
foncé, clair, foncé : 0,52 · 0,67 · 0,52 · 0,65 · 0,53). Ce n'est pas un
accident de la sélection, c'est la propriété qui fait tenir la rampe : deux
zones voisines que la teinte ne sépare plus sous deutéranopie restent séparées
par la clarté. Toute retouche — même « juste éclaircir Z3 » — casse le zigzag ;
si on retouche, le validateur permet de vérifier qu'on ne perd pas la
lisibilité, mais ce n'est plus un passage obligé.

Le contrat précédent (lightness strictement croissante Z1→Z5, teinte unique)
est **abandonné** : il produisait une rampe monochrome qui échouait au
validateur là où celle-ci passe.

**Rail des barres de zones : `bg` (#0B0D16), pas `surface-2`.** Un remplissage
de zone est un élément graphique porteur d'information : WCAG 1.4.11 lui impose
**3:1 contre ce qui l'entoure**, c'est-à-dire contre le rail. Les cinq
remplissages tiennent contre `bg` (minimum 3,26, sur Z5) ; contre `surface-2`
(#1A2032) plusieurs passeraient sous le seuil. Mesurer le rail réellement
utilisé dans le composant, jamais `surface`.

**La couleur ne porte jamais l'information seule** : chaque segment garde son
étiquette Z1..Z5 + sa durée.

## Types de séance

```css
--color-type-recovery:   #507CB5;   /* Récupération */
--color-type-easy:       #217C44;   /* Endurance fondamentale (= Z1) */
--color-type-long:       #34A7A3;   /* Sortie longue */
--color-type-specific:   #B3910B;   /* Spécifique allure course (= Z2) */
--color-type-threshold:  #A74A04;   /* Seuil (= Z3) */
--color-type-interval:   #EC5754;   /* VMA (= Z4) */
--color-type-repetition: #BE1274;   /* Répétitions (= Z5) */
--color-type-event:      #5D69CB;   /* Course ET test chronométré */
```

Les huit ont été validés **ensemble, dans cet ordre** : pire ΔE daltonien
adjacent 11,2 ✓, vision normale 15,5 ✓, contraste ≥ 3:1 contre le fond ✓. Les
cinq types qui correspondent à une zone en reprennent exactement la couleur —
l'endurance fondamentale *est* Z1, le seuil *est* Z3 : deux teintes différentes
pour la même intensité seraient un mensonge visuel.

**Décision à garder : le test chronométré partage l'indigo de la course.** Les
deux forment la famille « événement ». Un violet distinct avait été essayé et
rejeté — indiscernable de l'indigo en vision deutan (**ΔE 0,9**). Deux libellés
distincts suffisent à les séparer ; une couleur de plus n'aurait rien séparé.

Attention à ne pas confondre `type-event` (#5D69CB) avec l'accent (#8A94FF) :
l'un est une donnée, l'autre est l'interaction. Ils ne doivent jamais se
retrouver côte à côte dans le même rôle.

## Typographie (inchangée)

- **Display / titres** : `Archivo` (variable, graisses 600–800, letter-spacing léger négatif). Chargée via `next/font/google`, qui télécharge et auto-héberge les woff2 **au build** — aucune requête CDN au runtime. Ne jamais référencer une URL de fonte distante.
- **Corps / UI** : `Archivo` 400–500.
- **Données chiffrées** : `JetBrains Mono` + `font-variant-numeric: tabular-nums` — toutes les valeurs (allures, distances, FC, KPIs) sont en mono, c'est la signature visuelle.
- Interdits : Inter, Roboto, fontes système par défaut.
- Labels de sections : uppercase, `text-[0.68rem]`, `tracking-[0.1em]`, couleur `fg-faint`.

## Composants & layout

- Base **shadcn/ui** (Radix), re-thémée avec les tokens ci-dessus. Radius :
  **`14px` cards, `10px` boutons** — cohérent partout, via `--radius-card` et
  `--radius-button`. Ne jamais écrire un rayon en dur.
- Cards : `surface` + bordure `border`, **pas d'ombre portée** — la profondeur
  vient des fonds superposés (`bg` → `surface` → `surface-2`), pas d'un flou
  noir. Un liseré clair en haut de card est toléré s'il se fait en tokens et
  sur une primitive commune ; il n'y en a pas aujourd'hui (les cards sont
  composées à la main, site par site), donc **ne pas en saupoudrer un** au coup
  par coup.
- Nav : sidebar desktop (item actif = filet `accent` à gauche + fond `accent-soft`), bottom-nav mobile. Mobile-first : le « plan du jour » doit être parfait sur téléphone.
- Un seul CTA accent par écran ; le reste des actions en ghost/outline.
- Empty states dessinés (icône + phrase + action), jamais de zone vide brute.

## Marque

La marque (piste d'athlétisme vue de dessus) vit en trois exemplaires qui
doivent rester synchronisés :

- `src/components/nav/logo.tsx` (`TrackMark`) — en classes Tailwind, anneau
  `stroke-accent`, intérieur `stroke-fg-faint` ; suit les tokens tout seul ;
- `public/icons/trainarr-mark.svg` — master vectoriel, tokens résolus en dur ;
- les PNG dérivés (`public/icons/icon-{192,512}.png`,
  `icon-maskable-512.png`, `src/app/apple-icon.png`) et le favicon
  `src/app/icon.svg`.

**Divergence assumée** : les marques autonomes (master, favicon, PNG) utilisent
`accent-strong` #5B5FE8 pour l'anneau, là où `TrackMark` porte `accent`
#8A94FF — un aplat vu à 16 px sur le fond du système n'est pas un filet vu à
24 px dans l'appli. Intérieur `#7A849D` (`fg-faint`), fond `#0B0D16` (`bg`) des
deux côtés.

Cadrage des PNG : l'emprise du logo (22 u de large, centrée sur (12, 12) dans le
viewBox 24×24) occupe **72 %** de la largeur de l'icône, **55 %** pour la
version maskable (les lanceurs Android rognent à une forme arbitraire). Fond
plein `bg`, coins carrés. `background_color` / `theme_color` du manifeste et
`viewport.themeColor` valent `bg` : toute autre valeur produirait un flash
lumineux à l'ouverture.

## Graphes (courbes FC/allure, charge ATL/CTL/TSB)

**Direction data-oriented (Gwen, 16/08/2026), façon Runalyze : la
superposition est la norme, pas l'exception.** Les séries d'une même séance se
lisent ensemble (FC + allure + altitude sur un même panneau, axes multiples
autorisés) ; les métriques de charge se combinent (ATL/CTL en aires/courbes
superposées, TSB en barres sur le même graphe) ; les valeurs instantanées type
TRIMP s'affichent en **jauge** plutôt qu'en tuile passive. L'ancienne règle
« un panneau = une série, jamais deux axes » est abandonnée.

Couleurs de séries : allure = `accent` (indigo), FC = `negative` (#F87171),
altitude = remplissage `fg-faint` ~15 %, cadence = `--color-chart-cadence`
(#38BDF8, 9,1:1 vs `bg`), foulée = `--color-chart-stride` (#2DD4BF, teal,
10,4:1 vs `bg` — famille froide distincte de la cadence bleue).
**Le texte reste en tokens texte, jamais en couleur de série.**

`--color-chart-cadence` et `--color-chart-stride` servent **aussi** de marqueurs
de rôle des étapes d'une séance dans le détail du plan (récupération en cadence,
retour au calme en stride) — extension validée par Gwen, qui demandait un code
couleur pour ces étapes. Là encore, les données chiffrées restent en tokens
texte : la couleur ne porte que le rôle, jamais la valeur.

- Fond transparent, grille quasi invisible (`border` à 40%), courbe 2px, remplissage `accent` à 12–14%, point terminal accentué.
- Zones cardio avec la rampe dédiée ci-dessus. Tooltips en mono. Suivre le skill dataviz pour tout nouveau graphe.

## Motion (inchangée)

- Transitions 120–180 ms, `ease-out`. View Transitions (React 19.2) entre pages.
- Micro-interactions utiles uniquement (press, hover, apparition des stats) — jamais décoratives. Respecter `prefers-reduced-motion`.
