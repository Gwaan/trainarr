import { describe, expect, it } from 'vitest';

import { stepsToIntervalsSyntax } from './intervals-syntax';
import { planSessionStepsSchema, type PlanSessionSteps, type PlanStep } from './schema';

/** Étape neutre : chaque test ne surcharge que ce qu'il éprouve. */
function step(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    role: 'run',
    distanceM: 2_000,
    durationS: null,
    paceMinSecPerKm: null,
    paceMaxSecPerKm: null,
    hrZone: null,
    note: null,
    ...overrides,
  };
}

/** Une séance d'un seul bloc non répété, pour éprouver une étape isolée. */
function serializeOne(overrides: Partial<PlanStep> = {}): string {
  return stepsToIntervalsSyntax([{ repeat: 1, steps: [step(overrides)] }]);
}

describe('stepsToIntervalsSyntax — intitulés', () => {
  it('nomme chaque rôle en français ASCII', () => {
    expect(serializeOne({ role: 'warmup' })).toBe('- Echauffement 2km');
    expect(serializeOne({ role: 'run' })).toBe('- Course 2km');
    expect(serializeOne({ role: 'recover' })).toBe('- Recuperation 2km');
    expect(serializeOne({ role: 'cooldown' })).toBe('- Retour au calme 2km');
  });

  it("prolonge l'intitulé de la note, devant la mesure", () => {
    expect(serializeOne({ role: 'recover', note: 'trot très souple' })).toBe(
      '- Recuperation - trot très souple 2km',
    );
  });

  it('écrase les retours à la ligne d’une note : une étape tient sur une ligne', () => {
    // Le schéma l'impose désormais, mais ce sérialiseur reçoit aussi des `steps`
    // écrits en base avant cette contrainte — une seconde ligne y deviendrait
    // une étape fantôme, et une ligne vide découperait un bloc répété.
    expect(serializeOne({ note: 'ligne1\nligne2\n\n2 km' })).toBe(
      '- Course - ligne1 ligne2 2 km 2km',
    );
  });

  it('retombe sur le seul intitulé quand la note ne porte que des blancs', () => {
    expect(serializeOne({ note: ' \n ' })).toBe('- Course 2km');
  });
});

describe('stepsToIntervalsSyntax — mesures', () => {
  it('écrit les kilomètres ronds en km', () => {
    expect(serializeOne({ distanceM: 2_000 })).toBe('- Course 2km');
    expect(serializeOne({ distanceM: 12_000 })).toBe('- Course 12km');
  });

  it("écrit toute autre distance en mètres — jamais `m`, qui vaut minutes", () => {
    expect(serializeOne({ distanceM: 400 })).toBe('- Course 400mtr');
    expect(serializeOne({ distanceM: 1_500 })).toBe('- Course 1500mtr');
    // Un mètre décimal n'existe pas dans la syntaxe : arrondi, pas de troncature.
    expect(serializeOne({ distanceM: 400.6 })).toBe('- Course 401mtr');
  });

  it('écrit les durées en minutes et secondes', () => {
    const duration = (durationS: number): string => serializeOne({ distanceM: null, durationS });

    expect(duration(600)).toBe('- Course 10m');
    expect(duration(45)).toBe('- Course 45s');
    expect(duration(90)).toBe('- Course 1m30s');
    expect(duration(3_600)).toBe('- Course 60m');
  });
});

