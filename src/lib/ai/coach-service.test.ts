import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoachMessageDto } from '@/data/coach-chat';
import type { TrainingSnapshotDto } from '@/data/coach-context';

import {
  COACH_CONTEXT_TURNS,
  COACH_QUESTION_LIMITS,
  InvalidCoachQuestionError,
  answerCoachQuestion,
} from './coach-service';
import { AiResponseError, AiUnavailableError } from './errors';

// Les modules serveur commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

const { chatCompletion } = vi.hoisted(() => ({ chatCompletion: vi.fn() }));
const { dal } = vi.hoisted(() => ({
  dal: {
    getTrainingSnapshot: vi.fn(),
    listCoachMessages: vi.fn(),
    appendCoachExchange: vi.fn(),
  },
}));

vi.mock('./client', () => ({ chatCompletion }));
vi.mock('@/data/coach-context', () => ({ getTrainingSnapshot: dal.getTrainingSnapshot }));
vi.mock('@/data/coach-chat', () => ({
  listCoachMessages: dal.listCoachMessages,
  appendCoachExchange: dal.appendCoachExchange,
}));

const SNAPSHOT: TrainingSnapshotDto = {
  today: '2026-08-11',
  profile: { ageYears: 36, sex: 'female', maxHrBpm: 188, restingHrBpm: 48, weightKg: 62 },
  fitness: { ctl: 52.4, atl: 61.2, tsb: -8.8 },
  vo2max: 48.6,
  weeks: [{ startsOn: '2026-08-03', distanceKm: 42.1, movingTimeS: 13_500, sessions: 4 }],
  longestSessionKm30d: 14.2,
  recentAvgPaceSecPerKm: 324,
};

function message(id: number, role: 'user' | 'assistant', content: string): CoachMessageDto {
  return { id, role, content, createdAt: '2026-08-11T09:00:00.000Z' };
}

/** L'ordre réel des effets, pour éprouver ce qui précède quoi. */
let order: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  order = [];

  dal.getTrainingSnapshot.mockResolvedValue(SNAPSHOT);
  dal.listCoachMessages.mockResolvedValue([
    message(1, 'user', 'Je suis fatiguée, je cours ?'),
    message(2, 'assistant', 'Repose-toi.'),
  ]);
  dal.appendCoachExchange.mockImplementation(
    async (input: { question: string; answer: string }) => {
      order.push('append:exchange');
      return {
        question: message(10, 'user', input.question),
        answer: message(11, 'assistant', input.answer),
      };
    },
  );
  chatCompletion.mockImplementation(
    async (options: { onDelta: (delta: string) => void }) => {
      order.push('generate');
      options.onDelta('Repose-toi aujourd’hui.');
      return 'Repose-toi aujourd’hui.';
    },
  );
});

/** Les messages du dernier appel au modèle. */
function sentMessages(): { role: string; content: string }[] {
  return chatCompletion.mock.calls[0][0].messages;
}

