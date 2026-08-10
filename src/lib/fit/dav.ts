/**
 * Point de dépôt WebDAV des fichiers FIT, servi par l'application elle-même.
 *
 * La montre (HealthFit) envoie ses fichiers en WebDAV sur `https://<domaine>/dav`.
 * Plutôt qu'un container dédié exposé en écriture sur Internet, `src/proxy.ts`
 * intercepte ce préfixe et délègue ici : les requêtes n'atteignent jamais le
 * routeur Next, et le fichier atterrit dans `FIT_INBOX_DIR`, où le service
 * d'import (`src/lib/fit/service.ts`, même process) le récupère.
 *
 * On n'implémente que le sous-ensemble dont un *client de dépôt* a besoin —
 * OPTIONS, PROPFIND, MKCOL, PUT — et rien de plus : pas de listage réel, pas de
 * lecture, pas de suppression. C'est une boîte aux lettres, pas un espace de
 * stockage, et elle est joignable depuis Internet.
 *
 * Toute la logique est ici, testable sans serveur HTTP : `handleDavRequest`
 * prend une `Request` standard et ses dépendances (identifiants, répertoire,
 * système de fichiers) en argument.
 *
 * ## Limites assumées
 *
 * **Un PUT sans `Content-Length` (transfert chunked) est refusé (411)**, et
 * c'est volontaire. Next bufferise le corps et le tronque silencieusement au
 * plafond `proxyClientMaxBodySize` : la longueur annoncée est le seul repère qui
 * permette de détecter cette troncature (cf. le contrôle sur les octets écrits
 * dans `handlePut`). Sans elle, un envoi coupé s'écrirait comme un FIT complet —
 * une donnée d'entraînement fausse, silencieuse et indétectable. Mieux vaut
 * refuser un client exotique que stocker un fichier corrompu ; HealthFit, lui,
 * annonce bien sa taille.
 *
 * **Le corps est bufferisé par Next AVANT que ce code n'authentifie quoi que ce
 * soit.** Un flood non authentifié sur `/dav` consomme donc de la mémoire sans
 * jamais atteindre la vérification Basic. C'est structurel : le handler ne voit
 * la requête qu'une fois le corps reçu. La parade est en amont, dans le reverse
 * proxy — limite de taille de corps sur `/dav` et rate-limit sur ce préfixe —,
 * pas dans l'application.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { MAX_FIT_FILE_BYTES, toMegabytes } from './limits';

/** Préfixe d'URL intercepté. Exporté pour que le proxy et les tests partagent la même constante. */
export const DAV_BASE_PATH = '/dav';

/** Suffixe des fichiers en cours de réception (cf. `handlePut`). */
const PART_SUFFIX = '.part';

/** Seule extension acceptée par le dépôt, comparée en minuscules. */
const FIT_EXTENSION = '.fit';

/**
 * Limite de longueur d'un nom de fichier sur les systèmes de fichiers usuels
 * (ext4, XFS, APFS) : 255 **octets**, et non 255 caractères.
 */
const MAX_NAME_BYTES = 255;

/** Nombre de suffixes essayés avant d'abandonner sur collision de nom. */
const MAX_NAME_ATTEMPTS = 100;

/*
 * Dépendances injectées.
 */

export type DavCredentials = {
  username: string;
  password: string;
};

/**
 * Les seules opérations disque dont le dépôt a besoin. Interface étroite pour
 * que les tests puissent la simuler — l'implémentation réelle est
 * `nodeDavFileSystem`.
 */
export type DavFileSystem = {
  ensureDir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Crée un fichier vide en exclusif. `false` si le chemin est déjà pris. */
  createExclusive(path: string): Promise<boolean>;
  /**
   * Déverse le flux dans un fichier **déjà créé** par `createExclusive` et
   * retourne le nombre d'octets écrits.
   */
  writeStream(path: string, body: ReadableStream<Uint8Array>): Promise<number>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
};

export type DavDeps = {
  /**
   * `null` quand `WEBDAV_USERNAME`/`WEBDAV_PASSWORD` ne sont pas configurés :
   * le dépôt répond alors 503 à tout le monde. Un point d'écriture exposé sur
   * Internet ne doit jamais s'ouvrir par défaut d'attention.
   */
  credentials: DavCredentials | null;
  /** Répertoire de dépôt, celui que le service d'import surveille. */
  inboxDir: string;
  fs: DavFileSystem;
};

/*
 * Réponses.
 */

const ALLOWED_METHODS = 'OPTIONS, PROPFIND, PUT, MKCOL, HEAD';

/** Corps en texte brut : ces réponses s'adressent à un client WebDAV, pas à un navigateur. */
function text(status: number, message: string, headers?: HeadersInit): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers },
  });
}

