import { describe, expect, it } from 'vitest';

import type {
  PlanContextDto,
  TrainingSnapshotDto,
  WellnessContextDayDto,
} from '@/data/coach-context';
import type { PlanSessionSteps, PlanStep, PlanStepRole } from '@/lib/plan-steps/schema';

import {
  formatCivilDate,
  formatDaysAgo,
  formatDistanceKm,
  formatDuration,
  formatIsoDay,
  formatNumber,
  formatPace,
  formatPaceRange,
  formatPlanContext,
  formatPlanSteps,
  formatSignedPercent,
  formatTrainingSnapshot,
  formatWellnessContext,
} from './format';

/** Une étape complète : le contrat porte ses sept clés, `null` pour absent. */
function step(role: PlanStepRole, overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    role,
    distanceM: null,
    durationS: null,
    paceMinSecPerKm: null,
    paceMaxSecPerKm: null,
    hrZone: null,
    note: null,
    ...overrides,
  };
}

describe('formatNumber', () => {
  it('arrondit et rend la virgule décimale française', () => {
    expect(formatNumber(52.34, 1)).toBe('52,3');
    expect(formatNumber(52.36, 1)).toBe('52,4');
    expect(formatNumber(-8.4)).toBe('-8');
  });
});

describe('formatPace', () => {
  it('rend `m:ss/km`, secondes toujours sur deux chiffres', () => {
    expect(formatPace(258)).toBe('4:18/km');
    expect(formatPace(305)).toBe('5:05/km');
    expect(formatPace(300.4)).toBe('5:00/km');
  });
});

describe('formatDistanceKm', () => {
  it('rend des kilomètres au dixième', () => {
    expect(formatDistanceKm(18_240)).toBe('18,2 km');
    expect(formatDistanceKm(1_609.34)).toBe('1,6 km');
  });
});

describe('formatDuration', () => {
  it('choisit son unité selon la durée', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(2_880)).toBe('48 min');
    expect(formatDuration(3_900)).toBe('1 h 05');
  });
});

describe('formatIsoDay', () => {
  it('nomme les jours ISO, lundi = 1', () => {
    expect(formatIsoDay(1)).toBe('lundi');
    expect(formatIsoDay(7)).toBe('dimanche');
  });

  it('ne prétend pas nommer un jour hors bornes', () => {
    expect(formatIsoDay(9)).toBe('jour 9');
  });
});

describe('formatCivilDate', () => {
  it('rend la date en toutes lettres, sans décalage de fuseau', () => {
    expect(formatCivilDate('2026-08-17')).toBe('lundi 17 août 2026');
    expect(formatCivilDate('2026-01-01')).toBe('jeudi 1 janvier 2026');
  });
});

describe('formatSignedPercent', () => {
  it('porte toujours le signe : il est le sens de la mesure', () => {
    expect(formatSignedPercent(4.21)).toBe('+4,2 %');
    expect(formatSignedPercent(-1.5)).toBe('-1,5 %');
  });
});

describe('formatDaysAgo', () => {
  it('situe la sortie dans le passé', () => {
    expect(formatDaysAgo('2026-08-11', '2026-08-11')).toBe("aujourd'hui");
    expect(formatDaysAgo('2026-08-10', '2026-08-11')).toBe('hier');
    expect(formatDaysAgo('2026-07-30', '2026-08-11')).toBe('il y a 12 jours');
  });
});

describe('formatPlanSteps', () => {
  it('rend une séance de qualité sur une ligne, répétitions comprises', () => {
    const text = formatPlanSteps([
      { repeat: 1, steps: [step('warmup', { durationS: 900, hrZone: 2 })] },
      {
        repeat: 6,
        steps: [
          step('run', { distanceM: 400, paceMinSecPerKm: 220, paceMaxSecPerKm: 220 }),
          step('recover', { durationS: 90 }),
        ],
      },
      { repeat: 1, steps: [step('cooldown', { durationS: 600 })] },
    ]);

    expect(text).toBe(
      'échauffement 900 s @ Z2 + 6 × (400 m @ 3:40/km + récup 90 s) + retour au calme 600 s',
    );
  });

  it('rend une fourchette d’allure sans répéter l’unité', () => {
    const text = formatPlanSteps([
      { repeat: 3, steps: [step('run', { distanceM: 2_000, paceMinSecPerKm: 240, paceMaxSecPerKm: 250 })] },
    ]);

    expect(text).toBe('3 × (2000 m @ 4:00–4:10/km)');
  });

  it('rend les mesures dans les unités du contrat : mètres et secondes, sans virgule', () => {
    // Le modèle relit ce déroulé pour réécrire la séance : `2,0 km` recopié tel
    // quel dans `steps` produirait une sortie hors schéma.
    expect(formatPlanSteps([{ repeat: 1, steps: [step('recover', { durationS: 45 })] }])).toBe(
      'récup 45 s',
    );
    expect(formatPlanSteps([{ repeat: 1, steps: [step('recover', { durationS: 90 })] }])).toBe(
      'récup 90 s',
    );
    expect(formatPlanSteps([{ repeat: 1, steps: [step('run', { durationS: 150 })] }])).toBe('150 s');
    expect(formatPlanSteps([{ repeat: 1, steps: [step('run', { distanceM: 10_000 })] }])).toBe(
      '10000 m',
    );
  });

  it('n’annonce aucune cible quand l’étape n’en porte pas', () => {
    expect(formatPlanSteps([{ repeat: 1, steps: [step('run', { distanceM: 400 })] }])).toBe('400 m');
  });
});

