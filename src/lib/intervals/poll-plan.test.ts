import { describe, expect, it } from 'vitest';

import {
  inboxFileName,
  isSafeActivityId,
  MAX_SLEEP_MS,
  missingIntervalsSettings,
  nextPollDelayMs,
  planPoll,
  purgeExpiredWithoutFile,
  shouldLogOnce,
  WITHOUT_FILE_TTL_MS,
  type PollCandidate,
} from './poll-plan';

function activity(id: string, source: string | null = 'UPLOAD'): PollCandidate {
  return { id, source };
}

function context(existing: string[] = [], withoutFile: string[] = []) {
  return {
    existingNames: new Set(existing),
    knownWithoutFile: new Map(withoutFile.map((id) => [id, Date.now()])),
  };
}

describe('inboxFileName', () => {
  it("dérive un nom déterministe de l'identifiant d'activité", () => {
    expect(inboxFileName('i900')).toBe('intervals-i900.fit');
  });
});

describe('isSafeActivityId', () => {
  it('accepte un identifiant intervals.icu', () => {
    expect(isSafeActivityId('i123456789')).toBe(true);
  });

  it('refuse tout ce qui pourrait sortir du répertoire', () => {
    expect(isSafeActivityId('../../etc/passwd')).toBe(false);
    expect(isSafeActivityId('i900/x')).toBe(false);
    expect(isSafeActivityId('')).toBe(false);
    expect(isSafeActivityId('i900\n')).toBe(false);
  });
});

describe('planPoll', () => {
  it('retient une activité inconnue', () => {
    const plan = planPoll([activity('i900')], context());

    expect(plan.toDownload).toEqual([{ activityId: 'i900', fileName: 'intervals-i900.fit' }]);
    expect(plan.invalidIds).toEqual([]);
  });

  it("ignore une activité dont le fichier est déjà rapatrié", () => {
    // `existingNames` fusionne l'inbox, `processed/` et `failed/` : que le
    // fichier attende son tour, ait été ingéré ou ait échoué, il ne doit pas
    // être retéléchargé.
    const plan = planPoll([activity('i900')], context(['intervals-i900.fit']));

    expect(plan.toDownload).toEqual([]);
  });

  it("ne confond pas un fichier en cours d'écriture avec un fichier rapatrié", () => {
    // Un `.part` laissé par un téléchargement interrompu ne porte pas le nom
    // final : l'activité doit être retentée au cycle suivant.
    const plan = planPoll([activity('i900')], context(['intervals-i900.fit.part']));

    expect(plan.toDownload).toEqual([{ activityId: 'i900', fileName: 'intervals-i900.fit' }]);
  });

  it("ignore une activité déjà connue sans fichier — une seule tentative par session", () => {
    const plan = planPoll([activity('i901')], context([], ['i901']));

    expect(plan.toDownload).toEqual([]);
  });

  it('ignore les activités Strava, dont le fichier original est hors service', () => {
    const plan = planPoll([activity('i902', 'STRAVA')], context());

    expect(plan.toDownload).toEqual([]);
  });

  it('écarte un identifiant qui ne compose pas un nom de fichier sûr', () => {
    const plan = planPoll([activity('../evil'), activity('i903')], context());

    expect(plan.invalidIds).toEqual(['../evil']);
    expect(plan.toDownload).toEqual([{ activityId: 'i903', fileName: 'intervals-i903.fit' }]);
  });

  it('ne télécharge pas deux fois une activité listée en double', () => {
    const plan = planPoll([activity('i904'), activity('i904')], context());

    expect(plan.toDownload).toHaveLength(1);
  });

  it("conserve l'ordre de la liste fournie", () => {
    const plan = planPoll([activity('i905'), activity('i906'), activity('i907')], context());

    expect(plan.toDownload.map((item) => item.activityId)).toEqual(['i905', 'i906', 'i907']);
  });
});

