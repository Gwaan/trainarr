import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit ne charge que `.env` par défaut, alors que le dev travaille dans
 * `.env.local` (convention Next.js). On charge donc explicitement les deux, avec
 * la même priorité que Next : `.env.local` l'emporte sur `.env`.
 */
function loadEnvFile(path: string): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // Fichier absent : normal selon l'environnement (dev vs Docker).
  }
}

loadEnvFile('.env.local');
loadEnvFile('.env');

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL est requise pour drizzle-kit. Renseigne-la dans .env.local (dev) ou .env (Docker).',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/data/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: databaseUrl },
});
