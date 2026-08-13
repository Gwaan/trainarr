/**
 * Décodeur du flux SSE du coach — fonction pure, testée, sans DOM ni réseau.
 *
 * Le route handler `POST /api/coach/chat` répond en `text/event-stream` avec un
 * protocole fermé, trois événements et un objet JSON par `data:` :
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
 * ## Pourquoi un scanner à tampon plutôt qu'un `split()`
 *
 * Un `ReadableStream` découpe où il veut : la frontière d'un chunk réseau tombe
 * aussi bien au milieu d'un objet JSON qu'entre les deux retours à la ligne qui
 * terminent un événement. Découper naïvement le chunk reçu produirait donc des
 * `data:` tronqués, et un `JSON.parse` en échec une fois sur deux sur les
 * réponses longues — le piège classique de SSE.
 *
 * D'où le contrat de {@link scanCoachStream} : il rend les événements **entiers**
 * qu'il a pu lire, et le reliquat non terminé que l'appelant doit préfixer au
 * chunk suivant. Le scanner ne garde aucun état de son côté ; c'est ce qui le
 * rend pur et testable en dehors de tout navigateur.
 *
 * Note : le texte des `delta` est transporté **dans du JSON**, donc ses retours
 * à la ligne sont échappés (`\n`) et ne peuvent jamais être pris pour la fin
 * d'un événement. C'est la raison pour laquelle un objet JSON par ligne `data:`
 * suffit, sans encodage supplémentaire.
 *
 * Le module couvre aussi l'autre moitié du contrat de la route : le refus rendu
 * en JSON ordinaire, avant que le flux ne s'ouvre (cf. {@link parseRefusal}).
 */

import { z } from "zod";

/**
 * Un événement lu sur le flux.
 *
 * `malformed` n'est pas du bruit défensif : le scanner refuse d'avaler en
 * silence un événement **connu** dont la charge utile est illisible (JSON
 * tronqué par une coupure serveur, contrat rompu). Il le signale, et l'UI
 * décide quoi en dire — le texte affiché à l'athlète appartient à l'UI, pas au
 * décodeur.
 */
export type CoachStreamEvent =
  | { readonly kind: "delta"; readonly text: string }
  | { readonly kind: "done"; readonly messageId: number }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "malformed"; readonly event: string };

export type CoachStreamScan = {
  /** Les événements entiers lus dans le tampon, dans l'ordre d'arrivée. */
  readonly events: CoachStreamEvent[];
  /** Le reliquat non terminé : à préfixer au prochain chunk. */
  readonly rest: string;
};

const DELTA_DATA = z.object({ text: z.string() });
const DONE_DATA = z.object({ messageId: z.number().int() });
const ERROR_DATA = z.object({ message: z.string() });

/**
 * Corps d'un refus : la route décline certaines demandes **avant** d'ouvrir le
 * flux (question hors bornes, coach déjà en train d'écrire, trop de questions
 * coup sur coup) et répond alors un JSON ordinaire, avec un message déjà rédigé
 * pour l'athlète.
 */
const REFUSAL = z.object({ message: z.string().min(1) });

/**
 * Le message d'un refus, ou `null` si la réponse n'en portait pas d'utilisable —
 * à l'appelant, alors, de dire l'échec avec ses propres mots.
 */
export function parseRefusal(payload: unknown): string | null {
  const parsed = REFUSAL.safeParse(payload);
  return parsed.success ? parsed.data.message : null;
}

/** Séparateur d'événements après normalisation des fins de ligne. */
const EVENT_END = "\n\n";

/** `JSON.parse` sans lever : une charge illisible vaut `undefined`, que Zod refuse. */
function parseJson(source: string): unknown {
  try {
    const parsed: unknown = JSON.parse(source);
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Un bloc d'événement → l'événement typé, ou `null` s'il n'y a rien à en tirer.
 *
 * Sont ignorés sans bruit : les lignes de commentaire (`:` en tête, ce qu'un
 * serveur envoie pour tenir la connexion ouverte), les champs `id`/`retry`, les
 * blocs sans `event:` et **les noms d'événements inconnus** — c'est le point
 * d'extension de SSE, un flux qui gagnerait un `event: heartbeat` ne doit pas
 * faire échouer une conversation en cours.
 */
function parseEventBlock(block: string): CoachStreamEvent | null {
  let name: string | null = null;
  const data: string[] = [];

  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? "" : line.slice(colon + 1);
    // Une unique espace après le deux-points est un séparateur, pas de la donnée.
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;

    if (field === "event") name = value;
    else if (field === "data") data.push(value);
  }

  if (name === null) return null;

  // Plusieurs lignes `data:` se recollent par un retour à la ligne (spec SSE).
  // Notre serveur n'en émet qu'une, mais la règle ne coûte rien à tenir.
  const payload = parseJson(data.join("\n"));

  switch (name) {
    case "delta": {
      const parsed = DELTA_DATA.safeParse(payload);
      return parsed.success
        ? { kind: "delta", text: parsed.data.text }
        : { kind: "malformed", event: name };
    }
    case "done": {
      const parsed = DONE_DATA.safeParse(payload);
      return parsed.success
        ? { kind: "done", messageId: parsed.data.messageId }
        : { kind: "malformed", event: name };
    }
    case "error": {
      const parsed = ERROR_DATA.safeParse(payload);
      return parsed.success
        ? { kind: "error", message: parsed.data.message }
        : { kind: "malformed", event: name };
    }
    default:
      return null;
  }
}

/**
 * Lit tout ce que le tampon contient d'entier.
 *
 * Usage : `buffer += chunk; const { events, rest } = scanCoachStream(buffer);
 * buffer = rest;` — appeler deux fois de suite sur le même reliquat est sans
 * effet, la fonction est idempotente sur un tampon qu'elle vient de rendre.
 *
 * Les fins de ligne `\r\n` sont ramenées à `\n` avant découpage. Un `\r`
 * solitaire en fin de tampon reste dans le reliquat : c'est peut-être la
 * première moitié d'un `\r\n` coupé par le réseau, et la trancher ici
 * inventerait une fin d'événement.
 */
export function scanCoachStream(buffer: string): CoachStreamScan {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const events: CoachStreamEvent[] = [];

  let start = 0;
  for (;;) {
    const boundary = normalized.indexOf(EVENT_END, start);
    if (boundary === -1) break;

    const event = parseEventBlock(normalized.slice(start, boundary));
    if (event !== null) events.push(event);
    start = boundary + EVENT_END.length;
  }

  return { events, rest: normalized.slice(start) };
}
