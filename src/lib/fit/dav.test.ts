import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DAV_BASE_PATH,
  checkContentLength,
  decodeBasicAuth,
  handleDavRequest,
  isAuthorized,
  nameWithSuffix,
  nodeDavFileSystem,
  resolveUploadName,
  type DavDeps,
} from './dav';
import { MAX_FIT_FILE_BYTES } from './limits';

const CREDENTIALS = { username: 'gwen', password: 'un-mot-de-passe-long' };

function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

/** Requête authentifiée par défaut — les tests d'auth passent leurs propres en-têtes. */
function davRequest(
  method: string,
  path: string,
  init: { headers?: Record<string, string>; body?: Uint8Array; auth?: boolean } = {},
): Request {
  const headers = new Headers();
  if (init.auth !== false) {
    headers.set('authorization', basicHeader(CREDENTIALS.username, CREDENTIALS.password));
  }
  if (init.body !== undefined) {
    headers.set('content-length', String(init.body.byteLength));
  }
  // En dernier : un test qui pose explicitement un en-tête (Content-Length
  // mensonger, mauvais identifiants) doit l'emporter sur les valeurs déduites.
  for (const [name, value] of Object.entries(init.headers ?? {})) {
    headers.set(name, value);
  }

  return new Request(`http://trainarr.test${path}`, {
    method,
    headers,
    ...(init.body === undefined
      ? {}
      : // `duplex` est exigé par undici dès qu'un corps accompagne la requête.
        { body: init.body, duplex: 'half' }),
  } as RequestInit);
}

describe('decodeBasicAuth', () => {
  it('décode un en-tête Basic valide', () => {
    expect(decodeBasicAuth(basicHeader('gwen', 'secret'))).toEqual({
      username: 'gwen',
      password: 'secret',
    });
  });

  it("accepte le nom du schéma quelle que soit sa casse (RFC 7617)", () => {
    expect(decodeBasicAuth(`bAsIc ${Buffer.from('a:b').toString('base64')}`)).toEqual({
      username: 'a',
      password: 'b',
    });
  });

  it('conserve les deux-points du mot de passe', () => {
    expect(decodeBasicAuth(basicHeader('gwen', 'a:b:c'))?.password).toBe('a:b:c');
  });

  it('rejette un en-tête absent, non Basic, non base64 ou sans séparateur', () => {
    expect(decodeBasicAuth(null)).toBeNull();
    expect(decodeBasicAuth('Bearer abcdef')).toBeNull();
    expect(decodeBasicAuth('Basic ***')).toBeNull();
    expect(decodeBasicAuth(`Basic ${Buffer.from('sansdeuxpoints').toString('base64')}`)).toBeNull();
  });
});

describe('isAuthorized', () => {
  it('accepte les bons identifiants', () => {
    expect(isAuthorized(basicHeader('gwen', 'un-mot-de-passe-long'), CREDENTIALS)).toBe(true);
  });

  it('refuse un mauvais mot de passe, un mauvais nom, un préfixe du secret', () => {
    expect(isAuthorized(basicHeader('gwen', 'mauvais'), CREDENTIALS)).toBe(false);
    expect(isAuthorized(basicHeader('autre', 'un-mot-de-passe-long'), CREDENTIALS)).toBe(false);
    expect(isAuthorized(basicHeader('gwen', 'un-mot-de-passe-lon'), CREDENTIALS)).toBe(false);
    expect(isAuthorized(null, CREDENTIALS)).toBe(false);
  });

  it('compare en temps constant : le hachage préalable égalise les longueurs', () => {
    // Le vrai garde-fou est `timingSafeEqual` sur deux SHA-256 : quelle que soit
    // la longueur fournie, la comparaison porte sur 32 octets. On vérifie ici
    // qu'aucune longueur ne provoque d'exception (le cas qui trahirait un
    // `timingSafeEqual` appelé sur des tampons de tailles différentes).
    for (const password of ['', 'a', 'a'.repeat(10_000)]) {
      expect(isAuthorized(basicHeader('gwen', password), CREDENTIALS)).toBe(false);
    }
  });
});

