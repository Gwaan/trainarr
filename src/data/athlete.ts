import 'server-only';

import { asc } from 'drizzle-orm';

import { db } from './db/client';
import { athlete, type Athlete } from './db/schema';

/**
 * DTO du profil athlète exposé à l'UI.
 *
 * Déclaré explicitement (pas de `typeof row`) : ajouter une colonne au schéma ne
 * doit jamais l'élargir en silence.
 */
export type AthleteProfileDto = {
  id: number;
  displayName: string;
  maxHrBpm: number | null;
  restingHrBpm: number | null;
  weightKg: number | null;
  /** Date civile `YYYY-MM-DD`. */
  birthDate: string | null;
};

export function toAthleteProfileDto(row: Athlete): AthleteProfileDto {
  return {
    id: row.id,
    displayName: row.displayName,
    maxHrBpm: row.maxHrBpm,
    restingHrBpm: row.restingHrBpm,
    weightKg: row.weightKg,
    birthDate: row.birthDate,
  };
}

/**
 * Profil de l'athlète. Application mono-utilisateur : la première (et unique)
 * ligne de la table. `null` tant que l'onboarding n'a pas eu lieu.
 */
export async function getAthleteProfile(): Promise<AthleteProfileDto | null> {
  const rows = await db.select().from(athlete).orderBy(asc(athlete.id)).limit(1);
  const row = rows[0];
  return row ? toAthleteProfileDto(row) : null;
}