describe('answerCoachQuestion — bornes de la question', () => {
  it('refuse une question vide, sans rien écrire ni rien générer', async () => {
    await expect(
      answerCoachQuestion({ question: '   \n ', onDelta: () => {} }),
    ).rejects.toBeInstanceOf(InvalidCoachQuestionError);

    expect(dal.appendCoachExchange).not.toHaveBeenCalled();
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  it('refuse une question au-delà du plafond', async () => {
    const question = 'a'.repeat(COACH_QUESTION_LIMITS.max + 1);

    await expect(answerCoachQuestion({ question, onDelta: () => {} })).rejects.toBeInstanceOf(
      InvalidCoachQuestionError,
    );

    expect(dal.appendCoachExchange).not.toHaveBeenCalled();
  });

  it('accepte une question à la limite exacte, détourée', async () => {
    const question = `  ${'a'.repeat(COACH_QUESTION_LIMITS.max)}  `;

    await answerCoachQuestion({ question, onDelta: () => {} });

    expect(dal.appendCoachExchange).toHaveBeenCalledWith({
      question: 'a'.repeat(COACH_QUESTION_LIMITS.max),
      answer: 'Repose-toi aujourd’hui.',
    });
  });
});

describe('answerCoachQuestion — persistance', () => {
  it('n’écrit l’échange qu’une fois la génération réussie, question puis réponse', async () => {
    const answer = await answerCoachQuestion({ question: 'Je cours demain ?', onDelta: () => {} });

    // La question n'est pas écrite d'avance : elle entre au fil avec sa réponse,
    // en une seule écriture, dans cet ordre.
    expect(order).toEqual(['generate', 'append:exchange']);
    expect(dal.appendCoachExchange).toHaveBeenCalledWith({
      question: 'Je cours demain ?',
      answer: 'Repose-toi aujourd’hui.',
    });
    expect(answer).toEqual({ content: 'Repose-toi aujourd’hui.', messageId: 11 });
  });

  it('n’écrit rien du tout quand la génération échoue', async () => {
    chatCompletion.mockRejectedValue(new AiUnavailableError('unreachable'));

    await expect(
      answerCoachQuestion({ question: 'Je cours demain ?', onDelta: () => {} }),
    ).rejects.toBeInstanceOf(AiUnavailableError);

    // Une question orpheline se relirait sans réponse en face, et repartirait au
    // modèle fusionnée à la tentative suivante.
    expect(order).toEqual([]);
    expect(dal.appendCoachExchange).not.toHaveBeenCalled();
  });

  it('n’écrit rien non plus après des fragments déjà affichés', async () => {
    const seen: string[] = [];
    chatCompletion.mockImplementation(async (options: { onDelta: (delta: string) => void }) => {
      options.onDelta('Commence par un footing');
      throw new AiUnavailableError('unreachable');
    });

    await expect(
      answerCoachQuestion({
        question: 'Je cours demain ?',
        onDelta: (delta) => seen.push(delta),
      }),
    ).rejects.toBeInstanceOf(AiUnavailableError);

    // Une réponse tronquée relue plus tard passerait pour une parole du coach.
    expect(seen).toEqual(['Commence par un footing']);
    expect(dal.appendCoachExchange).not.toHaveBeenCalled();
  });

  it('rejette trois tentatives ratées sans laisser trois questions au fil', async () => {
    chatCompletion.mockRejectedValue(new AiUnavailableError('unreachable'));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        answerCoachQuestion({ question: 'Je cours demain ?', onDelta: () => {} }),
      ).rejects.toBeInstanceOf(AiUnavailableError);
    }

    expect(dal.appendCoachExchange).not.toHaveBeenCalled();
  });

  it('détoure la réponse diffusée avant de l’enregistrer', async () => {
    chatCompletion.mockImplementation(async (options: { onDelta: (delta: string) => void }) => {
      options.onDelta('\n\nRepose-toi.\n');
      return '\n\nRepose-toi.\n';
    });

    const answer = await answerCoachQuestion({ question: 'Alors ?', onDelta: () => {} });

    expect(dal.appendCoachExchange).toHaveBeenCalledWith({
      question: 'Alors ?',
      answer: 'Repose-toi.',
    });
    expect(answer.content).toBe('Repose-toi.');
  });
});

