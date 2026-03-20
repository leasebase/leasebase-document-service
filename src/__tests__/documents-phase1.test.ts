/**
 * Phase 1 document-service tests
 *
 * Covers:
 *   - POST /upload-url (owner, auth, validation)
 *   - POST /upload-complete (owner, version link)
 *   - POST /:id/mark-verified-external (idempotency, transitions, orchestration trigger)
 *   - GET /lease/:leaseId/execution-status
 *   - PATCH /:id (metadata update, restricted transitions)
 *   - DELETE /:id (soft archive)
 *   - GET / with category / status filters
 *   - Backward compat: /upload and /:id/confirm still normalize statuses
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const { mockQuery, mockQueryOne, mockFetch, activeUser } = vi.hoisted(() => ({
  mockQuery:    vi.fn(),
  mockQueryOne: vi.fn(),
  mockFetch:    vi.fn(),
  activeUser:   { current: null as any },
}));

vi.stubGlobal('fetch', mockFetch);

vi.mock('@leasebase/service-common', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@leasebase/service-common')>();
  return {
    ...mod,
    query:    mockQuery,
    queryOne: mockQueryOne,
    requireAuth: (req: any, _res: any, next: any) => {
      if (!activeUser.current) return next(new mod.UnauthorizedError());
      req.user = { ...activeUser.current };
      next();
    },
  };
});

// Stub AWS SDK presign functions — they will throw if S3_BUCKET is set but
// S3 is unavailable; in tests S3_BUCKET is unset so the placeholder path is taken.
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({})),
  PutObjectCommand: vi.fn(),
  GetObjectCommand: vi.fn(),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://presigned.example.com/put-url'),
}));

import express from 'express';
import { documentsRouter } from '../routes/documents';

/* ── HTTP helper ── */

function reqWithBody(
  port: number,
  method: string,
  path: string,
  body?: any,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: '127.0.0.1', port, path, method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
          ...extraHeaders,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode!, body: raw }); }
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const owner = (overrides: Record<string, any> = {}) => ({
  sub: 'o1', userId: 'o1', orgId: 'org-1', email: 'o@t.com',
  role: 'OWNER', name: 'Owner', scopes: ['api/read', 'api/write'], ...overrides,
});

const sampleDoc = {
  id: 'doc-1', organization_id: 'org-1', category: 'LEASE_AGREEMENT',
  status: 'UPLOADED', related_type: 'LEASE', related_id: 'lease-1',
  title: 'Lease Agreement', description: null,
  current_version_id: null, created_by_user_id: 'o1',
  created_at: '2024-01-01', updated_at: '2024-01-01', archived_at: null,
};

const sampleVersion = {
  id: 'ver-1', document_id: 'doc-1', version_number: 1,
  storage_bucket: 'test-bucket', storage_key: 'org-1/LEASE/lease-1/file.pdf',
  file_name: 'file.pdf', original_file_name: 'file.pdf',
  mime_type: 'application/pdf', uploaded_by_user_id: 'o1',
  created_at: '2024-01-01',
};

let server: http.Server;
let port: number;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/d', documentsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode || 500).json({ error: { code: err.code, message: err.message } });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; resolve(); });
  });
});
afterAll(() => server?.close());
beforeEach(() => {
  mockQuery.mockReset();
  mockQueryOne.mockReset();
  mockFetch.mockReset();
  activeUser.current = null;
});

// ════════════════════════════════════════════════════════════════════════════
// POST /upload-url
// ════════════════════════════════════════════════════════════════════════════

