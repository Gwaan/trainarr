import { describe, expect, it } from 'vitest';

import { IntervalsApiError, IntervalsAuthError, type FetchLike } from './client';
import { fetchWellness } from './wellness-client';

/**
 * Ce que ces tests éprouvent.
 *
 * La fixture principale ({@link REAL_SHAPE_RECORD}) reprend la **forme
 * réellement constatée** sur l'API : ses clés, ses types, et jusqu'aux champs
 * hors périmètre qu'elle porte — c'est ce qui rend le test capable de dire que
 * le module les ignore au lieu de s'en étouffer. Le reste du contrat s'éprouve
 * tel quel : l'absence traitée comme une absence, les charges calculées
 * ignorées, et l'échec **bruyant** quand la forme ne correspond pas.
 */

const API_KEY = 'cle-api-de-test-a-ne-jamais-journaliser';
const ATHLETE_ID = 'i123456';

type Call = { url: string; init: RequestInit | undefined };

function stubFetch(response: Response): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const WINDOW = { oldest: '2026-07-31', newest: '2026-08-13' } as const;

/**
 * Un enregistrement à la forme **réellement constatée** sur l'endpoint : mêmes
 * clés, mêmes types, mêmes champs hors périmètre.
 *
 * **Les valeurs, elles, sont inventées** — neutres, plausibles, celles de
 * personne. Les mesures de santé de l'utilisatrice n'entrent pas dans le dépôt,
 * et un test n'a besoin que de la forme.
 *
 * À noter, deux constats qui ne se devinent pas : la montre pousse `hrvSDNN` et
 * **jamais** `hrv` (les deux HRV ne sont pas la même grandeur), et elle ne
 * pousse pas `sleepScore` — d'où son absence ici.
 */
const REAL_SHAPE_RECORD = {
  id: '2026-08-13',
  restingHR: 50,
  sleepSecs: 25_200,
  avgSleepingHR: 54.5,
  weight: 60,
  hrvSDNN: 45.5,
  // Hors périmètre : présents dans la réponse réelle, jamais lus par le module.
  ctl: 40,
  atl: 35,
  ctlLoad: 40,
  atlLoad: 35,
  rampRate: 0,
  sportInfo: [],
  vo2max: null,
  spO2: null,
  steps: null,
  respiration: null,
  bodyFat: null,
  kcalConsumed: null,
  protein: null,
  carbohydrates: null,
  fatTotal: null,
  hydrationVolume: null,
  tempRestingHR: null,
  tempWeight: null,
  updated: '2026-08-13T05:12:00',
} as const;

async function read(
  response: Response,
): Promise<{ days: Awaited<ReturnType<typeof fetchWellness>>; calls: Call[] }> {
  const { fetchImpl, calls } = stubFetch(response);
  const days = await fetchWellness({
    athleteId: ATHLETE_ID,
    apiKey: API_KEY,
    ...WINDOW,
    fetchImpl,
  });
  return { days, calls };
}

describe('fetchWellness — la requête', () => {
  it('interroge la fenêtre demandée sur l’athlète demandé', async () => {
    const { calls } = await read(json([]));

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/api/v1/athlete/i123456/wellness');
    expect(url.searchParams.get('oldest')).toBe('2026-07-31');
    expect(url.searchParams.get('newest')).toBe('2026-08-13');
  });

  it('n’écrit la clé API que dans l’en-tête d’autorisation', async () => {
    const { calls } = await read(json([]));

    expect(calls[0].url).not.toContain(API_KEY);
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('authorization')).toBe(
      `Basic ${Buffer.from(`API_KEY:${API_KEY}`, 'utf8').toString('base64')}`,
    );
  });

  it('traduit un refus d’authentification en erreur typée', async () => {
    await expect(read(json({}, 401))).rejects.toBeInstanceOf(IntervalsAuthError);
  });

  it('lève sur une erreur serveur, avec son code', async () => {
    await expect(read(json({}, 503))).rejects.toMatchObject({
      name: 'IntervalsApiError',
      status: 503,
    });
  });
});