describe('answerCoachQuestion — ce qui est écrit est ce qui a été lu', () => {
  /**
   * `chatCompletion` ne dépouille rien (c'est un contrat de `client.ts`, testé
   * chez lui) : seule la diffusion est filtrée. Persister sa valeur de retour
   * mettrait donc en base un brouillon que l'écran n'a jamais montré.
   */
  it('persiste les fragments diffusés, pas la valeur de retour du modèle', async () => {
    chatCompletion.mockImplementation(async (options: { onDelta: (delta: string) => void }) => {
      options.onDelta('Repose-toi aujourd’hui.');
      return '<think>Elle est fatiguée.</think>Repose-toi aujourd’hui.';
    });

    const answer = await answerCoachQuestion({ question: 'Alors ?', onDelta: () => {} });

    expect(dal.appendCoachExchange).toHaveBeenCalledWith({
      question: 'Alors ?',
      answer: 'Repose-toi aujourd’hui.',
    });
    expect(answer.content).not.toContain('<think>');
  });

  it('rend à l’UI exactement ce qu’elle a affiché', async () => {
    const seen: string[] = [];
    chatCompletion.mockImplementation(async (options: { onDelta: (delta: string) => void }) => {
      options.onDelta('Trois sorties ');
      options.onDelta('faciles.');
      return '<think>hmm</think>Trois sorties faciles.';
    });

    const answer = await answerCoachQuestion({
      question: 'Alors ?',
      onDelta: (delta) => seen.push(delta),
    });

    expect(answer.content).toBe(seen.join(''));
  });

  it('traite une diffusion vide comme un échec de génération, sans rien écrire', async () => {
    // Le cas d'un bloc de raisonnement jamais refermé : `client.ts` a bien reçu
    // du contenu, mais sa porte a tout retenu — il n'y a pas de réponse.
    chatCompletion.mockResolvedValue('<think>Voyons, elle court');

    const error = await answerCoachQuestion({ question: 'Alors ?', onDelta: () => {} }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AiResponseError);
    expect(dal.appendCoachExchange).not.toHaveBeenCalled();
  });

  it('traite de même une diffusion réduite à des blancs', async () => {
    chatCompletion.mockImplementation(async (options: { onDelta: (delta: string) => void }) => {
      options.onDelta('  \n ');
      return '  \n ';
    });

    await expect(
      answerCoachQuestion({ question: 'Alors ?', onDelta: () => {} }),
    ).rejects.toBeInstanceOf(AiResponseError);
    expect(dal.appendCoachExchange).not.toHaveBeenCalled();
  });
});

describe('answerCoachQuestion — abandon', () => {
  it('transmet le signal de l’appelant au client HTTP', async () => {
    const controller = new AbortController();

    await answerCoachQuestion({
      question: 'Alors ?',
      onDelta: () => {},
      signal: controller.signal,
    });

    expect(chatCompletion.mock.calls[0][0].signal).toBe(controller.signal);
  });

  it('n’en pose aucun quand l’appelant n’en fournit pas', async () => {
    await answerCoachQuestion({ question: 'Alors ?', onDelta: () => {} });

    expect(chatCompletion.mock.calls[0][0].signal).toBeUndefined();
  });
});

describe('answerCoachQuestion — fragments', () => {
  it('propage chaque fragment reçu du modèle', async () => {
    const seen: string[] = [];
    chatCompletion.mockImplementation(async (options: { onDelta: (delta: string) => void }) => {
      options.onDelta('Repose-toi ');
      options.onDelta("aujourd'hui.");
      return "Repose-toi aujourd'hui.";
    });

    await answerCoachQuestion({ question: 'Alors ?', onDelta: (delta) => seen.push(delta) });

    expect(seen).toEqual(['Repose-toi ', "aujourd'hui."]);
  });
});