describe('stepsToIntervalsSyntax — cibles', () => {
  it('rend une allure unique en valeur absolue', () => {
    expect(serializeOne({ paceMinSecPerKm: 270, paceMaxSecPerKm: 270 })).toBe(
      '- Course 2km 4:30/km Pace',
    );
  });

  it('rend une fourchette bornée, la plus rapide en premier', () => {
    expect(serializeOne({ paceMinSecPerKm: 265, paceMaxSecPerKm: 275 })).toBe(
      '- Course 2km 4:25-4:35/km Pace',
    );
  });

  /**
   * ## Forme **vérifiée empiriquement le 12/08/2026 sur le compte réel**
   *
   * 29 events de test poussés puis relus dans leur `workout_doc.steps[].hr` :
   * `65-79% HR` y arrive en `{start:65, end:79, units:"%hr"}`, soit un
   * pourcentage de la FC max du compte. Toutes les formes en bpm absolus
   * (`120-145 bpm HR` compris, qui sortait d'ici avant ce correctif) n'y
   * produisent **aucune** cible : du texte mort, une montre sans plage.
   *
   * Le pourcentage émis est calculé sur la FC max **distante**, pas sur celle du
   * profil : c'est ce qui fait que 120–145 bpm restent 120–145 bpm au poignet,
   * quelle que soit la valeur configurée en face.
   */
  it('exprime la cible en pourcentage de la FC max distante', () => {
    const endurance: PlanSessionSteps = [{ repeat: 1, steps: [step({ hrZone: 2 })] }];

    // La FC max du compte réel (205) diverge de la vraie (184) : les 120–145 bpm
    // prescrits sur 184 valent 59–71 % de 205.
    expect(
      stepsToIntervalsSyntax(endurance, { profileMaxHrBpm: 184, intervalsMaxHrBpm: 205 }),
    ).toBe('- Course 2km 59-71% HR');

    // Références confondues : le pourcentage redonne exactement le créneau
    // prescrit (65–79 % de FC max, cf. `lib/metrics/hr-targets`).
    expect(
      stepsToIntervalsSyntax(endurance, { profileMaxHrBpm: 184, intervalsMaxHrBpm: 184 }),
    ).toBe('- Course 2km 65-79% HR');
  });

  /**
   * ## Le piège du suffixe
   *
   * `65-79% MaxHR`, `65-79% HRmax` et `65-79% Max HR` sont les trois façons
   * « évidentes » d'écrire un pourcentage de FC max — et les trois parsent en
   * **puissance** (`power {units:"%ftp"}`), mesuré le 12/08/2026. Une coureuse
   * n'a pas de capteur de puissance : la cible serait silencieusement fausse, et
   * sur une grandeur qu'elle ne mesure même pas.
   *
   * Seuls ` HR` (pourcentage de FC max) et ` LTHR` (pourcentage du seuil)
   * atteignent le domaine cardiaque. Ce test fige le fait que rien d'autre ne
   * sort d'ici.
   */
  it('ne suffixe jamais autrement que par ` HR` — `MaxHR` partirait en puissance', () => {
    const line = stepsToIntervalsSyntax([{ repeat: 1, steps: [step({ hrZone: 2 })] }], {
      profileMaxHrBpm: 184,
      intervalsMaxHrBpm: 205,
    });

    expect(line).toMatch(/ \d+-\d+% HR$/);
    for (const trap of ['MaxHR', 'HRmax', 'Max HR', 'LTHR', 'bpm']) {
      expect(line, `suffixe interdit : ${trap}`).not.toContain(trap);
    }
  });

  it('ne pousse jamais un numéro de zone, qui référencerait les zones du compte', () => {
    const line = stepsToIntervalsSyntax([{ repeat: 1, steps: [step({ hrZone: 2 })] }], {
      profileMaxHrBpm: 184,
      intervalsMaxHrBpm: 205,
    });
    expect(line).not.toContain('Z2');
  });

  it("n'émet aucune cible cardiaque quand elle n'est pas exprimable", () => {
    const steps: PlanSessionSteps = [{ repeat: 1, steps: [step({ hrZone: 2 })] }];

    // Aucune référence du tout.
    expect(stepsToIntervalsSyntax(steps)).toBe('- Course 2km');
    // FC max distante illisible (API en erreur, champ absent) : le repli.
    expect(
      stepsToIntervalsSyntax(steps, { profileMaxHrBpm: 184, intervalsMaxHrBpm: null }),
    ).toBe('- Course 2km');
    // FC max distante aberrante : rien n'est calculé, rien n'est deviné.
    expect(stepsToIntervalsSyntax(steps, { profileMaxHrBpm: 184, intervalsMaxHrBpm: 40 })).toBe(
      '- Course 2km',
    );
    // FC max du profil absente : plus rien ne prescrit, le dénominateur seul ne
    // suffit pas.
    expect(
      stepsToIntervalsSyntax(steps, { profileMaxHrBpm: null, intervalsMaxHrBpm: 205 }),
    ).toBe('- Course 2km');
    // Zone sans créneau de prescription déclaré (cf. `lib/metrics/hr-targets`).
    expect(
      stepsToIntervalsSyntax([{ repeat: 1, steps: [step({ hrZone: 4 })] }], {
        profileMaxHrBpm: 184,
        intervalsMaxHrBpm: 205,
      }),
    ).toBe('- Course 2km');
  });

  it('retombe sur la cible d’allure, qui elle ne dépend d’aucune référence distante', () => {
    // Le repli qui compte à la montre : sans FC max distante, l'étape qui porte
    // une allure la garde — c'est la forme dont on sait qu'elle fonctionne.
    const withPace: PlanSessionSteps = [
      { repeat: 1, steps: [step({ paceMinSecPerKm: 265, paceMaxSecPerKm: 275, hrZone: 2 })] },
    ];

    expect(
      stepsToIntervalsSyntax(withPace, { profileMaxHrBpm: 184, intervalsMaxHrBpm: null }),
    ).toBe('- Course 2km 4:25-4:35/km Pace');
  });

  it('laisse la cible d’allure intacte quand les FC max sont connues', () => {
    // Les FC max ne déplacent **que** les étapes ciblées en zone : la qualité
    // reste prescrite en allure de bout en bout.
    expect(
      stepsToIntervalsSyntax(
        [{ repeat: 1, steps: [step({ paceMinSecPerKm: 265, paceMaxSecPerKm: 275 })] }],
        { profileMaxHrBpm: 184, intervalsMaxHrBpm: 205 },
      ),
    ).toBe('- Course 2km 4:25-4:35/km Pace');
  });

  it("n'invente aucune intensité quand l'étape n'en porte pas", () => {
    expect(serializeOne({ distanceM: null, durationS: 2_700 })).toBe('- Course 45m');
  });
});

