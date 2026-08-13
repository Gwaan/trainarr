import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { acquireCoachChatSlot } from '@/lib/ai/chat-guard';
import { COACH_QUESTION_LIMITS, answerCoachQuestion } from '@/lib/ai/coach-service';
import { AiResponseError, AiUnavailableError } from '@/lib/ai/errors';

/**
 * Le chat du coach : `POST /api/coach/chat`, réponse en flux SSE.
 *
 * Route handler et non Server Action — c'est le cas que `.claude/rules/nextjs.md`
 * leur réserve explicitement : une Server Action rend **une** valeur, à la fin,
 * et la fenêtre resterait vide pendant la minute que le modèle local met à
 * écrire. Ici la réponse s'affiche pendant qu'elle s'écrit.
 *
 * ## Fil d'événements (contrat avec l'UI)
 *
 * ```
 * event: delta
 * data: {"text":"…"}
 *
 * event: done
 * data: {"messageId":123}
 *
 * event: error
 * data: {"message":"…"}
 * ```
 *
 * Un objet JSON sur une seule ligne par `data:`, chaque événement clos par une
 * ligne vide. Le flux se termine sur `done` **ou** sur `error`, jamais les deux.
 *
 * S'y intercalent, avant le premier `delta` seulement, des commentaires SSE de
 * maintien de connexion (cf. {@link HEARTBEAT_INTERVAL_MS}) : le décodeur les
 * ignore, mais le reverse proxy, lui, les compte comme du trafic.
 *
 * ## Ce qui se refuse avant d'ouvrir le flux
 *
 * Une entrée invalide et un refus de charge répondent en **JSON**, avec un vrai
 * code HTTP (400/409/429). C'est la seule fenêtre où c'est encore possible :
 * une fois les en-têtes envoyés, le statut est figé à 200 et une panne ne peut
 * plus se dire que par un `event: error` (cf. plus bas).
 *
 * Pas de `connection()` : un handler POST n'est jamais prérendu, et la lecture
 * du corps est déjà un signal dynamique — vérifié au build, la route ressort
 * en `ƒ`.
 */

/** Le corps attendu. Bornes du service, pour refuser au plus tôt ce qu'il refuserait. */
const chatRequestSchema = z.object({
  question: z.string().trim().min(COACH_QUESTION_LIMITS.min).max(COACH_QUESTION_LIMITS.max),
});

/**
 * En-têtes du flux.
 *
 * `x-accel-buffering` s'adresse à un éventuel reverse proxy : nginx bufferise
 * par défaut les réponses en amont, ce qui livrerait la réponse entière d'un
 * bloc à la fin — précisément ce que le streaming cherche à éviter.
 */
const STREAM_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  'x-accel-buffering': 'no',
} as const;

/** Une réponse périmée d'une seconde est une réponse fausse. */
const JSON_HEADERS = { 'cache-control': 'no-store' } as const;

/** Les trois événements du fil. */
type CoachChatEvent = 'delta' | 'done' | 'error';

/**
 * Battement de cœur du flux, tant qu'aucun fragment n'est parti.
 *
 * Entre l'ouverture du flux et le premier `delta`, il ne se passe rien sur le
 * fil : le serveur pré-remplit son contexte (32 k de prompt sur un petit GPU),
 * puis `client.ts` retient la tête de la réponse le temps de lever le doute sur
 * un bloc de raisonnement. Deux attentes qui s'additionnent, et pendant
 * lesquelles pas un octet n'est écrit.
 *
 * Or l'appli vit derrière un reverse proxy, dont le `proxy_read_timeout` vaut 60
 * secondes par défaut chez nginx : la connexion serait coupée avant le premier
 * octet utile, et l'athlète lirait un échec de transport là où le coach était
 * simplement en train de réfléchir. D'où ces commentaires SSE (`: ping`), que le
 * décodeur ignore déjà par construction (cf. `coach-stream.ts`), émis assez
 * souvent pour qu'aucune fenêtre de 60 s ne puisse rester muette — quinze
 * secondes laissent la place à trois pings ratés avant que le proxy ne tranche.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** Un commentaire SSE : de quoi tenir la connexion, et rien d'autre. */
const HEARTBEAT_FRAME = ': ping\n\n';

/**
 * Ce que l'athlète lit quand la génération échoue — jamais une trace technique,
 * jamais un nom de variable d'environnement.
 *
 * Les deux pannes du socle IA sont distinguées parce qu'elles n'appellent pas la
 * même réaction : un coach injoignable se rallume avant qu'on ne le relance, une
 * réponse hors contrat se retente immédiatement.
 *
 * Dans les deux cas, **rien n'a été écrit** : le service ne persiste l'échange
 * qu'une fois la réponse complète (cf. `coach-service.ts`), et l'écran rend la
 * question à la saisie. Le dire est le seul moyen que l'athlète ne cherche pas
 * dans son fil une question qui n'y est pas.
 */
