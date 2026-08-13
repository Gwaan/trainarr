import { describe, expect, it } from "vitest";

import { parseRefusal, scanCoachStream, type CoachStreamEvent } from "./coach-stream";

/**
 * Rejoue un flux découpé en chunks arbitraires, exactement comme le composant :
 * tampon + reliquat. C'est le harnais qui vaut le plus ici — la quasi-totalité
 * des bugs SSE vient de la frontière de chunk, pas du parsing d'un événement
 * bien formé.
 */
function replay(chunks: readonly string[]): CoachStreamEvent[] {
  const events: CoachStreamEvent[] = [];
  let buffer = "";

  for (const chunk of chunks) {
    buffer += chunk;
    const scan = scanCoachStream(buffer);
    buffer = scan.rest;
    events.push(...scan.events);
  }

  return events;
}

/** Découpe une chaîne en morceaux de `size` caractères. */
function slice(source: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < source.length; index += size) {
    chunks.push(source.slice(index, index + size));
  }
  return chunks;
}

const TURN =
  'event: delta\ndata: {"text":"Ta charge "}\n\n' +
  'event: delta\ndata: {"text":"est en hausse."}\n\n' +
  'event: done\ndata: {"messageId":412}\n\n';

describe("scanCoachStream — événements bien formés", () => {
  it("lit un delta et ne laisse aucun reliquat", () => {
    const scan = scanCoachStream('event: delta\ndata: {"text":"Bonjour"}\n\n');

    expect(scan.events).toEqual([{ kind: "delta", text: "Bonjour" }]);
    expect(scan.rest).toBe("");
  });

  it("lit plusieurs événements d'un seul tampon, dans l'ordre", () => {
    expect(scanCoachStream(TURN).events).toEqual([
      { kind: "delta", text: "Ta charge " },
      { kind: "delta", text: "est en hausse." },
      { kind: "done", messageId: 412 },
    ]);
  });

  it("lit un événement d'erreur en gardant le message tel quel", () => {
    const scan = scanCoachStream(
      'event: error\ndata: {"message":"Le coach est injoignable pour le moment."}\n\n',
    );

    expect(scan.events).toEqual([
      { kind: "error", message: "Le coach est injoignable pour le moment." },
    ]);
  });

  it("accepte l'absence d'espace après le deux-points", () => {
    const scan = scanCoachStream('event:delta\ndata:{"text":"serré"}\n\n');

    expect(scan.events).toEqual([{ kind: "delta", text: "serré" }]);
  });

  it("ne mange qu'une seule espace de séparation", () => {
    const scan = scanCoachStream('event: delta\ndata:  {"text":"x"}\n\n');

    // La seconde espace fait partie de la donnée : `JSON.parse` la tolère.
    expect(scan.events).toEqual([{ kind: "delta", text: "x" }]);
  });

  it("recolle plusieurs lignes `data:` d'un même événement", () => {
    const scan = scanCoachStream('event: delta\ndata: {"text":\ndata: "coupé"}\n\n');

    expect(scan.events).toEqual([{ kind: "delta", text: "coupé" }]);
  });
});

describe("scanCoachStream — frontières de chunk", () => {
  it("ne rend rien tant que la ligne vide n'est pas arrivée", () => {
    const scan = scanCoachStream('event: delta\ndata: {"text":"Bonjour"}\n');

    expect(scan.events).toEqual([]);
    expect(scan.rest).toBe('event: delta\ndata: {"text":"Bonjour"}\n');
  });

  it("reconstitue un événement coupé en plein JSON", () => {
    expect(replay(['event: delta\ndata: {"te', 'xt":"Bonjour"}\n\n'])).toEqual([
      { kind: "delta", text: "Bonjour" },
    ]);
  });

  it("reconstitue un événement coupé entre les deux retours à la ligne", () => {
    expect(replay(['event: delta\ndata: {"text":"Bonjour"}\n', "\n"])).toEqual([
      { kind: "delta", text: "Bonjour" },
    ]);
  });

  it("reconstitue un événement coupé en plein nom d'événement", () => {
    expect(replay(["event: de", 'lta\ndata: {"text":"Bonjour"}\n\n'])).toEqual([
      { kind: "delta", text: "Bonjour" },
    ]);
  });

  it("rend le même tour de parole quelle que soit la taille des chunks", () => {
    const expected: CoachStreamEvent[] = [
      { kind: "delta", text: "Ta charge " },
      { kind: "delta", text: "est en hausse." },
      { kind: "done", messageId: 412 },
    ];

    for (const size of [1, 2, 3, 7, 13, 31, 128]) {
      expect(replay(slice(TURN, size))).toEqual(expected);
    }
  });

  it("ne perd pas l'événement suivant quand deux événements arrivent collés puis coupés", () => {
    expect(
      replay([
        'event: delta\ndata: {"text":"a"}\n\nevent: delta\ndata: {"tex',
        't":"b"}\n\nevent: done\ndata: {"messageId":7}\n\n',
      ]),
    ).toEqual([
      { kind: "delta", text: "a" },
      { kind: "delta", text: "b" },
      { kind: "done", messageId: 7 },
    ]);
  });

  it("ne prend pas un retour à la ligne du texte pour une fin d'événement", () => {
    // Le JSON échappe le saut de ligne : le tampon ne contient jamais `\n\n`
    // avant la vraie fin de l'événement.
    const scan = scanCoachStream(
      'event: delta\ndata: {"text":"Semaine 1\\n\\nSemaine 2"}\n\n',
    );

    expect(scan.events).toEqual([{ kind: "delta", text: "Semaine 1\n\nSemaine 2" }]);
  });
});

