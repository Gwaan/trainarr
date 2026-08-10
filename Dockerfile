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
COPY src/data/db/migrate.ts ./src/data/db/migrate.ts
# Binaire appelé directement plutôt que via `pnpm exec` : corepack tenterait de
# télécharger pnpm au démarrage du container, ce qui suppose un accès réseau.
CMD ["node_modules/.bin/tsx", "src/data/db/migrate.ts"]

# --- worker : services longue durée exécutés hors du serveur Next -------------
# Même approche que `migrator` (réutilise la couche `deps`, exécute du TypeScript
# via tsx) mais ce container-ci ne sort pas : il surveille le dossier d'import FIT.
#
# `--conditions=react-server` : le watcher importe le DAL, dont les modules
# commencent par `import 'server-only'`. Hors de cette condition d'export, ce
# paquet lève volontairement à l'import. C'est exactement le drapeau que Next
# positionne pour ses modules serveur.
FROM base AS worker
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
# tsconfig.json est nécessaire : tsx y lit l'alias `@/*`.
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
CMD ["node_modules/.bin/tsx", "--conditions=react-server", "scripts/fit-watcher.ts"]

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

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
