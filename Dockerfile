# syntax=docker/dockerfile:1

# --- Base commune : Node 22 + pnpm via corepack -------------------------------
FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable pnpm
WORKDIR /app

# --- deps : dépendances installées depuis le lockfile figé --------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# --- builder : build Next.js en mode standalone -------------------------------
FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# --- migrator : image éphémère qui applique les migrations avant le démarrage --
# Stage séparé volontairement : le build standalone n'expose aucun
# `node_modules/drizzle-orm` (Turbopack bundle les dépendances serveur dans les
# chunks de l'app ; `.next/standalone/node_modules` ne contient que next/react),
# donc un script de migration lancé depuis l'image de runtime n'aurait rien à
# charger. Ce stage réutilise la couche `deps` (aucun téléchargement en plus) et
# n'est jamais déployé : compose le lance en one-shot puis le container sort.
FROM base AS migrator
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY drizzle ./drizzle
COPY tsconfig.json ./
# `src` en entier, et non les seuls fichiers de `migrate.ts` : ce stage sert
# aussi aux rattrapages de `scripts/`, qui remontent dans `src/data/db/` et
# `src/lib/metrics/`. Énumérer leurs imports ici les casserait au premier
# refactor, en production et pas au build. Ce ne sont que des sources, jamais
# déployées — l'image est jetée quand le container one-shot sort.
COPY src ./src
COPY scripts ./scripts
# Binaire appelé directement plutôt que via `pnpm exec` : corepack tenterait de
# télécharger pnpm au démarrage du container, ce qui suppose un accès réseau.
CMD ["node_modules/.bin/tsx", "src/data/db/migrate.ts"]

# --- runner : image finale minimale, sans pnpm ni sources ---------------------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 --ingroup nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Boîte de dépôt des fichiers FIT : ce container y écrit (point WebDAV /dav),
# la lit et la range (service d'import, cf. src/lib/fit/service.ts). Le
# répertoire est créé et donné à `nextjs` **dans l'image** : Docker recopie
# propriétaire et permissions du chemin de l'image lorsqu'il initialise un volume
# nommé **vide**.
#
# Défense en profondeur seulement : cette recopie n'a lieu qu'à la création du
# volume. Sur un volume existant, elle ne s'applique pas du tout. La garantie,
# elle, vient du service `migrate` de docker-compose.yml, qui chown le volume en
# root avant que `app` ne démarre.
RUN mkdir -p /data/fit-inbox && chown -R nextjs:nodejs /data

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