/*
 * Authentification.
 */

/**
 * Comparaison à temps constant de deux chaînes.
 *
 * Le hachage préalable sert à deux choses : `timingSafeEqual` exige deux
 * tampons de même longueur (SHA-256 les normalise à 32 octets), et la
 * comparaison ne laisse plus fuiter la longueur du secret attendu.
 */
function secureEquals(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a, 'utf8').digest();
  const hashB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(hashA, hashB);
}

/** Décode un en-tête `Authorization: Basic …` (RFC 7617). `null` si absent ou malformé. */
export function decodeBasicAuth(header: string | null): DavCredentials | null {
  if (header === null) return null;

  const match = /^basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(header.trim());
  if (match === null) return null;

  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;

  // Le mot de passe peut contenir des « : », pas le nom d'utilisateur (RFC 7617).
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

/** `true` si l'en-tête présente exactement les identifiants attendus. */
export function isAuthorized(header: string | null, expected: DavCredentials): boolean {
  const provided = decodeBasicAuth(header);
  if (provided === null) return false;

  // Les deux comparaisons sont évaluées avant d'être combinées : un `&&`
  // court-circuité révélerait par le temps de réponse si le nom était correct.
  const sameUser = secureEquals(provided.username, expected.username);
  const samePassword = secureEquals(provided.password, expected.password);
  return sameUser && samePassword;
}

/*
 * Nom du fichier déposé.
 */

/**
 * Séparateurs de chemin et caractères de contrôle (NUL compris), qui n'ont
 * rien à faire dans un nom de fichier. Écrit en boucle plutôt qu'en expression
 * régulière : une classe de caractères de contrôle littérale est illisible.
 */
function hasForbiddenChar(name: string): boolean {
  for (const char of name) {
    if (char === '/' || char === '\\') return true;
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export type NameResolution =
  | { ok: true; name: string }
  | { ok: false; status: number; message: string };

/**
 * Nom de fichier sûr à partir du chemin d'URL de la requête.
 *
 * Le dernier segment de l'URL fait office de nom, les éventuels dossiers
 * intermédiaires sont ignorés : certains clients rangent par date (cf. `MKCOL`,
 * qui ne crée rien), tout atterrit à plat dans la boîte de dépôt.
 *
 * Le décodage précède la validation, et non l'inverse : c'est le seul ordre qui
 * intercepte `%2F` et `%00`, dont l'intérêt pour un attaquant est précisément
 * de traverser un contrôle fait sur la forme encodée.
 */
export function resolveUploadName(pathname: string): NameResolution {
  const segments = pathname.split('/');
  const lastSegment = segments[segments.length - 1] ?? '';

  let decoded: string;
  try {
    decoded = decodeURIComponent(lastSegment);
  } catch {
    return { ok: false, status: 400, message: 'Nom de fichier mal encodé.' };
  }

  const name = decoded.trim();
  if (name === '') {
    return { ok: false, status: 400, message: 'Nom de fichier absent.' };
  }
  if (hasForbiddenChar(name)) {
    return { ok: false, status: 400, message: 'Nom de fichier invalide.' };
  }
  // Après le filtre ci-dessus, « . » et « .. » sont les seuls noms résiduels
  // qui ne désignent pas un fichier.
  if (name === '.' || name === '..') {
    return { ok: false, status: 400, message: 'Nom de fichier invalide.' };
  }
  // En octets, pas en unités UTF-16 : un nom d'accents ou d'idéogrammes pèse
  // deux à trois fois sa longueur `String.length`, et c'est bien l'octet que
  // compte le système de fichiers. Le `.part` de réception est le nom le plus
  // long réellement créé (cf. `handlePut`), c'est donc lui qui borne.
  if (Buffer.byteLength(name, 'utf8') + PART_SUFFIX.length > MAX_NAME_BYTES) {
    return { ok: false, status: 400, message: 'Nom de fichier trop long.' };
  }
  if (!name.toLowerCase().endsWith(FIT_EXTENSION)) {
    return { ok: false, status: 415, message: 'Seuls les fichiers .fit sont acceptés.' };
  }
  // Un nom réduit à son extension (« .fit ») est acceptable pour le système de
  // fichiers, pas pour le dépôt : `nameWithSuffix` n'y trouve pas de radical à
  // suffixer et produirait `.fit-1`, que le watcher ignore à jamais.
  if (name.length === FIT_EXTENSION.length) {
    return { ok: false, status: 400, message: 'Nom de fichier réduit à son extension.' };
  }

  return { ok: true, name };
}

/** `run.fit` + 2 → `run-2.fit`. Le suffixe se glisse avant l'extension, pas après. */
export function nameWithSuffix(name: string, suffix: number): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? `${name}-${suffix}` : `${name.slice(0, dot)}-${suffix}${name.slice(dot)}`;
}

/*
 * Méthodes.
 */

function handleOptions(): Response {
  return new Response(null, {
    status: 200,
    headers: { DAV: '1', Allow: ALLOWED_METHODS, 'Content-Length': '0' },
  });
}

/** Échappe le texte destiné à un nœud XML (le href reprend le chemin demandé). */
function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * Multistatus minimal déclarant le chemin demandé comme une collection vide.
 *
 * Les clients de dépôt ne font un PROPFIND que pour vérifier que la cible
 * existe et qu'elle est un dossier. On ne liste donc **rien** : le contenu réel
 * de la boîte (noms de séances, dates d'entraînement) n'a pas à sortir, et
 * `Depth` est ignoré pour la même raison.
 */
function handlePropfind(pathname: string): Response {
  const href = escapeXml(pathname.endsWith('/') ? pathname : `${pathname}/`);
  const body = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>${href}</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>
`;

  return new Response(body, {
    status: 207,
    headers: { 'Content-Type': 'application/xml; charset=utf-8', DAV: '1' },
  });
}

export type LengthCheck =
  | { ok: true; length: number }
  | { ok: false; status: number; message: string };

/**
 * `Content-Length` déclaré, contrôlé **avant** de toucher au corps.
 *
 * L'écriture se fait en flux, mais l'en-tête reste le seul moyen de refuser un
 * envoi démesuré sans en avoir consommé le premier octet — et Next bufferise
 * déjà le corps en mémoire (`proxyClientMaxBodySize`), raison de plus pour
 * trancher ici.
 */
export function checkContentLength(header: string | null): LengthCheck {
  const raw = header?.trim() ?? '';

  if (raw === '') {
    return { ok: false, status: 411, message: 'En-tête Content-Length requis.' };
  }
  if (!/^\d+$/.test(raw)) {
    return { ok: false, status: 400, message: 'En-tête Content-Length invalide.' };
  }

  const length = Number(raw);
  if (length > MAX_FIT_FILE_BYTES) {
    return {
      ok: false,
      status: 413,
      message: `Fichier trop volumineux : maximum ${toMegabytes(MAX_FIT_FILE_BYTES)} Mo.`,
    };
  }
  // Un FIT de 0 octet n'existe pas, et le watcher attendrait indéfiniment qu'il
  // grossisse (pour lui, une taille nulle vaut « upload en cours »).
  if (length === 0) {
    return { ok: false, status: 400, message: 'Fichier vide.' };
  }

  return { ok: true, length };
}

/** Un nom final libre et le fichier temporaire réservé pour l'écrire. */
type Target = { finalPath: string; partPath: string };

/**
 * Réserve un nom dans la boîte de dépôt, sans jamais écraser un fichier
 * existant.
 *
 * La création exclusive du `.part` fait office de verrou : deux envois
 * simultanés du même nom ne peuvent pas réserver la même cible. `null` si
 * aucune variante n'est libre.
 */
async function reserveTarget(
  fs: DavFileSystem,
  inboxDir: string,
  name: string,
): Promise<Target | null> {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? name : nameWithSuffix(name, attempt);
    const finalPath = join(inboxDir, candidate);

    if (await fs.exists(finalPath)) continue;

    const partPath = `${finalPath}${PART_SUFFIX}`;
    if (await fs.createExclusive(partPath)) return { finalPath, partPath };
  }

  return null;
}

/**
 * Réception d'un fichier.
 *
 * Le corps est écrit sous un nom temporaire puis renommé : le watcher ne voit
 * jamais un `.fit` en cours d'écriture (`.part` n'a pas la bonne extension, il
 * l'ignore). Sa règle de stabilité de taille l'en protégeait déjà, mais un
 * fichier incomplet ingéré est une donnée d'entraînement fausse — deux verrous
 * valent mieux qu'un.
 */
async function handlePut(request: Request, pathname: string, deps: DavDeps): Promise<Response> {
  const length = checkContentLength(request.headers.get('content-length'));
  if (!length.ok) return text(length.status, length.message);

  const resolved = resolveUploadName(pathname);
  if (!resolved.ok) return text(resolved.status, resolved.message);

  if (request.body === null) {
    return text(400, 'Corps de requête absent.');
  }

  await deps.fs.ensureDir(deps.inboxDir);

  const target = await reserveTarget(deps.fs, deps.inboxDir, resolved.name);
  if (target === null) {
    return text(409, 'Trop de fichiers portent déjà ce nom.');
  }

  // Le `.part` est réservé : tout ce qui suit doit le nettoyer avant de rendre
  // la main. Un temporaire abandonné condamne le nom canonique jusqu'au
  // balayage du watcher.
  try {
    const written = await deps.fs.writeStream(target.partPath, request.body);

    // Next tronque silencieusement un corps qui dépasse `proxyClientMaxBodySize`
    // (comportement vérifié) : sans ce contrôle, un envoi tronqué deviendrait un
    // `.fit` corrompu déposé comme s'il était complet.
    if (written !== length.length) {
      await deps.fs.remove(target.partPath);
      return text(400, 'Corps incomplet : la taille reçue ne correspond pas au Content-Length.');
    }

    await deps.fs.rename(target.partPath, target.finalPath);
  } catch (error) {
    await deps.fs.remove(target.partPath);
    console.error(`[dav] réception en échec :`, error);
    return text(500, 'Écriture impossible sur le point de dépôt.');
  }

  return new Response(null, { status: 201, headers: { 'Content-Length': '0' } });
}

/*
 * Point d'entrée.
 */

/**
 * Traite une requête sur `/dav`. Le proxy se contente de router vers ici.
 *
 * Rien ne s'échappe : une exception non prévue (le système de fichiers a bien
 * d'autres codes d'erreur que `EEXIST`) rejetterait la promesse dans le proxy,
 * qui n'a aucun moyen d'en faire une réponse WebDAV. Elle devient ici un 500
 * générique — le détail va au log serveur, sans le chemin demandé : c'est
 * souvent lui la cause de l'erreur, et il est fourni par le client.
 */
export async function handleDavRequest(request: Request, deps: DavDeps): Promise<Response> {
  try {
    return await dispatch(request, deps);
  } catch (error) {
    console.error(`[dav] ${request.method} : erreur inattendue.`, error);
    return text(500, 'Erreur interne du point de dépôt.');
  }
}

/**
 * L'ordre compte : l'absence d'identifiants configurés (503) prime sur
 * l'authentification, qui prime sur la méthode. Aucune méthode, pas même
 * `OPTIONS`, ne répond quoi que ce soit d'utile sans authentification.
 */
async function dispatch(request: Request, deps: DavDeps): Promise<Response> {
  if (deps.credentials === null) {
    return text(
      503,
      'Point de dépôt WebDAV non configuré : renseigner WEBDAV_USERNAME et WEBDAV_PASSWORD.',
    );
  }

  if (!isAuthorized(request.headers.get('authorization'), deps.credentials)) {
    return text(401, 'Authentification requise.', {
      'WWW-Authenticate': 'Basic realm="Trainarr", charset="UTF-8"',
    });
  }

  const { pathname } = new URL(request.url);

  switch (request.method) {
    case 'OPTIONS':
      return handleOptions();
    case 'PROPFIND':
      return handlePropfind(pathname);
    // Rien n'est créé : la boîte est plate. Répondre 201 laisse les clients qui
    // rangent par date poursuivre leur envoi, et l'appel reste idempotent.
    case 'MKCOL':
      return new Response(null, { status: 201, headers: { 'Content-Length': '0' } });
    // Dépôt en écriture seule : ce qui est déposé ne se relit pas.
    case 'HEAD':
      return new Response(null, { status: 404 });
    case 'GET':
      return text(404, 'Introuvable.');
    case 'PUT':
      return handlePut(request, pathname, deps);
    default:
      return text(405, 'Méthode non supportée.', { Allow: ALLOWED_METHODS });
  }
}

/*
 * Implémentation réelle du système de fichiers.
 */

/**
 * Le corps de la requête, morceau par morceau, en comptant les octets au
 * passage. Générateur plutôt que `Readable.fromWeb` : les deux types
 * `ReadableStream` (DOM et `node:stream/web`) ne sont pas interchangeables pour
 * TypeScript, et `pipeline` accepte tout itérable asynchrone comme source.
 */
async function* readChunks(
  body: ReadableStream<Uint8Array>,
  counter: { bytes: number },
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      counter.bytes += value.byteLength;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export const nodeDavFileSystem: DavFileSystem = {
  async ensureDir(path) {
    await mkdir(path, { recursive: true });
  },

  async exists(path) {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },

  async createExclusive(path) {
    try {
      // `wx` : création atomique, qui échoue si le chemin existe déjà.
      const handle = await open(path, 'wx');
      await handle.close();
      return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false;
      throw error;
    }
  },

  async writeStream(path, body) {
    const counter = { bytes: 0 };
    // `r+` et non `w` : le fichier a été créé par `createExclusive`, on écrit
    // dans la réservation plutôt que d'en ouvrir une nouvelle. `pipeline` gère
    // la contre-pression et détruit la destination si la source échoue.
    await pipeline(readChunks(body, counter), createWriteStream(path, { flags: 'r+' }));
    return counter.bytes;
  },

  async rename(from, to) {
    await rename(from, to);
  },

  async remove(path) {
    await rm(path, { force: true });
  },
};