const SNAPSHOT: TrainingSnapshotDto = {
  today: '2026-08-11',
  profile: { ageYears: 36, sex: 'female', maxHrBpm: 188, restingHrBpm: 48, weightKg: 62 },
  fitness: { ctl: 52.4, atl: 61.2, tsb: -8.8 },
  vo2max: 48.62,
  weeks: [
    { startsOn: '2026-07-20', distanceKm: 42.15, movingTimeS: 13_500, sessions: 4 },
    { startsOn: '2026-07-27', distanceKm: 0, movingTimeS: 0, sessions: 0 },
  ],
  longestSessionKm30d: 18.4,
  recentAvgPaceSecPerKm: 324,
};

describe('formatTrainingSnapshot', () => {
  it('rend les chiffres clés, profil compris', () => {
    const text = formatTrainingSnapshot(SNAPSHOT);

    expect(text).toContain('36 ans');
    expect(text).toContain('FC max 188 bpm');
    expect(text).toContain('CTL 52 · ATL 61 · TSB -9');
    expect(text).toContain('VO2max estimée : 48,6');
    expect(text).toContain('semaine du 2026-07-20 : 42,1 km · 3 h 45 · 4 séances');
    expect(text).toContain('semaine du 2026-07-27 : 0,0 km · 0 s · 0 séance');
    expect(text).toContain('5:24/km');
  });

  it("dit ce qui n'est pas calculable au lieu de l'omettre ou de l'inventer", () => {
    const text = formatTrainingSnapshot({
      today: '2026-08-11',
      profile: {},
      fitness: null,
      vo2max: null,
      longestSessionKm30d: null,
      weeks: [],
      recentAvgPaceSecPerKm: null,
    });

    expect(text).toContain('Profil : non renseigné.');
    expect(text).toContain('Charge (CTL/ATL/TSB) : non calculable');
    expect(text).toContain('VO2max estimée : non calculable.');
    expect(text).toContain('Allure de référence : inconnue');
    expect(text).not.toContain('null');
  });

  it('ne mentionne pas un champ de profil absent', () => {
    const text = formatTrainingSnapshot({ ...SNAPSHOT, profile: { maxHrBpm: 188 } });

    expect(text).toBe(
      [
        'Profil : FC max 188 bpm.',
        'Charge : CTL 52 · ATL 61 · TSB -9.',
        'VO2max estimée : 48,6.',
        'Volume de course des dernières semaines :',
        '- semaine du 2026-07-20 : 42,1 km · 3 h 45 · 4 séances',
        '- semaine du 2026-07-27 : 0,0 km · 0 s · 0 séance',
        'Allure moyenne des dernières sorties : 5:24/km.',
      ].join('\n'),
    );
  });

  /**
   * L'ancre parasite diagnostiquée en production : le modèle calait les allures
   * d'un plan sur cette moyenne d'entraînement lente au lieu d'appliquer la
   * table VDOT. Les prompts de plan qui portent une table la retirent donc.
   */
  it('retire l’allure moyenne des dernières sorties à la demande', () => {
    const text = formatTrainingSnapshot(SNAPSHOT, { withRecentPace: false });

    expect(text).not.toContain('Allure moyenne des dernières sorties');
    // Et rien d'autre ne bouge : la charge et les volumes calent les séances.
    expect(text).toContain('CTL 52 · ATL 61 · TSB -9');
    expect(text).toContain('semaine du 2026-07-20 : 42,1 km · 3 h 45 · 4 séances');
  });

  it('retire aussi la ligne quand il n’y a pas d’allure connue', () => {
    // Sans cela, un contexte censé n'en rien dire annoncerait quand même une
    // « allure de référence », inconnue mais présente.
    const text = formatTrainingSnapshot(
      { ...SNAPSHOT, recentAvgPaceSecPerKm: null },
      { withRecentPace: false },
    );

    expect(text).not.toContain('Allure de référence');
  });

  it('garde la ligne par défaut : le feedback la commente', () => {
    expect(formatTrainingSnapshot(SNAPSHOT, {})).toContain(
      'Allure moyenne des dernières sorties : 5:24/km.',
    );
  });

  /**
   * Le bloc partagé, figé au caractère près.
   *
   * Quatre services le lisent — génération de plan, révision, feedback, test
   * chronométré — et leurs prompts sont éprouvés en production. Le contexte de
   * plan du chat est donc un bloc **séparé** ({@link formatPlanContext}) : le
   * verser ici rendrait le prompt de génération circulaire (le plan décrivant le
   * plan) et ferait bouger les quatre autres d'un coup. Ce test est la barrière.
   */
  it('reste inchangé : quatre prompts éprouvés en dépendent', () => {
    expect(formatTrainingSnapshot(SNAPSHOT)).toBe(
      [
        'Profil : 36 ans · femme · FC max 188 bpm · FC repos 48 bpm · 62,0 kg.',
        'Charge : CTL 52 · ATL 61 · TSB -9.',
        'VO2max estimée : 48,6.',
        'Volume de course des dernières semaines :',
        '- semaine du 2026-07-20 : 42,1 km · 3 h 45 · 4 séances',
        '- semaine du 2026-07-27 : 0,0 km · 0 s · 0 séance',
        'Allure moyenne des dernières sorties : 5:24/km.',
      ].join('\n'),
    );
    // Aucune séance ne s'y est glissée : c'est l'autre moitié de l'invariant.
    expect(formatTrainingSnapshot(SNAPSHOT)).not.toContain('Séances');
  });
});