describe('stepsToIntervalsSyntax — blocs', () => {
  it('rend un bloc non répété à plat, sans `1x` ni ligne vide', () => {
    const steps: PlanSessionSteps = [
      {
        repeat: 1,
        steps: [
          step({ role: 'warmup', distanceM: null, durationS: 900, hrZone: 2 }),
          step({ role: 'cooldown', distanceM: null, durationS: 600, hrZone: 1 }),
        ],
      },
    ];

    // Sans référence cardiaque, les étapes en zone sortent sur leur seule
    // mesure : ce test éprouve la mise en page des blocs, pas les cibles.
    expect(stepsToIntervalsSyntax(steps)).toBe(
      ['- Echauffement 15m', '- Retour au calme 10m'].join('\n'),
    );
  });

  it('encadre un bloc répété de lignes vides', () => {
    const steps: PlanSessionSteps = [
      { repeat: 1, steps: [step({ role: 'warmup', distanceM: null, durationS: 900, hrZone: 2 })] },
      {
        repeat: 3,
        steps: [
          step({ distanceM: 800, paceMinSecPerKm: 230, paceMaxSecPerKm: 240 }),
          step({ role: 'recover', distanceM: 400, note: 'trot' }),
        ],
      },
      {
        repeat: 1,
        steps: [step({ role: 'cooldown', distanceM: null, durationS: 600, hrZone: 1 })],
      },
    ];

    expect(
      stepsToIntervalsSyntax(steps, { profileMaxHrBpm: 184, intervalsMaxHrBpm: 205 }),
    ).toBe(
      [
        '- Echauffement 15m 59-71% HR',
        '',
        '3x',
        '- Course 800mtr 3:50-4:00/km Pace',
        '- Recuperation - trot 400mtr',
        '',
        // Z1 n'a pas de créneau de prescription déclaré : aucune cible, plutôt
        // qu'un `Z1 HR` qui référencerait les zones du compte distant.
        '- Retour au calme 10m',
      ].join('\n'),
    );
  });

  it('ne commence ni ne termine par une ligne vide quand un bloc répété est aux bords', () => {
    const steps: PlanSessionSteps = [
      {
        repeat: 4,
        steps: [step({ distanceM: 1_000, paceMinSecPerKm: 250, paceMaxSecPerKm: 250 })],
      },
    ];

    expect(stepsToIntervalsSyntax(steps)).toBe(['4x', '- Course 1km 4:10/km Pace'].join('\n'));
  });

  it('sépare deux blocs répétés consécutifs par une seule ligne vide', () => {
    const steps: PlanSessionSteps = [
      { repeat: 2, steps: [step({ distanceM: 1_000 })] },
      { repeat: 3, steps: [step({ distanceM: 400 })] },
    ];

    expect(stepsToIntervalsSyntax(steps)).toBe(
      ['2x', '- Course 1km', '', '3x', '- Course 400mtr'].join('\n'),
    );
  });
});

describe('stepsToIntervalsSyntax — séance complète', () => {
  it('sérialise un fractionné du monde réel', () => {
    const steps: PlanSessionSteps = [
      {
        repeat: 1,
        steps: [
          step({
            role: 'warmup',
            distanceM: null,
            durationS: 900,
            hrZone: 2,
            note: 'très souple',
          }),
        ],
      },
      {
        repeat: 6,
        steps: [
          step({ distanceM: 800, paceMinSecPerKm: 235, paceMaxSecPerKm: 245 }),
          step({ role: 'recover', distanceM: null, durationS: 90, note: 'trot' }),
        ],
      },
      {
        repeat: 1,
        steps: [step({ role: 'cooldown', distanceM: null, durationS: 600, hrZone: 1 })],
      },
    ];

    // La séance est bien valide au regard du schéma : la sérialisation ne
    // s'éprouve que sur des entrées que le DAL accepterait d'écrire.
    expect(planSessionStepsSchema.safeParse(steps).success).toBe(true);

    expect(
      stepsToIntervalsSyntax(steps, { profileMaxHrBpm: 184, intervalsMaxHrBpm: 205 }),
    ).toBe(
      [
        '- Echauffement - très souple 15m 59-71% HR',
        '',
        '6x',
        '- Course 800mtr 3:55-4:05/km Pace',
        '- Recuperation - trot 1m30s',
        '',
        '- Retour au calme 10m',
      ].join('\n'),
    );
  });
});