describe('answerCoachQuestion — messages envoyés au modèle', () => {
  it('ne relit que les derniers tours du fil, dans l’ordre où ils ont été dits', async () => {
    dal.listCoachMessages.mockResolvedValue([
      message(1, 'user', 'Question ancienne'),
      message(2, 'assistant', 'Réponse ancienne'),
    ]);

    await answerCoachQuestion({ question: 'Je cours demain ?', onDelta: () => {} });

    // Le fil complet reste en base : seul ce plafond part au modèle.
    expect(dal.listCoachMessages).toHaveBeenCalledWith(COACH_CONTEXT_TURNS);

    const messages = sentMessages();
    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe('system');
    expect(messages.slice(1)).toEqual([
      { role: 'user', content: 'Question ancienne' },
      { role: 'assistant', content: 'Réponse ancienne' },
      // La question du jour n'est pas encore en base : elle est ajoutée ici.
      { role: 'user', content: 'Je cours demain ?' },
    ]);
  });

  it('lit le fil avant d’écrire, et ajoute la question détourée en dernier', async () => {
    dal.listCoachMessages.mockResolvedValue([message(1, 'assistant', 'Réponse ancienne')]);

    await answerCoachQuestion({ question: '  Je cours demain ?  ', onDelta: () => {} });

    // Rien n'a été écrit avant la lecture : la question ne peut donc pas s'y
    // trouver en double.
    expect(dal.appendCoachExchange.mock.invocationCallOrder[0]).toBeGreaterThan(
      dal.listCoachMessages.mock.invocationCallOrder[0],
    );
    const messages = sentMessages();
    expect(messages[messages.length - 1]).toEqual({
      role: 'user',
      content: 'Je cours demain ?',
    });
    expect(messages.filter((sent) => sent.content === 'Je cours demain ?')).toHaveLength(1);
  });

  it('porte l’état d’entraînement dans le message système, daté', async () => {
    await answerCoachQuestion({ question: 'Je cours demain ?', onDelta: () => {} });

    const system = sentMessages()[0].content;
    expect(system).toContain("État d'entraînement au 2026-08-11 :");
    expect(system).toContain('Charge : CTL 52 · ATL 61 · TSB -9.');
    expect(system).toContain('VO2max estimée : 48,6.');
    expect(system).toContain('- semaine du 2026-08-03 : 42,1 km · 3 h 45 · 4 séances');
    expect(system).toContain('Allure moyenne des dernières sorties : 5:24/km.');
  });

  it('interdit d’inventer une donnée, et de prétendre avoir modifié le plan', async () => {
    await answerCoachQuestion({ question: 'Change ma semaine', onDelta: () => {} });

    const system = sentMessages()[0].content;
    expect(system).toContain("tu n'inventes ni n'approximes jamais une donnée physiologique");
    expect(system).toContain('tu ne modifies rien');
    expect(system).toContain("champ d'ajustement de la page « Plan »");
  });

  it('n’autorise que la syntaxe que l’appli sait rendre', async () => {
    await answerCoachQuestion({ question: 'Alors ?', onDelta: () => {} });

    const system = sentMessages()[0].content;
    // Ce que `markdown-lite-parser` reconnaît : titres, puces, gras.
    expect(system).toContain('« ### Titre »');
    expect(system).toContain('**gras**');
    // Et ce qu'il rendrait en caractères bruts.
    expect(system).toContain(
      "n'utilise ni listes numérotées, ni tableaux, ni liens, ni italique, ni code, ni citations",
    );
  });

  it('demande une réponse courte, adressée directement et au tutoiement', async () => {
    await answerCoachQuestion({ question: 'Alors ?', onDelta: () => {} });

    const system = sentMessages()[0].content;
    expect(system).toContain('au tutoiement');
    expect(system).toContain('Trois à six phrases');
  });

  /*
   * Le prompt est tourné pour n'exiger aucun accord en genre : rien dans
   * l'application ne dit celui de la personne qui écrit. Un « interlocutrice »
   * ou un « le coureur » qui reviendrait un jour dans le prompt ferait accorder
   * le modèle au petit bonheur — ce test l'épingle avant l'utilisatrice ou
   * l'utilisateur.
   */
  it('ne fait accorder le modèle sur aucun genre', async () => {
    await answerCoachQuestion({ question: 'Alors ?', onDelta: () => {} });

    const system = sentMessages()[0].content;
    // « le coureur » figure bien dans le prompt, mais comme contre-exemple à ne
    // pas employer : ce sont les formes qui *désignent* l'athlète qu'on traque.
    for (const accord of ['interlocutrice', 'interlocuteur', 'tu la tutoies', 'tu le tutoies']) {
      expect(system.toLowerCase()).not.toContain(accord);
    }
  });
});