/** Le déroulé d'une VMA courte, **brut** — c'est ce que le DAL rend désormais. */
const INTERVAL_STEPS: PlanSessionSteps = [
  {
    repeat: 1,
    steps: [
      {
        role: 'warmup',
        distanceM: null,
        durationS: 900,
        paceMinSecPerKm: null,
        paceMaxSecPerKm: null,
        hrZone: 2,
        note: null,
      },
    ],
  },
  {
    repeat: 6,
    steps: [
      {
        role: 'run',
        distanceM: 800,
        durationS: null,
        paceMinSecPerKm: 220,
        paceMaxSecPerKm: 220,
        hrZone: null,
        note: null,
      },
      {
        role: 'recover',
        distanceM: null,
        durationS: 90,
        paceMinSecPerKm: null,
        paceMaxSecPerKm: null,
        hrZone: null,
        note: null,
      },
    ],
  },
  {
    repeat: 1,
    steps: [
      {
        role: 'cooldown',
        distanceM: null,
        durationS: 600,
        paceMinSecPerKm: null,
        paceMaxSecPerKm: null,
        hrZone: null,
        note: null,
      },
    ],
  },
];

const PLAN_CONTEXT: PlanContextDto = {
  hasPlan: true,
  today: '2026-08-11',
  goal: { intent: 'race', note: 'Semi de Lyon en 1 h 45' },
  raceDate: '2026-09-27',
  endsOn: '2026-09-27',
  upcoming: [
    {
      date: '2026-08-09',
      kind: 'Sortie longue',
      title: 'Sortie longue 14 km',
      steps: null,
      volumeM: 14_000,
      durationS: null,
      done: false,
    },
    {
      date: '2026-08-11',
      kind: 'Endurance fondamentale',
      title: 'Footing 8 km',
      steps: null,
      volumeM: 8_000,
      durationS: null,
      done: true,
    },
    {
      date: '2026-08-13',
      kind: 'VMA courte · piste',
      title: '6 × 800 m',
      steps: INTERVAL_STEPS,
      volumeM: 11_000,
      durationS: null,
      done: false,
    },
    {
      date: '2026-08-16',
      kind: 'Sortie longue',
      title: 'Sortie longue 18 km',
      steps: null,
      volumeM: null,
      durationS: 6_300,
      done: false,
    },
  ],
};