describe('POST /upload-url', () => {
  const validBody = {
    relatedType: 'LEASE', relatedId: 'lease-1', category: 'LEASE_AGREEMENT',
    title: 'Lease Agreement', fileName: 'lease.pdf', mimeType: 'application/pdf',
  };

  it('creates document + version and returns uploadUrl for OWNER', async () => {
    activeUser.current = owner();
    mockQueryOne
      .mockResolvedValueOnce({ ...sampleDoc, id: 'doc-new', status: 'DRAFT' }) // INSERT doc
      .mockResolvedValueOnce(sampleVersion);                                     // INSERT version

    const res = await reqWithBody(port, 'POST', '/d/upload-url', validBody);
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe('doc-new');
    expect(res.body.uploadUrl).toBeDefined();
    expect(res.body.version).toBeDefined();
  });

  it('inserts DRAFT status (not UPLOADED) on creation', async () => {
    activeUser.current = owner();
    mockQueryOne
      .mockResolvedValueOnce({ ...sampleDoc, id: 'doc-x', status: 'DRAFT' })
      .mockResolvedValueOnce(sampleVersion);

    await reqWithBody(port, 'POST', '/d/upload-url', validBody);

    const insertSql = mockQueryOne.mock.calls[0][0] as string;
    expect(insertSql).toContain("'DRAFT'");
  });

  it('rejects TENANT role', async () => {
    activeUser.current = owner({ role: 'TENANT' });
    const res = await reqWithBody(port, 'POST', '/d/upload-url', validBody);
    expect(res.status).toBe(403);
  });

  it('rejects missing title', async () => {
    activeUser.current = owner();
    const res = await reqWithBody(port, 'POST', '/d/upload-url', { ...validBody, title: '' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects invalid category', async () => {
    activeUser.current = owner();
    const res = await reqWithBody(port, 'POST', '/d/upload-url', { ...validBody, category: 'INVALID' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('requires auth', async () => {
    const res = await reqWithBody(port, 'POST', '/d/upload-url', validBody);
    expect(res.status).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /upload-complete
// ════════════════════════════════════════════════════════════════════════════

describe('POST /upload-complete', () => {
  it('marks document UPLOADED and sets current_version_id', async () => {
    activeUser.current = owner();
    mockQueryOne
      .mockResolvedValueOnce(sampleDoc)                                 // doc lookup
      .mockResolvedValueOnce(sampleVersion)                             // version lookup
      .mockResolvedValueOnce(null)                                      // size/sha256 update (optional)
      .mockResolvedValueOnce({ ...sampleDoc, status: 'UPLOADED', current_version_id: 'ver-1' }) // UPDATE doc
      .mockResolvedValueOnce(null);                                     // audit INSERT

    const res = await reqWithBody(port, 'POST', '/d/upload-complete', {
      documentId: 'doc-1', versionId: 'ver-1',
    });
    expect(res.status).toBe(200);

    // The UPDATE SQL should set status='UPLOADED'
    const updateSql = mockQueryOne.mock.calls.find(
      (c) => (c[0] as string).includes('UPLOADED'),
    );
    expect(updateSql).toBeDefined();
  });

  it('returns 404 if document not found in org', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await reqWithBody(port, 'POST', '/d/upload-complete', {
      documentId: 'doc-999', versionId: 'ver-1',
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 if version does not belong to document', async () => {
    activeUser.current = owner();
    mockQueryOne
      .mockResolvedValueOnce(sampleDoc) // doc found
      .mockResolvedValueOnce(null);     // version not found
    const res = await reqWithBody(port, 'POST', '/d/upload-complete', {
      documentId: 'doc-1', versionId: 'ver-wrong',
    });
    expect(res.status).toBe(404);
  });

  it('requires OWNER role', async () => {
    activeUser.current = owner({ role: 'TENANT' });
    const res = await reqWithBody(port, 'POST', '/d/upload-complete', {
      documentId: 'doc-1', versionId: 'ver-1',
    });
    expect(res.status).toBe(403);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /:id/mark-verified-external
// ════════════════════════════════════════════════════════════════════════════

describe('POST /:id/mark-verified-external', () => {
  it('marks UPLOADED LEASE_AGREEMENT as VERIFIED_EXTERNAL and triggers activation', async () => {
    activeUser.current = owner();
    mockQueryOne
      .mockResolvedValueOnce({ ...sampleDoc, status: 'UPLOADED', category: 'LEASE_AGREEMENT' })
      .mockResolvedValueOnce({ ...sampleDoc, status: 'VERIFIED_EXTERNAL' }) // UPDATE
      .mockResolvedValueOnce(null); // audit INSERT

    mockFetch.mockResolvedValueOnce({ ok: true } as any);

    const res = await reqWithBody(port, 'POST', '/d/doc-1/mark-verified-external');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('VERIFIED_EXTERNAL');

    // Verify fetch was called with activate-from-document URL
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).toContain('activate-from-document');
    expect(fetchUrl).toContain('lease-1');
  });

  it('is idempotent when already VERIFIED_EXTERNAL', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce({ ...sampleDoc, status: 'VERIFIED_EXTERNAL', category: 'LEASE_AGREEMENT' });

    const res = await reqWithBody(port, 'POST', '/d/doc-1/mark-verified-external');
    expect(res.status).toBe(200);
    expect(res.body.alreadyVerified).toBe(true);
    // No UPDATE should have been issued
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    // No fetch call for activation (already verified)
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does NOT trigger activation for non-LEASE_AGREEMENT documents', async () => {
    activeUser.current = owner();
    mockQueryOne
      .mockResolvedValueOnce({ ...sampleDoc, status: 'UPLOADED', category: 'OWNER_UPLOAD' })
      .mockResolvedValueOnce({ ...sampleDoc, status: 'VERIFIED_EXTERNAL' })
      .mockResolvedValueOnce(null);

    const res = await reqWithBody(port, 'POST', '/d/doc-1/mark-verified-external');
    expect(res.status).toBe(200);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 400 when document is in FULLY_EXECUTED status', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce({ ...sampleDoc, status: 'FULLY_EXECUTED', category: 'LEASE_AGREEMENT' });

    const res = await reqWithBody(port, 'POST', '/d/doc-1/mark-verified-external');
    expect(res.status).toBe(400);
  });

  it('returns 404 when document not found in org', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await reqWithBody(port, 'POST', '/d/doc-1/mark-verified-external');
    expect(res.status).toBe(404);
  });

  it('requires OWNER role', async () => {
    activeUser.current = owner({ role: 'TENANT' });
    const res = await reqWithBody(port, 'POST', '/d/doc-1/mark-verified-external');
    expect(res.status).toBe(403);
  });

  it('returns 422 when lease activation fails', async () => {
    activeUser.current = owner();
    mockQueryOne
      .mockResolvedValueOnce({ ...sampleDoc, status: 'UPLOADED', category: 'LEASE_AGREEMENT' })
      .mockResolvedValueOnce({ ...sampleDoc, status: 'VERIFIED_EXTERNAL' })
      .mockResolvedValueOnce(null);

    mockFetch.mockResolvedValueOnce({
      ok: false, status: 422, text: async () => JSON.stringify({ error: { message: 'Lease not acknowledged' } }),
    } as any);

    const res = await reqWithBody(port, 'POST', '/d/doc-1/mark-verified-external');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('LEASE_ACTIVATION_FAILED');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /lease/:leaseId/execution-status
// ════════════════════════════════════════════════════════════════════════════

describe('GET /lease/:leaseId/execution-status', () => {
  it('returns NONE when no LEASE_AGREEMENT document exists', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await reqWithBody(port, 'GET', '/d/lease/lease-1/execution-status');
    expect(res.status).toBe(200);
    expect(res.body.data.executionStatus).toBe('NONE');
    expect(res.body.data.hasLeaseAgreement).toBe(false);
    expect(res.body.data.documentId).toBeNull();
  });

  it('returns VERIFIED_EXTERNAL for a VERIFIED_EXTERNAL document', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce({ id: 'doc-1', status: 'VERIFIED_EXTERNAL' });

    const res = await reqWithBody(port, 'GET', '/d/lease/lease-1/execution-status');
    expect(res.status).toBe(200);
    expect(res.body.data.executionStatus).toBe('VERIFIED_EXTERNAL');
    expect(res.body.data.hasLeaseAgreement).toBe(true);
    expect(res.body.data.documentId).toBe('doc-1');
  });

  it('returns FULLY_EXECUTED for a FULLY_EXECUTED document', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce({ id: 'doc-2', status: 'FULLY_EXECUTED' });

    const res = await reqWithBody(port, 'GET', '/d/lease/lease-1/execution-status');
    expect(res.status).toBe(200);
    expect(res.body.data.executionStatus).toBe('FULLY_EXECUTED');
  });

  it('returns UPLOADED for an UPLOADED document', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce({ id: 'doc-3', status: 'UPLOADED' });

    const res = await reqWithBody(port, 'GET', '/d/lease/lease-1/execution-status');
    expect(res.status).toBe(200);
    expect(res.body.data.executionStatus).toBe('UPLOADED');
  });

  it('queries only category=LEASE_AGREEMENT documents', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce(null);

    await reqWithBody(port, 'GET', '/d/lease/lease-1/execution-status');

    const sql = mockQueryOne.mock.calls[0][0] as string;
    expect(sql).toContain("category = 'LEASE_AGREEMENT'");
    expect(sql).toContain("related_type = 'LEASE'");
  });

  it('requires authentication', async () => {
    const res = await reqWithBody(port, 'GET', '/d/lease/lease-1/execution-status');
    expect(res.status).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH /:id
// ════════════════════════════════════════════════════════════════════════════

describe('PATCH /:id', () => {
  it('updates title and description', async () => {
    activeUser.current = owner();
    mockQueryOne
      .mockResolvedValueOnce(sampleDoc) // lookup
      .mockResolvedValueOnce({ ...sampleDoc, title: 'New Title', description: 'Updated' }); // UPDATE

    const res = await reqWithBody(port, 'PATCH', '/d/doc-1', {
      title: 'New Title', description: 'Updated',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('New Title');
  });

  it('rejects VERIFIED_EXTERNAL as a PATCH status target', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce(sampleDoc);

    const res = await reqWithBody(port, 'PATCH', '/d/doc-1', { status: 'VERIFIED_EXTERNAL' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('allows ARCHIVED as a PATCH status target', async () => {
    activeUser.current = owner();
    mockQueryOne
      .mockResolvedValueOnce(sampleDoc)
      .mockResolvedValueOnce({ ...sampleDoc, status: 'ARCHIVED' });

    const res = await reqWithBody(port, 'PATCH', '/d/doc-1', { status: 'ARCHIVED' });
    expect(res.status).toBe(200);
  });

  it('requires OWNER role', async () => {
    activeUser.current = owner({ role: 'TENANT' });
    const res = await reqWithBody(port, 'PATCH', '/d/doc-1', { title: 'X' });
    expect(res.status).toBe(403);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DELETE /:id (soft archive)
// ════════════════════════════════════════════════════════════════════════════

describe('DELETE /:id', () => {
  it('soft-archives document (sets archived_at, status=ARCHIVED)', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce({ id: 'doc-1' });

    const res = await reqWithBody(port, 'DELETE', '/d/doc-1');
    expect(res.status).toBe(204);

    const sql = mockQueryOne.mock.calls[0][0] as string;
    expect(sql).toContain('ARCHIVED');
    expect(sql).toContain('archived_at');
  });

  it('returns 404 for already-archived document', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await reqWithBody(port, 'DELETE', '/d/doc-1');
    expect(res.status).toBe(404);
  });

  it('requires OWNER role', async () => {
    activeUser.current = owner({ role: 'TENANT' });
    const res = await reqWithBody(port, 'DELETE', '/d/doc-1');
    expect(res.status).toBe(403);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET / with filters
// ════════════════════════════════════════════════════════════════════════════

describe('GET / with category and status filters', () => {
  it('applies category filter to WHERE clause', async () => {
    activeUser.current = owner();
    mockQuery.mockResolvedValueOnce([sampleDoc]);
    mockQueryOne.mockResolvedValueOnce({ count: '1' });

    const res = await reqWithBody(port, 'GET', '/d/?category=LEASE_AGREEMENT');
    expect(res.status).toBe(200);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('category =');
  });

  it('applies status filter to WHERE clause', async () => {
    activeUser.current = owner();
    mockQuery.mockResolvedValueOnce([sampleDoc]);
    mockQueryOne.mockResolvedValueOnce({ count: '1' });

    await reqWithBody(port, 'GET', '/d/?status=VERIFIED_EXTERNAL');

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('status =');
  });

  it('excludes archived documents by default', async () => {
    activeUser.current = owner();
    mockQuery.mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce({ count: '0' });

    await reqWithBody(port, 'GET', '/d/');

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('archived_at IS NULL');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Backward compat: /upload normalizes to Phase 1 schema
// ════════════════════════════════════════════════════════════════════════════

describe('Backward compat: POST /upload', () => {
  it('creates document with category=OWNER_UPLOAD and title=name', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce({
      ...sampleDoc, category: 'OWNER_UPLOAD', title: 'Lease.pdf',
    });

    const res = await reqWithBody(port, 'POST', '/d/upload', {
      relatedType: 'LEASE', relatedId: 'lease-1', name: 'Lease.pdf', mimeType: 'application/pdf',
    });
    expect(res.status).toBe(201);

    const sql = mockQueryOne.mock.calls[0][0] as string;
    expect(sql).toContain('OWNER_UPLOAD');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Backward compat: /:id/confirm normalizes legacy status values
// ════════════════════════════════════════════════════════════════════════════

describe('Backward compat: POST /:id/confirm status normalization', () => {
  it('normalizes EXECUTED to FULLY_EXECUTED', async () => {
    activeUser.current = owner();
    mockQueryOne
      .mockResolvedValueOnce({ ...sampleDoc, status: 'UPLOADED', category: 'OWNER_UPLOAD' })
      .mockResolvedValueOnce({ ...sampleDoc, status: 'FULLY_EXECUTED' })
      .mockResolvedValueOnce(null); // audit

    const res = await reqWithBody(port, 'POST', '/d/doc-1/confirm', { status: 'EXECUTED' });
    expect(res.status).toBe(200);

    // Status is passed as a param ($1), not inlined in SQL
    const updateParams = mockQueryOne.mock.calls[1][1] as any[];
    expect(updateParams[0]).toBe('FULLY_EXECUTED');
  });

  it('normalizes CONFIRMED_EXTERNAL to VERIFIED_EXTERNAL', async () => {
    activeUser.current = owner();
    mockQueryOne
      .mockResolvedValueOnce({ ...sampleDoc, status: 'UPLOADED', category: 'OWNER_UPLOAD' })
      .mockResolvedValueOnce({ ...sampleDoc, status: 'VERIFIED_EXTERNAL' })
      .mockResolvedValueOnce(null);

    const res = await reqWithBody(port, 'POST', '/d/doc-1/confirm', { status: 'CONFIRMED_EXTERNAL' });
    expect(res.status).toBe(200);

    const updateParams = mockQueryOne.mock.calls[1][1] as any[];
    expect(updateParams[0]).toBe('VERIFIED_EXTERNAL');
  });
});

export {};
