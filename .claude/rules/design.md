---
description: Design system "Night Track" — tokens, typo, motion, composants
paths:
  - "src/app/**"
  - "src/components/**"
  - "src/styles/**"
---

# Design system — « Night Track »

Direction validée par Gwen (maquette A). Dark-first, ambiance « séance du soir sur piste éclairée » : fond nocturne bleuté, données lumineuses, un seul accent incandescent. Toute UI doit s'y conformer — pas d'écart de palette ou de typo sans validation.

## Tokens (Tailwind v4, `@theme` dans `globals.css`)

```css
/* Fonds (du plus profond au plus élevé) */
--color-bg:        #0A0E16;   /* page */
--color-surface:   #0F1420;   /* cards, panels */
--color-surface-2: #141B2B;   /* hover, éléments imbriqués */
--color-border:    #1A2233;

/* Texte */
--color-fg:        #E9EDF4;   /* titres, valeurs */
--color-fg-muted:  #AAB3C2;   /* corps */
--color-fg-faint:  #7A8598;   /* labels, légendes */

/* Accent — UN SEUL, ne jamais en introduire d'autre */
--color-accent:       #FF4D00;  /* actions, sélection, série en cours */
--color-accent-soft:  rgba(255,77,0,.12);

/* Sémantique (≠ accent, réservé aux états) */
--color-positive:  #A3E635;   /* progression, records */
--color-warning:   #FBBF24;   /* fatigue modérée */
--color-negative:  #F87171;   /* surentraînement, erreurs */

/* Zones cardio (graphes uniquement) : Z1 #64748B, Z2 #38BDF8, Z3 #A3E635, Z4 #FBBF24, Z5 #FF4D00 */
```

Mode clair : non prioritaire (l'appli est dark-first par identité). S'il est ajouté un jour, dériver les tokens — ne jamais inverser naïvement.

## Typographie

- **Display / titres** : `Archivo` (variable, graisses 600–800, letter-spacing léger négatif). Chargée via `next/font/google`, qui télécharge et auto-héberge les woff2 **au build** — aucune requête CDN au runtime. Ne jamais référencer une URL de fonte distante.
- **Corps / UI** : `Archivo` 400–500.
- **Données chiffrées** : `JetBrains Mono` + `font-variant-numeric: tabular-nums` — toutes les valeurs (allures, distances, FC, KPIs) sont en mono, c'est la signature visuelle.
- Interdits : Inter, Roboto, fontes système par défaut, dégradés violets.
- Labels de sections : uppercase, `text-[0.68rem]`, `tracking-[0.1em]`, couleur `fg-faint`.

## Composants & layout

- Base **shadcn/ui** (Radix), re-thémée avec les tokens ci-dessus. Radius : `10px` cards, `8px` boutons — cohérent partout.
- Cards : `surface` + bordure `border`, pas d'ombre portée (le contraste vient des fonds superposés).
- Nav : sidebar desktop (item actif = filet accent à gauche + fond `accent-soft`), bottom-nav mobile. Mobile-first : le « plan du jour » doit être parfait sur téléphone.
- Un seul CTA accent par écran ; le reste des actions en ghost/outline.
- Empty states dessinés (icône + phrase + action), jamais de zone vide brute.

## Graphes (courbes FC/allure, charge ATL/CTL/TSB)

- Fond transparent, grille quasi invisible (`border` à 40%), courbe 2px, remplissage `accent` à 12–14%, point terminal accentué.
- Zones cardio avec la rampe dédiée ci-dessus. Tooltips en mono. Suivre le skill dataviz pour tout nouveau graphe.

## Motion

- Transitions 120–180 ms, `ease-out`. View Transitions (React 19.2) entre pages.
- Micro-interactions utiles uniquement (press, hover, apparition des stats) — jamais décoratives. Respecter `prefers-reduced-motion`.
