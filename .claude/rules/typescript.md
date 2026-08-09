---
description: Conventions TypeScript et qualité de code
paths:
  - "src/**/*.ts"
  - "src/**/*.tsx"
---

# TypeScript

- Mode `strict` obligatoire. Jamais de `any` (utiliser `unknown` + narrowing) ; pas de `as` sauf impossibilité prouvée.
- Valider **toutes** les entrées externes avec Zod : inputs de Server Actions, payloads webhook Strava, réponses des APIs LLM, variables d'env (`src/config/`).
- Types inférés depuis le schéma Drizzle (`InferSelectModel`) et depuis les schémas Zod (`z.infer`) — ne pas dupliquer les types à la main.
- Erreurs : les services retournent des erreurs typées (pattern Result ou throw d'erreurs métier nommées) ; jamais de `catch` silencieux.
- Nommage : fichiers en kebab-case, composants React en PascalCase, le reste en camelCase.
- Tests Vitest sur le DAL (`src/data/`), les services et les calculs physio (`lib/metrics/`) — pas sur les Server Actions directement (elles sont minces par construction).
- Gestionnaire de paquets : **pnpm exclusivement** (`pnpm add`, `pnpm exec`, `pnpm dlx`) — jamais npm/npx/yarn.