function athleteMessage(error: unknown): string {
  if (error instanceof AiUnavailableError) {
    return error.reason === 'unconfigured'
      ? "Le coach IA n'est pas configuré sur cette installation : il n'y a personne à qui parler pour l'instant."
      : "Le coach ne répond pas — la machine qui l'héberge est peut-être éteinte. Ta question t'est rendue dans la saisie : renvoie-la dans un moment.";
  }
  if (error instanceof AiResponseError) {
    return 'Le coach a bien répondu, mais sa réponse est inexploitable. Repose ta question.';
  }
  return "Le coach n'a pas pu répondre. Réessaie dans un moment.";
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // TODO(auth) : pas encore de session dans Trainarr (mono-utilisateur, accès
  // réseau restreint). Dès qu'elle existera, vérifier ici l'identité de
  // l'appelant — cette route est exposée en écriture (elle ajoute au fil et
  // occupe le GPU), et rien d'autre ne la protège.

  const payload: unknown = await request.json().catch(() => null);
  const parsed = chatRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { message: `Question attendue, de 1 à ${COACH_QUESTION_LIMITS.max} caractères.` },
      { status: 400, headers: JSON_HEADERS },
    );
  }

  const slot = acquireCoachChatSlot();
  if (!slot.granted) {
    // 409 et non 429 pour la concurrence : ce n'est pas un quota mais l'état
    // d'une ressource unique — le GPU est occupé, et la requête repassera dès
    // que la réponse en cours sera écrite, sans aucun délai à respecter. Le 429,
    // lui, est gardé pour le vrai plafond, celui de la minute glissante.
    return slot.reason === 'busy'
      ? NextResponse.json(
          {
            message:
              "Le coach écrit déjà une réponse. Attends qu'il ait terminé avant de lui reposer une question.",
          },
          { status: 409, headers: JSON_HEADERS },
        )
      : NextResponse.json(
          { message: 'Trop de questions coup sur coup. Laisse une minute au coach.' },
          { status: 429, headers: { ...JSON_HEADERS, 'retry-after': '60' } },
        );
  }

  const encoder = new TextEncoder();

  /**
   * Vrai dès que le client s'en va. Quatre façons de l'apprendre, et on les
   * prend toutes : l'état du signal de la requête **à l'entrée**, l'événement
   * `abort` de ce même signal, l'annulation du flux par le consommateur, et
   * l'échec d'un `enqueue` sur un flux déjà clos.
   *
   * L'état initial ne fait pas doublon avec l'événement : un signal déjà avorté
   * n'émettra plus jamais rien, et c'est un cas réel — le client peut être parti
   * pendant que sa requête attendait le verrou de la garde de charge.
   */
  let abandoned = request.signal.aborted;
  let closed = false;

  const onAbort = (): void => {
    abandoned = true;
  };
  if (!abandoned) request.signal.addEventListener('abort', onAbort, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: CoachChatEvent, data: object): void => {
        if (abandoned || closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // Le consommateur a fermé le flux entre deux fragments : il n'y a plus
          // personne à qui écrire, et c'est la seule façon de l'apprendre.
          abandoned = true;
        }
      };

      /**
       * L'horloge du battement de cœur, arrêtée dès le premier fragment : à
       * partir de là, c'est la réponse elle-même qui tient la connexion. Un
       * intervalle qui survivrait au flux serait une fuite, d'où l'arrêt en
       * `finally` — `clearInterval` sur une horloge déjà arrêtée ne fait rien.
       */
      let heartbeat: ReturnType<typeof setInterval> | undefined = setInterval(() => {
        if (abandoned || closed) return;
        try {
          controller.enqueue(encoder.encode(HEARTBEAT_FRAME));
        } catch {
          abandoned = true;
        }
      }, HEARTBEAT_INTERVAL_MS);

      try {
        const answer = await answerCoachQuestion({
          question: parsed.data.question,
          // Le départ du client rompt la génération par le signal, pas par une
          // levée depuis ici : `client.ts` abandonne alors son `fetch`, et
          // llama-server libère son slot — y compris quand rien n'a encore été
          // diffusé, ce qu'une levée depuis `onDelta` ne savait pas faire.
          signal: request.signal,
          onDelta: (delta) => {
            clearInterval(heartbeat);
            heartbeat = undefined;
            send('delta', { text: delta });
          },
        });

        send('done', { messageId: answer.messageId });
      } catch (error) {
        // Départ du client : la coupure est voulue, il n'y a ni panne à
        // journaliser ni message à envoyer à une page qui n'est plus là.
        if (!abandoned) {
          console.error('[coach/chat] génération en échec :', error);
          // Les en-têtes sont partis depuis le premier fragment : le statut ne
          // peut plus changer, l'échec se dit dans le flux puis le ferme.
          send('error', { message: athleteMessage(error) });
        }
      } finally {
        clearInterval(heartbeat);
        request.signal.removeEventListener('abort', onAbort);
        slot.release();
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // Flux déjà clos par le départ du client : rien à fermer.
          }
        }
      }
    },
    cancel() {
      // Le consommateur a lâché le flux : plus rien ne sera écrit ici, et la
      // génération se coupe par le signal de la requête, qui tombe avec lui.
      abandoned = true;
    },
  });

  return new NextResponse(stream, { headers: STREAM_HEADERS });
}
