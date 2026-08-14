import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_FIT_UPLOAD_BYTES, fitUploadResponseSchema } from '../_lib/upload-contract';

// La route importe l'ingestion, qui est `server-only` et parle au DAL.
vi.mock('server-only', () => ({}));

const { ingest, getCurrentAthleteId, getSession } = vi.hoisted(() => ({
  ingest: vi.fn(),
  getCurrentAthleteId: vi.fn(),
  /** La vraie lecture est éprouvée dans `src/data/session.test.ts`. */
  getSession: vi.fn(),
}));
vi.mock('@/lib/fit/ingest', () => ({ ingestFitBuffer: ingest }));
vi.mock('@/data/athlete', () => ({ getCurrentAthleteId }));
vi.mock('@/data/session', () => ({ getSession }));

const { POST } = await import('./route');

const ENDPOINT = 'http://localhost/api/fit/upload';

/** Requête multipart minimale, à laquelle on impose la taille annoncée. */
function uploadRequest(announcedBytes: number): NextRequest {
  const body = new FormData();
  body.append('files', new File(['fit'], 'sortie.fit'));

  return new NextRequest(ENDPOINT, {
    method: 'POST',
    headers: { 'content-length': String(announcedBytes) },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ingest.mockResolvedValue({ status: 'created', activityId: 42 });
  getCurrentAthleteId.mockResolvedValue(7);
  getSession.mockResolvedValue({ userId: 'user-1', name: 'Gwen', email: 'gwen@trainarr.test' });
});

describe('POST /api/fit/upload — session', () => {
  it('refuse sans session, sans lire le corps ni la base', async () => {
    getSession.mockResolvedValue(null);
    const request = uploadRequest(4_096);
    const formData = vi.spyOn(request, 'formData');

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(formData).not.toHaveBeenCalled();
    expect(getCurrentAthleteId).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it('rend le refus dans le format du contrat, pour qu’il s’affiche', async () => {
    getSession.mockResolvedValue(null);

    const parsed = fitUploadResponseSchema.safeParse(await (await POST(uploadRequest(4_096))).json());

    expect(parsed.success).toBe(true);
    expect(parsed.data?.results[0]).toMatchObject({ ok: false });
  });
});

describe('POST /api/fit/upload — borne de taille', () => {
  it('refuse un envoi démesuré sans jamais lire le corps', async () => {
    const request = uploadRequest(2 * 1024 * 1024 * 1024);
    // `formData()` matérialise tout le multipart en mémoire : le rejet doit
    // intervenir avant, sinon les 2 Go sont bufferisés puis poliment refusés.
    const formData = vi.spyOn(request, 'formData');

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(formData).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it('rend un rapport conforme au contrat, motif compris', async () => {
    const response = await POST(uploadRequest(MAX_FIT_UPLOAD_BYTES + 1));
    const parsed = fitUploadResponseSchema.safeParse(await response.json());

    expect(parsed.success).toBe(true);
    expect(parsed.data?.results[0]).toMatchObject({ ok: false });
  });

  it('laisse passer un envoi de taille normale', async () => {
    const response = await POST(uploadRequest(4_096));

    expect(response.status).toBe(200);
    expect(ingest).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/fit/upload — propriétaire de l’import', () => {
  it('rattache les activités à l’athlète de la session', async () => {
    // C'est cette route, et elle seule, qui sait à qui appartiennent ces
    // fichiers : elle a une session. L'ingestion, elle, ne devine plus rien.
    await POST(uploadRequest(4_096));

    expect(ingest).toHaveBeenCalledWith(expect.any(Buffer), 7);
  });

  it('n’importe rien quand la session n’a pas d’athlète, et le dit', async () => {
    getCurrentAthleteId.mockResolvedValue(null);

    const response = await POST(uploadRequest(4_096));
    const parsed = fitUploadResponseSchema.safeParse(await response.json());

    expect(response.status).toBe(409);
    expect(ingest).not.toHaveBeenCalled();
    expect(parsed.success).toBe(true);
    expect(parsed.data?.results[0]).toMatchObject({ name: 'sortie.fit', ok: false });
  });
});
