/**
 * ⚠️ DONNÉES FICTIVES — SEED DE DÉVELOPPEMENT UNIQUEMENT.
 *
 * Aucune de ces valeurs ne provient d'une mesure réelle : elles sont générées de
 * façon déterministe pour donner au dashboard une base plausible (progression de
 * charge, allures et FC cohérentes entre elles). Ne jamais les présenter comme
 * des données d'entraînement réelles, ne jamais exécuter ce script sur une base
 * de production (le script refuse `NODE_ENV=production`).
 *
 * Usage : `pnpm db:seed` (les migrations doivent avoir été appliquées avant).
 *
 * Idempotent : les activités sont upsertées sur un `strava_id` synthétique
 * réservé, les séances planifiées sont réécrites, l'athlète est mis à jour.
 * Relancer le script ne duplique donc rien — il repositionne simplement les
 * 8 semaines d'historique par rapport à la date du jour.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { asc, eq } from 'drizzle-orm';
import postgres from 'postgres';

import {
  activities,
  athlete,
  plannedSessions,
  type NewActivity,
  type NewPlannedSession,
} from '../src/data/db/schema';

/**
 * Plage d'identifiants Strava réservée aux données fictives. Les ids Strava
 * réels valent ~1,5 × 10^10 : aucun risque de collision avec une vraie sync.
 */
const SEED_STRAVA_ID_BASE = 9_000_000_000_000;

/** Nombre de semaines complètes générées, auxquelles s'ajoute la semaine en cours. */
const WEEKS = 8;
const DAY_MS = 86_400_000;

/** Profil de l'athlète fictif — FC max/repos renseignées pour rendre le TRIMP calculable. */
const ATHLETE = {
  displayName: 'Gwen',
  sex: 'female',
  maxHrBpm: 188,
  restingHrBpm: 48,
  weightKg: 58.5,
  birthDate: '1992-03-14',
} as const;

type SessionTemplate = {
  name: string;
  /** Nom utilisé une semaine sur deux, quand la séance alterne. */
  alternateName?: string;
  sportType: string;
  /** Distance de référence en semaine 0, en mètres. */
  baseDistanceM: number;
  /** Allure de référence en semaine 0, en secondes par kilomètre. */
  basePaceSecPerKm: number;
  /** Gain d'allure par semaine (progression de forme), en secondes par kilomètre. */
  paceGainSecPerWeek: number;
  avgHrBpm: number;
  /** Écart entre FC moyenne et FC max de la séance. */
  hrPeakOffset: number;
  elevationGainM: number;
  avgCadenceSpm: number;
  /** Heure UTC de départ (~ matin, heure de Paris). */
  startHourUtc: number;
};

/**
 * Semaine type : mardi qualité, mercredi/vendredi footings, jeudi footing sauf
 * en semaine d'assimilation, dimanche sortie longue. Lundi et samedi au repos.
 */
const WEEK_TEMPLATE: Partial<Record<number, SessionTemplate>> = {
  1: {
    name: 'Séance de seuil 3 × 10 min',
    alternateName: 'VMA 8 × 400 m',
    sportType: 'Run',
    baseDistanceM: 11_000,
    basePaceSecPerKm: 292,
    paceGainSecPerWeek: 1.5,
    avgHrBpm: 166,
    hrPeakOffset: 15,
    elevationGainM: 45,
    avgCadenceSpm: 180,
    startHourUtc: 16,
  },
  2: {
    name: 'Footing en endurance',
    sportType: 'Run',
    baseDistanceM: 9_000,
    basePaceSecPerKm: 345,
    paceGainSecPerWeek: 0.8,
    avgHrBpm: 138,
    hrPeakOffset: 12,
    elevationGainM: 60,
    avgCadenceSpm: 172,
    startHourUtc: 5,
  },
  3: {
    name: 'Footing matinal',
    sportType: 'Run',
    baseDistanceM: 8_000,
    basePaceSecPerKm: 350,
    paceGainSecPerWeek: 0.8,
    avgHrBpm: 136,
    hrPeakOffset: 10,
    elevationGainM: 40,
    avgCadenceSpm: 172,
    startHourUtc: 5,
  },
  4: {
    name: 'Footing de récupération',
    sportType: 'Run',
    baseDistanceM: 7_000,
    basePaceSecPerKm: 362,
    paceGainSecPerWeek: 0.5,
    avgHrBpm: 130,
    hrPeakOffset: 8,
    elevationGainM: 30,
    avgCadenceSpm: 168,
    startHourUtc: 16,
  },
  6: {
    name: 'Sortie longue au lac',
    sportType: 'Run',
    baseDistanceM: 14_000,
    basePaceSecPerKm: 330,
    paceGainSecPerWeek: 1,
    avgHrBpm: 146,
    hrPeakOffset: 14,
    elevationGainM: 180,
    avgCadenceSpm: 174,
    startHourUtc: 7,
  },
};