describe('fetchWellness — ce qui est lu', () => {
  it('lit un enregistrement à la forme réelle, jusqu’au SDNN que la montre pousse', async () => {
    const { days } = await read(json([REAL_SHAPE_RECORD]));

    expect(days).toEqual([
      {
        day: '2026-08-13',
        restingHrBpm: 50,
        // La montre en service ne mesure pas de rMSSD : le champ reste vide, et
        // le SDNN ne vient surtout pas le remplir.
        hrvRmssdMs: null,
        hrvSdnnMs: 45.5,
        sleepTimeS: 25_200,
        sleepScore: null,
        avgSleepingHrBpm: 54.5,
        weightKg: 60,
      },
    ]);
  });

  it('lit le rMSSD d’une montre qui pousse `hrv`, dans son propre champ', async () => {
    const { days } = await read(json([{ id: '2026-08-13', hrv: 63.4, sleepScore: 82 }]));

    expect(days[0]).toMatchObject({ hrvRmssdMs: 63.4, hrvSdnnMs: null, sleepScore: 82 });
  });

  it('garde les deux HRV séparées quand une montre pousse les deux', async () => {
    // Ce sont deux grandeurs distinctes : aucune n'écrase l'autre, aucune n'est
    // convertie. C'est l'affichage qui choisit laquelle montrer, et il le dit.
    const { days } = await read(json([{ id: '2026-08-13', hrv: 63.4, hrvSDNN: 45.5 }]));

    expect(days[0]).toMatchObject({ hrvRmssdMs: 63.4, hrvSdnnMs: 45.5 });
  });

  it('accepte aussi la graphie snake_case, au cas où le service la rendrait', async () => {
    const { days } = await read(
      json([{ id: '2026-08-13', resting_hr: 47, sleep_secs: 25_800, sleep_score: 79 }]),
    );

    expect(days[0]).toMatchObject({ restingHrBpm: 47, sleepTimeS: 25_800, sleepScore: 79 });
  });

  it('rend une mesure absente comme absente, jamais comme un zéro', async () => {
    const { days } = await read(json([{ id: '2026-08-13', restingHR: 47 }]));

    expect(days[0]).toEqual({
      day: '2026-08-13',
      restingHrBpm: 47,
      hrvRmssdMs: null,
      hrvSdnnMs: null,
      sleepTimeS: null,
      sleepScore: null,
      avgSleepingHrBpm: null,
      weightKg: null,
    });
  });

  it('rend une journée entièrement muette plutôt que de la faire disparaître', async () => {
    const { days } = await read(json([{ id: '2026-08-13' }]));

    expect(days).toHaveLength(1);
    expect(days[0].restingHrBpm).toBeNull();
  });

  it('ignore les charges calculées par intervals.icu — Trainarr calcule les siennes', async () => {
    const { days } = await read(
      json([{ id: '2026-08-13', restingHR: 47, ctl: 52.4, atl: 61.2, rampRate: 3.1 }]),
    );

    expect(days[0]).not.toHaveProperty('ctl');
    expect(Object.values(days[0])).not.toContain(52.4);
  });

  it('arrondit les mesures entières, dont les colonnes sont entières', async () => {
    const { days } = await read(json([{ id: '2026-08-13', restingHR: 47.4, sleepSecs: 25_800.6 }]));

    expect(days[0].restingHrBpm).toBe(47);
    expect(days[0].sleepTimeS).toBe(25_801);
  });

  it('ne garde que la partie date d’un identifiant horodaté', async () => {
    const { days } = await read(json([{ id: '2026-08-13T00:00:00', restingHR: 47 }]));

    expect(days[0].day).toBe('2026-08-13');
  });

  it('accepte un tableau vide : une fenêtre sans mesure n’est pas une panne', async () => {
    const { days } = await read(json([]));

    expect(days).toEqual([]);
  });
});

describe('fetchWellness — quand le schéma se révèle faux', () => {
  it('lève en nommant les champs en défaut si la forme est inattendue', async () => {
    await expect(read(json({ records: [] }))).rejects.toMatchObject({
      name: 'IntervalsApiError',
    });
  });

  it('lève plutôt que de rendre une liste vide quand aucun enregistrement n’est datable', async () => {
    const failure = read(json([{ restingHR: 47 }, { restingHR: 48 }]));

    await expect(failure).rejects.toBeInstanceOf(IntervalsApiError);
    // Le message doit dire quoi corriger : c'est tout ce qu'on aura au premier
    // appel réel.
    await expect(failure).rejects.toThrow(/id/);
  });
});