describe('formatPlanContext', () => {
  /**
   * Sans plan, le bloc **dit** qu'il n'y en a pas. Une chaîne vide serait un trou
   * de plus dans le contexte — exactement la cause du bug qu'on répare : un petit
   * modèle comble un trou, il ne s'y arrête pas.
   */
  it("dit qu'aucun plan n'est actif au lieu de ne rien rendre", () => {
    const text = formatPlanContext({ hasPlan: false });

    expect(text).not.toBe('');
    expect(text).toContain('Aucun plan actif.');
    expect(text).toContain("Aucune séance n'est planifiée.");
  });

  it('porte objectif, note, jour J et échéance', () => {
    const text = formatPlanContext(PLAN_CONTEXT);

    expect(text).toContain('Plan actif — objectif : préparer une course.');
    expect(text).toContain("Note de l'athlète sur son objectif : « Semi de Lyon en 1 h 45 ».");
    expect(text).toContain('Course le dimanche 27 septembre 2026.');
    expect(text).toContain('Dernier jour du plan : dimanche 27 septembre 2026.');
  });

  it('nomme le jour de la semaine en plus de la date : le modèle raisonne mal sur une date nue', () => {
    const text = formatPlanContext(PLAN_CONTEXT);

    expect(text).toContain('mardi 11 août 2026');
    expect(text).toContain('jeudi 13 août 2026');
    expect(text).toContain('dimanche 16 août 2026');
    // Et jamais la date nue seule, qu'un modèle ne sait pas situer dans la semaine.
    expect(text).not.toContain('2026-08-13');
  });

  /**
   * Trois états, et pas deux : une séance dont le jour est passé et que rien n'a
   * réalisée n'est ni faite ni à faire. La confondre avec l'un ou l'autre ferait
   * dire au coach une chose fausse.
   */
  it('distingue le fait, le passé non couru et ce qui vient', () => {
    const text = formatPlanContext(PLAN_CONTEXT);

    expect(text).toContain('dimanche 9 août 2026 — passée, non courue');
    expect(text).toContain('mardi 11 août 2026 — déjà courue');
    expect(text).toContain('jeudi 13 août 2026 — à venir');
  });

  it('énonce le fait sans le juger : ni « manquée », ni « sautée », ni « ratée »', () => {
    const text = formatPlanContext(PLAN_CONTEXT);

    expect(text).not.toContain('manquée');
    expect(text).not.toContain('sautée');
    expect(text).not.toContain('ratée');
  });

  it("situe l'état par rapport au jour porté par le contexte, pas à l'horloge", () => {
    // Le même dimanche, lu depuis le samedi qui le précède : il est à venir.
    const text = formatPlanContext({ ...PLAN_CONTEXT, today: '2026-08-08' });

    expect(text).toContain('dimanche 9 août 2026 — à venir');
    expect(text).not.toContain('passée, non courue');
  });

  it('rend le déroulé brut du DAL, et le volume ou la durée à défaut', () => {
    const text = formatPlanContext(PLAN_CONTEXT);

    // La mise en forme du déroulé se fait ici : le DTO porte les blocs bruts.
    expect(text).toContain(
      'VMA courte · piste : 6 × 800 m · 11,0 km · échauffement 900 s @ Z2 + 6 × (800 m @ 3:40/km + récup 90 s) + retour au calme 600 s',
    );
    // Sans volume déclaré, c'est la durée qui situe la séance — jamais « 0 km ».
    expect(text).toContain('Sortie longue : Sortie longue 18 km · 1 h 45');
    expect(text).not.toContain('0,0 km');
  });

  it('annonce que la liste est close : au-delà, le coach ne sait rien', () => {
    expect(formatPlanContext(PLAN_CONTEXT)).toContain(
      'cette liste est complète, tu ne connais aucune autre séance',
    );
  });

  it('dit la fenêtre vide d’un plan actif sans séance à venir', () => {
    const text = formatPlanContext({ ...PLAN_CONTEXT, upcoming: [] });

    expect(text).toContain('Plan actif — objectif : préparer une course.');
    expect(text).toContain('Aucune séance planifiée ces jours-ci.');
  });

  it('nomme les quatre intentions en toutes lettres, jamais leur code', () => {
    const labels = (['race', 'faster', 'weight_loss', 'return'] as const).map((intent) =>
      formatPlanContext({ ...PLAN_CONTEXT, goal: { intent, note: null } }).split('\n')[0],
    );

    expect(labels).toEqual([
      'Plan actif — objectif : préparer une course.',
      'Plan actif — objectif : courir plus vite.',
      'Plan actif — objectif : perdre du poids.',
      'Plan actif — objectif : reprendre la course.',
    ]);
  });

  it('tait la note et le jour J quand ils sont absents', () => {
    const text = formatPlanContext({
      ...PLAN_CONTEXT,
      goal: { intent: 'faster', note: null },
      raceDate: null,
    });

    expect(text).not.toContain("Note de l'athlète");
    expect(text).not.toContain('Course le');
    expect(text).not.toContain('null');
  });
});