describe('resolveUploadName', () => {
  it('retient le nom du dernier segment', () => {
    expect(resolveUploadName('/dav/2026-08-10-Course.fit')).toEqual({
      ok: true,
      name: '2026-08-10-Course.fit',
    });
  });

  it('accepte une extension en majuscules', () => {
    expect(resolveUploadName('/dav/COURSE.FIT')).toEqual({ ok: true, name: 'COURSE.FIT' });
  });

  it('décode le pourcentage-encodage des noms lisibles', () => {
    expect(resolveUploadName('/dav/Sortie%20longue.fit')).toEqual({
      ok: true,
      name: 'Sortie longue.fit',
    });
  });

  it('aplatit les sous-dossiers : seul le dernier segment compte', () => {
    // Certains clients rangent par date (MKCOL) ; tout atterrit à plat.
    expect(resolveUploadName('/dav/2026-08-10/run.fit')).toEqual({ ok: true, name: 'run.fit' });
  });

  it('rejette les séparateurs de chemin encodés', () => {
    expect(resolveUploadName('/dav/..%2Fx.fit')).toMatchObject({ ok: false, status: 400 });
    expect(resolveUploadName('/dav/a%2Fb.fit')).toMatchObject({ ok: false, status: 400 });
    expect(resolveUploadName('/dav/a%5Cb.fit')).toMatchObject({ ok: false, status: 400 });
  });

  it('rejette les caractères de contrôle, NUL compris', () => {
    expect(resolveUploadName('/dav/nul%00.fit')).toMatchObject({ ok: false, status: 400 });
    expect(resolveUploadName('/dav/saut%0Aligne.fit')).toMatchObject({ ok: false, status: 400 });
  });

  it('rejette un nom vide ou réduit à des espaces', () => {
    expect(resolveUploadName('/dav/')).toMatchObject({ ok: false, status: 400 });
    expect(resolveUploadName('/dav')).toMatchObject({ ok: false, status: 415 });
    expect(resolveUploadName('/dav/%20%20')).toMatchObject({ ok: false, status: 400 });
  });

  it('rejette « . », « .. » et un encodage malformé', () => {
    expect(resolveUploadName('/dav/.')).toMatchObject({ ok: false, status: 400 });
    expect(resolveUploadName('/dav/..')).toMatchObject({ ok: false, status: 400 });
    expect(resolveUploadName('/dav/%zz.fit')).toMatchObject({ ok: false, status: 400 });
  });

  it('rejette un nom démesuré', () => {
    expect(resolveUploadName(`/dav/${'a'.repeat(300)}.fit`)).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it('mesure la longueur en octets, pas en unités UTF-16', () => {
    // 196 « é » + « .fit » : 200 unités UTF-16 (donc « court » pour String.length)
    // mais 396 octets en UTF-8, bien au-delà des 255 octets d'un nom de fichier.
    // Sans ce contrôle, l'appel système partait en ENAMETOOLONG.
    expect(resolveUploadName(`/dav/${'é'.repeat(196)}.fit`)).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it('accepte un nom accentué qui tient dans la limite en octets', () => {
    expect(resolveUploadName('/dav/S%C3%A9ance%20d%27%C3%A9t%C3%A9.fit')).toEqual({
      ok: true,
      name: "Séance d'été.fit",
    });
  });

  it('refuse une autre extension avec 415', () => {
    expect(resolveUploadName('/dav/notes.txt')).toMatchObject({ ok: false, status: 415 });
    expect(resolveUploadName('/dav/fit')).toMatchObject({ ok: false, status: 415 });
  });

  it('refuse un nom réduit à l’extension', () => {
    // `.fit` seul est un nom valide pour le système de fichiers mais pas pour le
    // watcher : son suffixe de collision produirait `.fit-1`, jamais rescanné.
    expect(resolveUploadName('/dav/.fit')).toMatchObject({ ok: false, status: 400 });
    expect(resolveUploadName('/dav/.FIT')).toMatchObject({ ok: false, status: 400 });
    expect(resolveUploadName('/dav/a.fit')).toEqual({ ok: true, name: 'a.fit' });
  });
});

describe('nameWithSuffix', () => {
  it('insère le suffixe avant l’extension', () => {
    expect(nameWithSuffix('run.fit', 2)).toBe('run-2.fit');
    expect(nameWithSuffix('a.b.fit', 1)).toBe('a.b-1.fit');
  });

  it('verrouille la forme du nom suffixé : « radical-N.fit », jamais « nom.fit-N »', () => {
    // Un `x.fit-1` porterait la bonne donnée sous une extension que le watcher
    // ignore : le fichier serait perdu sans le moindre message d'erreur.
    expect(nameWithSuffix('x.fit', 1)).toBe('x-1.fit');
    expect(nameWithSuffix('x.fit', 2)).toBe('x-2.fit');
  });
});

describe('checkContentLength', () => {
  it('accepte une taille plausible', () => {
    expect(checkContentLength('1024')).toEqual({ ok: true, length: 1024 });
    expect(checkContentLength(String(MAX_FIT_FILE_BYTES))).toEqual({
      ok: true,
      length: MAX_FIT_FILE_BYTES,
    });
  });

  it('exige l’en-tête : 411 s’il manque', () => {
    expect(checkContentLength(null)).toMatchObject({ ok: false, status: 411 });
    expect(checkContentLength('  ')).toMatchObject({ ok: false, status: 411 });
  });

  it('refuse une taille hors gabarit avec 413', () => {
    expect(checkContentLength(String(MAX_FIT_FILE_BYTES + 1))).toMatchObject({
      ok: false,
      status: 413,
    });
  });

  it('refuse un en-tête non numérique et un fichier vide avec 400', () => {
    expect(checkContentLength('abc')).toMatchObject({ ok: false, status: 400 });
    expect(checkContentLength('-1')).toMatchObject({ ok: false, status: 400 });
    expect(checkContentLength('0')).toMatchObject({ ok: false, status: 400 });
  });
});

describe('handleDavRequest', () => {
  let inboxDir: string;
  let deps: DavDeps;

  beforeEach(async () => {
    inboxDir = await mkdtemp(join(tmpdir(), 'trainarr-dav-'));
    deps = { credentials: CREDENTIALS, inboxDir, fs: nodeDavFileSystem };
  });

  afterEach(async () => {
    await rm(inboxDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('authentification', () => {
    it('répond 503 tant que les identifiants ne sont pas configurés', async () => {
      const response = await handleDavRequest(davRequest('OPTIONS', DAV_BASE_PATH), {
        ...deps,
        credentials: null,
      });

      expect(response.status).toBe(503);
      // Surtout pas un 401 : un dépôt non configuré n'est pas un dépôt ouvert.
      expect(response.headers.get('www-authenticate')).toBeNull();
    });

    it('répond 401 avec un challenge Basic sans en-tête', async () => {
      const response = await handleDavRequest(
        davRequest('PROPFIND', DAV_BASE_PATH, { auth: false }),
        deps,
      );

      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('Basic realm="Trainarr"');
    });

    it('répond 401 sur de mauvais identifiants, quelle que soit la méthode', async () => {
      for (const method of ['OPTIONS', 'PROPFIND', 'MKCOL', 'PUT', 'HEAD', 'GET', 'DELETE']) {
        const response = await handleDavRequest(
          davRequest(method, `${DAV_BASE_PATH}/x.fit`, {
            auth: false,
            headers: { authorization: basicHeader('gwen', 'mauvais') },
          }),
          deps,
        );
        expect(response.status).toBe(401);
      }
    });

    it("n'écrit rien quand l'authentification échoue", async () => {
      await handleDavRequest(
        davRequest('PUT', `${DAV_BASE_PATH}/run.fit`, { auth: false, body: new Uint8Array([1]) }),
        deps,
      );

      expect(await readdir(inboxDir)).toEqual([]);
    });
  });

  describe('méthodes', () => {
    it('OPTIONS annonce le niveau DAV et les méthodes supportées', async () => {
      const response = await handleDavRequest(davRequest('OPTIONS', DAV_BASE_PATH), deps);

      expect(response.status).toBe(200);
      expect(response.headers.get('dav')).toBe('1');
      expect(response.headers.get('allow')).toBe('OPTIONS, PROPFIND, PUT, MKCOL, HEAD');
    });

    it('PROPFIND répond 207 avec une collection vide', async () => {
      await writeFile(join(inboxDir, 'secret-course.fit'), 'x');

      const response = await handleDavRequest(
        davRequest('PROPFIND', DAV_BASE_PATH, { headers: { depth: '1' } }),
        deps,
      );
      const body = await response.text();

      expect(response.status).toBe(207);
      expect(response.headers.get('content-type')).toContain('application/xml');
      expect(body).toContain('<D:collection/>');
      expect(body).toContain('<D:href>/dav/</D:href>');
      // Rien du contenu réel de la boîte ne doit fuiter, Depth ou pas.
      expect(body).not.toContain('secret-course.fit');
    });

    it('PROPFIND répond 207 sur un sous-chemin inexistant', async () => {
      const response = await handleDavRequest(
        davRequest('PROPFIND', `${DAV_BASE_PATH}/2026-08-10/`),
        deps,
      );

      expect(response.status).toBe(207);
      expect(await response.text()).toContain('<D:href>/dav/2026-08-10/</D:href>');
    });

    it('MKCOL répond 201 sans rien créer', async () => {
      const response = await handleDavRequest(davRequest('MKCOL', `${DAV_BASE_PATH}/2026`), deps);

      expect(response.status).toBe(201);
      expect(await readdir(inboxDir)).toEqual([]);
    });

    it('HEAD et GET répondent 404 : le dépôt est en écriture seule', async () => {
      await writeFile(join(inboxDir, 'run.fit'), 'x');

      const head = await handleDavRequest(davRequest('HEAD', `${DAV_BASE_PATH}/run.fit`), deps);
      const get = await handleDavRequest(davRequest('GET', `${DAV_BASE_PATH}/run.fit`), deps);

      expect(head.status).toBe(404);
      expect(get.status).toBe(404);
      expect(await get.text()).not.toContain('run.fit');
    });

    it('refuse toute autre méthode avec 405 et un en-tête Allow', async () => {
      for (const method of ['DELETE', 'MOVE', 'COPY', 'LOCK', 'POST', 'PROPPATCH']) {
        const response = await handleDavRequest(
          davRequest(method, `${DAV_BASE_PATH}/run.fit`),
          deps,
        );
        expect(response.status).toBe(405);
        expect(response.headers.get('allow')).toContain('PUT');
      }
    });
  });

  describe('PUT', () => {
    const content = new Uint8Array([0x0e, 0x10, 0x2a, 0x00, 0x2e, 0x46, 0x49, 0x54]);

    it('écrit le fichier dans la boîte de dépôt et répond 201', async () => {
      const response = await handleDavRequest(
        davRequest('PUT', `${DAV_BASE_PATH}/2026-08-10-Course.fit`, { body: content }),
        deps,
      );

      expect(response.status).toBe(201);
      expect(await readdir(inboxDir)).toEqual(['2026-08-10-Course.fit']);
      expect(new Uint8Array(await readFile(join(inboxDir, '2026-08-10-Course.fit')))).toEqual(
        content,
      );
    });

    it('crée le répertoire de dépôt s’il n’existe pas encore', async () => {
      const nested = join(inboxDir, 'a', 'b');

      const response = await handleDavRequest(
        davRequest('PUT', `${DAV_BASE_PATH}/run.fit`, { body: content }),
        { ...deps, inboxDir: nested },
      );

      expect(response.status).toBe(201);
      expect(await readdir(nested)).toEqual(['run.fit']);
    });

    it('ne laisse aucun fichier temporaire derrière lui', async () => {
      await handleDavRequest(
        davRequest('PUT', `${DAV_BASE_PATH}/run.fit`, { body: content }),
        deps,
      );

      expect((await readdir(inboxDir)).filter((name) => name.endsWith('.part'))).toEqual([]);
    });

    it('accepte un sous-chemin et dépose à plat', async () => {
      const response = await handleDavRequest(
        davRequest('PUT', `${DAV_BASE_PATH}/2026-08-10/run.fit`, { body: content }),
        deps,
      );

      expect(response.status).toBe(201);
      expect(await readdir(inboxDir)).toEqual(['run.fit']);
    });

    it('suffixe en cas de collision, sans jamais écraser', async () => {
      await writeFile(join(inboxDir, 'run.fit'), 'original');
      await handleDavRequest(davRequest('PUT', `${DAV_BASE_PATH}/run.fit`, { body: content }), deps);
      await handleDavRequest(davRequest('PUT', `${DAV_BASE_PATH}/run.fit`, { body: content }), deps);

      expect((await readdir(inboxDir)).sort()).toEqual(['run-1.fit', 'run-2.fit', 'run.fit']);
      expect(await readFile(join(inboxDir, 'run.fit'), 'utf8')).toBe('original');
    });

    it('refuse un Content-Length absent avec 411, sans rien écrire', async () => {
      // `davRequest` ne pose l'en-tête que s'il y a un corps : ici, aucun.
      const response = await handleDavRequest(
        davRequest('PUT', `${DAV_BASE_PATH}/run.fit`),
        deps,
      );

      expect(response.status).toBe(411);
      expect(await readdir(inboxDir)).toEqual([]);
    });

    it('refuse un Content-Length hors gabarit avec 413, sans lire le corps', async () => {
      const response = await handleDavRequest(
        davRequest('PUT', `${DAV_BASE_PATH}/run.fit`, {
          body: content,
          headers: { 'content-length': String(MAX_FIT_FILE_BYTES + 1) },
        }),
        deps,
      );

      expect(response.status).toBe(413);
      expect(await readdir(inboxDir)).toEqual([]);
    });

    it('refuse les noms hostiles sans rien écrire', async () => {
      for (const path of ['/dav/..%2Fx.fit', '/dav/a%2Fb.fit', '/dav/nul%00.fit', '/dav/']) {
        const response = await handleDavRequest(davRequest('PUT', path, { body: content }), deps);
        expect(response.status).toBe(400);
      }

      const wrongType = await handleDavRequest(
        davRequest('PUT', `${DAV_BASE_PATH}/run.txt`, { body: content }),
        deps,
      );
      expect(wrongType.status).toBe(415);

      expect(await readdir(inboxDir)).toEqual([]);
    });

    it('refuse un corps tronqué et supprime le fichier temporaire', async () => {
      // Cas réel : Next tronque silencieusement au-delà de proxyClientMaxBodySize.
      const response = await handleDavRequest(
        davRequest('PUT', `${DAV_BASE_PATH}/run.fit`, {
          body: content,
          headers: { 'content-length': String(content.byteLength + 10) },
        }),
        deps,
      );

      expect(response.status).toBe(400);
      expect(await readdir(inboxDir)).toEqual([]);
    });

    it('répond 500 et nettoie si l’écriture échoue', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const failingFs = {
        ...nodeDavFileSystem,
        writeStream: () => Promise.reject(new Error('disque plein')),
      };

      const response = await handleDavRequest(
        davRequest('PUT', `${DAV_BASE_PATH}/run.fit`, { body: content }),
        { ...deps, fs: failingFs },
      );

      expect(response.status).toBe(500);
      expect(await readdir(inboxDir)).toEqual([]);
    });

    it('répond 500 plutôt que de rejeter quand la réservation du nom échoue', async () => {
      // ENAMETOOLONG, EACCES, ENOSPC : ces erreurs-là surviennent à l'ouverture,
      // hors du try/catch de l'écriture. Sans garde-fou global, la promesse
      // rejetait dans le proxy au lieu de produire une réponse.
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      const tooLong = Object.assign(new Error('name too long'), { code: 'ENAMETOOLONG' });
      const failingFs = {
        ...nodeDavFileSystem,
        createExclusive: () => Promise.reject(tooLong),
      };

      const response = await handleDavRequest(
        davRequest('PUT', `${DAV_BASE_PATH}/run.fit`, { body: content }),
        { ...deps, fs: failingFs },
      );

      expect(response.status).toBe(500);
      expect(await readdir(inboxDir)).toEqual([]);
      // Le nom peut être la cause même de l'erreur : il ne part pas dans le log.
      expect(errorLog).toHaveBeenCalled();
      expect(String(errorLog.mock.calls[0]?.[0])).not.toContain('run.fit');
    });

    it('répond 500 plutôt que de rejeter quand la création du répertoire échoue', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const failingFs = {
        ...nodeDavFileSystem,
        ensureDir: () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })),
      };

      const response = await handleDavRequest(
        davRequest('PUT', `${DAV_BASE_PATH}/run.fit`, { body: content }),
        { ...deps, fs: failingFs },
      );

      expect(response.status).toBe(500);
    });

    it('supprime le fichier temporaire quand le renommage final échoue', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const failingFs = {
        ...nodeDavFileSystem,
        rename: () => Promise.reject(Object.assign(new Error('cross-device'), { code: 'EXDEV' })),
      };

      const response = await handleDavRequest(
        davRequest('PUT', `${DAV_BASE_PATH}/run.fit`, { body: content }),
        { ...deps, fs: failingFs },
      );

      expect(response.status).toBe(500);
      // Un `.part` abandonné condamnerait le nom canonique jusqu'au balayage.
      expect(await readdir(inboxDir)).toEqual([]);
    });

    it('répond 409 quand aucune variante de nom n’est libre', async () => {
      const alwaysTaken = { ...nodeDavFileSystem, exists: () => Promise.resolve(true) };

      const response = await handleDavRequest(
        davRequest('PUT', `${DAV_BASE_PATH}/run.fit`, { body: content }),
        { ...deps, fs: alwaysTaken },
      );

      expect(response.status).toBe(409);
    });
  });
});