describe("scanCoachStream — fins de ligne", () => {
  it("traite un flux en CRLF comme un flux en LF", () => {
    const scan = scanCoachStream('event: delta\r\ndata: {"text":"Bonjour"}\r\n\r\n');

    expect(scan.events).toEqual([{ kind: "delta", text: "Bonjour" }]);
    expect(scan.rest).toBe("");
  });

  it("garde un `\\r` isolé en fin de tampon plutôt que d'inventer une fin d'événement", () => {
    expect(replay(['event: delta\r\ndata: {"text":"Bonjour"}\r', "\n\r\n"])).toEqual([
      { kind: "delta", text: "Bonjour" },
    ]);
  });

  it("absorbe une ligne vide surnuméraire entre deux événements", () => {
    expect(
      scanCoachStream('event: delta\ndata: {"text":"a"}\n\n\nevent: done\ndata: {"messageId":1}\n\n')
        .events,
    ).toEqual([
      { kind: "delta", text: "a" },
      { kind: "done", messageId: 1 },
    ]);
  });
});

describe("scanCoachStream — ce qui est ignoré", () => {
  it("ignore les commentaires de maintien de connexion", () => {
    expect(scanCoachStream(': ping\n\nevent: delta\ndata: {"text":"a"}\n\n').events).toEqual([
      { kind: "delta", text: "a" },
    ]);
  });

  it("ignore un nom d'événement inconnu", () => {
    expect(
      scanCoachStream('event: heartbeat\ndata: {"at":1}\n\nevent: delta\ndata: {"text":"a"}\n\n')
        .events,
    ).toEqual([{ kind: "delta", text: "a" }]);
  });

  it("ignore un bloc sans `event:`", () => {
    expect(scanCoachStream('data: {"text":"a"}\n\n').events).toEqual([]);
  });

  it("ignore les champs `id` et `retry`", () => {
    expect(
      scanCoachStream('id: 4\nretry: 2000\nevent: delta\ndata: {"text":"a"}\n\n').events,
    ).toEqual([{ kind: "delta", text: "a" }]);
  });
});

describe("scanCoachStream — charges illisibles", () => {
  it("signale un JSON invalide sur un événement connu", () => {
    expect(scanCoachStream("event: delta\ndata: {oops\n\n").events).toEqual([
      { kind: "malformed", event: "delta" },
    ]);
  });

  it("signale un événement connu privé de données", () => {
    expect(scanCoachStream("event: done\n\n").events).toEqual([
      { kind: "malformed", event: "done" },
    ]);
  });

  it("signale un `delta` dont le texte n'est pas une chaîne", () => {
    expect(scanCoachStream("event: delta\ndata: {\"text\":42}\n\n").events).toEqual([
      { kind: "malformed", event: "delta" },
    ]);
  });

  it("signale un `done` dont l'identifiant n'est pas un entier", () => {
    expect(scanCoachStream('event: done\ndata: {"messageId":"412"}\n\n').events).toEqual([
      { kind: "malformed", event: "done" },
    ]);
    expect(scanCoachStream('event: done\ndata: {"messageId":4.2}\n\n').events).toEqual([
      { kind: "malformed", event: "done" },
    ]);
  });

  it("signale une erreur sans message", () => {
    expect(scanCoachStream('event: error\ndata: {}\n\n').events).toEqual([
      { kind: "malformed", event: "error" },
    ]);
  });
});

describe("parseRefusal", () => {
  it("rend le message du refus tel que la route l'a écrit", () => {
    expect(parseRefusal({ message: "Trop de questions coup sur coup." })).toBe(
      "Trop de questions coup sur coup.",
    );
  });

  it("rend `null` quand il n'y a pas de message exploitable", () => {
    expect(parseRefusal(null)).toBeNull();
    expect(parseRefusal({})).toBeNull();
    expect(parseRefusal({ message: "" })).toBeNull();
    expect(parseRefusal({ message: 42 })).toBeNull();
    expect(parseRefusal("Trop de questions.")).toBeNull();
  });
});