describe('nextPollDelayMs', () => {
  it("attend l'intervalle de cycle quand rien ne l'allonge", () => {
    expect(nextPollDelayMs(null, 300)).toBe(300_000);
    expect(nextPollDelayMs(30, 300)).toBe(300_000);
  });

  it('respecte un Retry-After plus long que le cycle', () => {
    expect(nextPollDelayMs(900, 300)).toBe(900_000);
  });

  it("plafonne un Retry-After absurde — une date lointaine ne doit pas rendre setTimeout fou", () => {
    // Un `Retry-After` daté de 2099 : au-delà de 2^31−1 ms, `setTimeout` retombe
    // à 1 ms et la boucle martèlerait l'API.
    const secondsUntil2099 = Math.ceil((Date.parse('2099-01-01T00:00:00Z') - Date.now()) / 1000);

    expect(nextPollDelayMs(secondsUntil2099, 300)).toBe(MAX_SLEEP_MS);
    expect(MAX_SLEEP_MS).toBeLessThan(2 ** 31 - 1);
  });

  it('plafonne aussi un intervalle de cycle démesuré', () => {
    expect(nextPollDelayMs(null, 30 * 24 * 60 * 60)).toBe(MAX_SLEEP_MS);
  });

  it('ignore un Retry-After négatif ou incohérent', () => {
    expect(nextPollDelayMs(-10, 300)).toBe(300_000);
  });
});

describe('purgeExpiredWithoutFile', () => {
  it('conserve une entrée récente', () => {
    const now = Date.parse('2026-08-10T12:00:00Z');
    const withoutFile = new Map([['i900', now - 60_000]]);

    purgeExpiredWithoutFile(withoutFile, now);

    expect([...withoutFile.keys()]).toEqual(['i900']);
  });

  it('oublie une entrée plus vieille que le TTL', () => {
    const now = Date.parse('2026-08-10T12:00:00Z');
    const withoutFile = new Map([['i900', now - WITHOUT_FILE_TTL_MS - 1]]);

    purgeExpiredWithoutFile(withoutFile, now);

    expect(withoutFile.size).toBe(0);
  });

  it("rend l'activité de nouveau éligible au téléchargement", () => {
    // Un 404 peut être transitoire : sur un service qui tourne des mois, une
    // séance réelle ne doit pas être perdue pour de bon.
    const now = Date.parse('2026-08-10T12:00:00Z');
    const withoutFile = new Map([['i900', now - WITHOUT_FILE_TTL_MS - 1]]);

    expect(planPoll([activity('i900')], { existingNames: new Set(), knownWithoutFile: withoutFile })
      .toDownload).toEqual([]);

    purgeExpiredWithoutFile(withoutFile, now);

    expect(
      planPoll([activity('i900')], { existingNames: new Set(), knownWithoutFile: withoutFile })
        .toDownload,
    ).toEqual([{ activityId: 'i900', fileName: 'intervals-i900.fit' }]);
  });
});

describe('shouldLogOnce', () => {
  it('ne laisse passer que la première occurrence', () => {
    const seen = new Set<string>();

    expect(shouldLogOnce(seen, 'i900')).toBe(true);
    expect(shouldLogOnce(seen, 'i900')).toBe(false);
    expect(shouldLogOnce(seen, 'i901')).toBe(true);
  });
});

describe('missingIntervalsSettings', () => {
  it('ne signale rien quand tout est renseigné', () => {
    expect(missingIntervalsSettings({ athleteId: 'i123456', apiKey: 'cle' })).toEqual([]);
  });

  it('nomme précisément la variable manquante', () => {
    expect(missingIntervalsSettings({ athleteId: undefined, apiKey: 'cle' })).toEqual([
      'INTERVALS_ATHLETE_ID',
    ]);
    expect(missingIntervalsSettings({ athleteId: 'i123456', apiKey: undefined })).toEqual([
      'INTERVALS_API_KEY',
    ]);
  });

  it('nomme les deux quand les deux manquent', () => {
    expect(missingIntervalsSettings({ athleteId: undefined, apiKey: undefined })).toEqual([
      'INTERVALS_ATHLETE_ID',
      'INTERVALS_API_KEY',
    ]);
  });
});