describe('formatPaceRange', () => {
  it('ne répète pas l’unité sur une plage, et la tait sur une allure unique', () => {
    expect(formatPaceRange({ minSecPerKm: 300, maxSecPerKm: 320 })).toBe('5:00–5:20/km');
    expect(formatPaceRange({ minSecPerKm: 300, maxSecPerKm: 300 })).toBe('5:00/km');
  });
});


/** Une journée de relevé, dont chaque test ne renseigne que ce qu'il éprouve. */
function wellnessDay(
  date: string,
  measures: Partial<WellnessContextDayDto> = {},
): WellnessContextDayDto {
  return {
    date,
    restingHrBpm: null,
    hrvRmssdMs: null,
    hrvSdnnMs: null,
    sleepTimeS: null,
    sleepScore: null,
    weightKg: null,
    ...measures,
  };
}

describe('formatWellnessContext', () => {
  it('date chaque relevé en toutes lettres et écrit chaque mesure avec son unité', () => {
    const text = formatWellnessContext({
      today: '2026-08-13',
      days: [
        wellnessDay('2026-08-13', {
          restingHrBpm: 47,
          hrvRmssdMs: 63.4,
          sleepTimeS: 25_800,
          sleepScore: 82,
          weightKg: 61.4,
        }),
      ],
    });

    expect(text).toContain('jeudi 13 août 2026');
    expect(text).toContain('FC de repos 47 bpm');
    expect(text).toContain('HRV (rMSSD) 63 ms');
    expect(text).toContain('sommeil 7 h 10');
    expect(text).toContain('score de sommeil 82/100');
    expect(text).toContain('poids 61,4 kg');
  });

  it('n’écrit pas les mesures qu’une journée ne porte pas', () => {
    const text = formatWellnessContext({
      today: '2026-08-13',
      days: [wellnessDay('2026-08-13', { restingHrBpm: 47 })],
    });

    expect(text).toContain('FC de repos 47 bpm');
    expect(text).not.toContain('HRV (rMSSD) null');
    expect(text).not.toContain('null');
  });

  it('nomme, une fois, les mesures jamais prises sur la période', () => {
    // Sans cette ligne, une HRV absente de toutes les journées se lit comme un
    // oubli de formatage — et un modèle qui veut bien faire en invente une.
    const text = formatWellnessContext({
      today: '2026-08-13',
      days: [
        wellnessDay('2026-08-13', { restingHrBpm: 47, sleepTimeS: 25_800 }),
        wellnessDay('2026-08-12', { restingHrBpm: 48, sleepTimeS: 24_000 }),
      ],
    });

    // « HRV » sans variante ici : aucune n'a été mesurée, en annoncer une
    // laisserait croire qu'on sait laquelle la montre aurait poussée.
    expect(text).toContain('Jamais mesuré sur cette période : HRV, score de sommeil, poids.');
  });

  it('écrit la variante de HRV à côté de la valeur, jamais « HRV » tout court', () => {
    // Sans elle, un modèle compare un SDNN de 45 ms à des repères de rMSSD —
    // deux grandeurs différentes, sans conversion entre elles.
    const sdnn = formatWellnessContext({
      today: '2026-08-13',
      days: [wellnessDay('2026-08-13', { hrvSdnnMs: 45.5 })],
    });
    const rmssd = formatWellnessContext({
      today: '2026-08-13',
      days: [wellnessDay('2026-08-13', { hrvRmssdMs: 63.4 })],
    });

    expect(sdnn).toContain('HRV (SDNN) 46 ms');
    expect(rmssd).toContain('HRV (rMSSD) 63 ms');
  });

  it('dit la provenance des mesures, et borne ce que le modèle connaît', () => {
    const text = formatWellnessContext({
      today: '2026-08-13',
      days: [wellnessDay('2026-08-13', { restingHrBpm: 47 })],
    });

    expect(text).toContain('Trainarr ne les calcule pas');
    expect(text).toContain('cette liste est complète');
  });

  it('énonce l’absence totale plutôt que de rendre un bloc vide', () => {
    const text = formatWellnessContext({ today: '2026-08-13', days: [] });

    expect(text).toContain('Aucune mesure de bien-être');
    expect(text).toContain('ne les commente pas');
  });
});