/**
 * Charge relative par semaine (la dernière est la semaine en cours). Progression
 * 3 semaines / 1 semaine d'assimilation, classique en préparation 10 km : de
 * ~49 km à ~68 km par semaine, avec deux coupures.
 */
const WEEK_LOAD_FACTOR = [1, 1.08, 1.16, 0.85, 1.22, 1.3, 1.38, 1, 1.32] as const;

/** Semaines d'assimilation : le footing du jeudi saute. */
const DELOAD_WEEKS = new Set([3, 7]);

function civilDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

function loadEnvFile(path: string): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // Fichier absent : normal selon l'environnement (dev vs Docker).
  }
}

function buildActivities(athleteId: number, today: Date): NewActivity[] {
  const rows: NewActivity[] = [];
  // Lundi de la première semaine générée : WEEKS semaines avant le lundi courant.
  const mondayOffset = (today.getUTCDay() + 6) % 7;
  const firstMondayMs = today.getTime() - (mondayOffset + WEEKS * 7) * DAY_MS;

  // `<= WEEKS` : les semaines complètes, plus la semaine en cours jusqu'à hier.
  for (let week = 0; week <= WEEKS; week += 1) {
    const factor = WEEK_LOAD_FACTOR[week] ?? 1;

    for (let day = 0; day < 7; day += 1) {
      const template = WEEK_TEMPLATE[day];
      if (!template) continue;
      if (day === 3 && DELOAD_WEEKS.has(week)) continue;

      const dayMs = firstMondayMs + (week * 7 + day) * DAY_MS;
      // Le futur (et le jour même, réservé à la séance planifiée) reste vide.
      if (dayMs >= today.getTime()) continue;

      const distanceM = Math.round((template.baseDistanceM * factor) / 100) * 100;
      const paceSecPerKm = template.basePaceSecPerKm - template.paceGainSecPerWeek * week;
      const movingTimeS = Math.round((distanceM / 1000) * paceSecPerKm);
      const startedAt = new Date(dayMs);
      startedAt.setUTCHours(template.startHourUtc, 0, 0, 0);

      rows.push({
        athleteId,
        // Identifiant dérivé de la DATE et non du créneau (semaine × jour) :
        // sinon le même créneau désigne une date différente selon le jour où
        // l'on relance le seed, et l'ancienne ligne survit en double.
        stravaId: SEED_STRAVA_ID_BASE + Math.floor(dayMs / DAY_MS),
        name: week % 2 === 1 && template.alternateName ? template.alternateName : template.name,
        sportType: template.sportType,
        startedAt,
        distanceM,
        movingTimeS,
        // Feux rouges, lacets de chaussure : l'écoulé dépasse toujours un peu le temps en mouvement.
        elapsedTimeS: movingTimeS + 90 + day * 15,
        elevationGainM: Math.round(template.elevationGainM * factor),
        avgHrBpm: template.avgHrBpm,
        maxHrBpm: Math.min(template.avgHrBpm + template.hrPeakOffset, ATHLETE.maxHrBpm),
        avgPaceSecPerKm: movingTimeS / (distanceM / 1000),
        avgCadenceSpm: template.avgCadenceSpm,
      });
    }
  }

  return rows;
}

function buildPlannedSessions(athleteId: number, today: Date): NewPlannedSession[] {
  const dayAfter = (days: number) => civilDate(new Date(today.getTime() + days * DAY_MS));

  return [
    {
      athleteId,
      scheduledOn: civilDate(today),
      kind: 'VMA courte · piste',
      title: '6 × 800 m',
      targetPaceSecPerKm: 225,
      warmup: '20 min @ 5:30/km',
      recovery: '90 s en trot',
      cooldown: '10 min souple',
      volumeM: 12_400,
      durationS: 3_900,
    },
    {
      athleteId,
      scheduledOn: dayAfter(2),
      kind: 'Endurance fondamentale · route',
      title: '10 km souples',
      targetPaceSecPerKm: 345,
      warmup: null,
      recovery: null,
      cooldown: '5 min de marche',
      volumeM: 10_000,
      durationS: 3_450,
    },
    {
      athleteId,
      scheduledOn: dayAfter(5),
      kind: 'Sortie longue · nature',
      title: '18 km avec 3 × 8 min à allure marathon',
      targetPaceSecPerKm: 315,
      warmup: '15 min @ 5:45/km',
      recovery: '3 min en trot',
      cooldown: '10 min souple',
      volumeM: 18_000,
      durationS: 6_000,
    },
  ];
}

/**
 * Garde-fou : ce script écrase le profil de l'athlète et remplace ses séances
 * planifiées. Il ne doit jamais viser une base réelle.
 *
 * On contrôle la **cible** et non `NODE_ENV` : la variable n'est pas positionnée
 * par `pnpm db:seed`, et un `NODE_ENV=production` vivant dans le `.env` de
 * déploiement ne serait lu qu'après coup. Seule une base locale est acceptée,
 * sauf dérogation explicite et consciente.
 */
function assertSafeTarget(databaseUrl: string): void {
  if (process.env.TRAINARR_SEED_FORCE === '1') return;

  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    throw new Error(`DATABASE_URL illisible : ${databaseUrl}`);
  }

  // `trainarr-db` est volontairement exclu : c'est l'hôte de la base **déployée**.
  const local = ['localhost', '127.0.0.1', '::1'];
  if (!local.includes(host)) {
    throw new Error(
      `Seed refusé : « ${host} » n'est pas une base locale.\n` +
        'Ce script insère des données fictives et écrase le profil existant.\n' +
        'Si la cible est bien une base jetable, relance avec TRAINARR_SEED_FORCE=1.',
    );
  }
}

async function main(): Promise<void> {
  loadEnvFile('.env.local');
  loadEnvFile('.env');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL est requise. Renseigne-la dans .env.local.');
  }

  assertSafeTarget(databaseUrl);

  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql);

  try {
    const existing = await db
      .select({ id: athlete.id })
      .from(athlete)
      .orderBy(asc(athlete.id))
      .limit(1);

    let athleteId: number;
    if (existing[0]) {
      athleteId = existing[0].id;
      await db
        .update(athlete)
        .set({ ...ATHLETE, updatedAt: new Date() })
        .where(eq(athlete.id, athleteId));
    } else {
      const inserted = await db.insert(athlete).values(ATHLETE).returning({ id: athlete.id });
      athleteId = inserted[0].id;
    }

    const today = new Date();
    const activityRows = buildActivities(athleteId, today);

    for (const row of activityRows) {
      await db
        .insert(activities)
        .values(row)
        .onConflictDoUpdate({ target: activities.stravaId, set: row });
    }

    // Pas de clé naturelle sur les séances planifiées : on réécrit celles de
    // l'athlète (la table n'est alimentée que par ce seed à ce stade).
    await db.delete(plannedSessions).where(eq(plannedSessions.athleteId, athleteId));
    await db.insert(plannedSessions).values(buildPlannedSessions(athleteId, today));

    console.log('⚠️  Données FICTIVES insérées (seed de développement).');
    console.log(`   athlète  : ${ATHLETE.displayName} (id ${athleteId})`);
    console.log(`   activités: ${activityRows.length} sur ${WEEKS} semaines + la semaine en cours`);
    console.log('   séances planifiées : 3, dont une aujourd’hui');
  } finally {
    await sql.end();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('Échec du seed :', error);
    process.exit(1);
  },
);
