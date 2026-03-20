import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const { mockQuery, mockQueryOne, activeUser } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockQueryOne: vi.fn(),
  activeUser: { current: null as any },
}));

vi.mock('@leasebase/service-common', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@leasebase/service-common')>();
  return {
    ...mod,
    query: mockQuery,
    queryOne: mockQueryOne,
    requireAuth: (req: any, _res: any, next: any) => {
      if (!activeUser.current) return next(new mod.UnauthorizedError());
      req.user = { ...activeUser.current };
      next();
    },
  };
});

import express from 'express';
import { documentsRouter } from '../routes/documents';

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
        res.on('end', () => { try { resolve({ status: res.statusCode!, body: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode!, body: raw }); } });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const owner = (overrides: Record<string, any> = {}) => ({
  sub: 'o1', userId: 'o1', orgId: 'org-1', email: 'o@t.com', role: 'OWNER', name: 'Owner', scopes: ['api/read', 'api/write'], ...overrides,
});

const sampleUploadedDoc = {
  id: 'doc-1', organization_id: 'org-1', related_type: 'LEASE', related_id: 'lease-1',
  name: 'Lease.pdf', s3_key: 'org-1/LEASE/lease-1/lease.pdf', mime_type: 'application/pdf',
  title: 'Lease Agreement', category: 'OWNER_UPLOAD',
  created_by_user_id: 'o1', status: 'UPLOADED', created_at: '2024-01-01', updated_at: '2024-01-01',
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
beforeEach(() => { mockQuery.mockReset(); mockQueryOne.mockReset(); activeUser.current = null; });

// ════════════════════════════════════════════════════════════════════════════
// POST /upload — document status is UPLOADED on creation
// ════════════════════════════════════════════════════════════════════════════

describe('POST /upload — status field', () => {
  it('creates document with status UPLOADED', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce({ ...sampleUploadedDoc, id: 'doc-new' });

    const res = await reqWithBody(port, 'POST', '/d/upload', {
      relatedType: 'LEASE', relatedId: 'lease-1', name: 'Lease.pdf', mimeType: 'application/pdf',
    });
    expect(res.status).toBe(201);

    // Verify status=UPLOADED is in the INSERT SQL
    const insertSql = mockQueryOne.mock.calls[0][0] as string;
    expect(insertSql).toContain('UPLOADED');
    expect(insertSql).toContain('status');
  });

  it('requires OWNER role', async () => {
    activeUser.current = { ...owner(), role: 'TENANT' };
    const res = await reqWithBody(port, 'POST', '/d/upload', {
      relatedType: 'LEASE', relatedId: 'lease-1', name: 'Lease.pdf', mimeType: 'application/pdf',
    });
    expect(res.status).toBe(403);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /:id/confirm — promote document to EXECUTED or CONFIRMED_EXTERNAL
// ════════════════════════════════════════════════════════════════════════════

describe('POST /:id/confirm — confirm document execution status', () => {
  it('promotes UPLOADED document to VERIFIED_EXTERNAL (via CONFIRMED_EXTERNAL legacy input)', async () => {
    activeUser.current = owner();
    // First call: SELECT existing document
    mockQueryOne.mockResolvedValueOnce({ ...sampleUploadedDoc, status: 'UPLOADED' });
    // Second call: UPDATE RETURNING (normalized to VERIFIED_EXTERNAL)
    mockQueryOne.mockResolvedValueOnce({ ...sampleUploadedDoc, status: 'VERIFIED_EXTERNAL' });
    // Third call: audit INSERT
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await reqWithBody(port, 'POST', '/d/doc-1/confirm', { status: 'CONFIRMED_EXTERNAL' });
    expect(res.status).toBe(200);
    // The UPDATE should pass VERIFIED_EXTERNAL as the $1 param
    const updateParams = mockQueryOne.mock.calls[1][1] as any[];
    expect(updateParams[0]).toBe('VERIFIED_EXTERNAL');
  });

  it('promotes UPLOADED document to FULLY_EXECUTED (via EXECUTED legacy input)', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce({ ...sampleUploadedDoc, status: 'UPLOADED' });
    mockQueryOne.mockResolvedValueOnce({ ...sampleUploadedDoc, status: 'FULLY_EXECUTED' });
    mockQueryOne.mockResolvedValueOnce(null); // audit

    const res = await reqWithBody(port, 'POST', '/d/doc-1/confirm', { status: 'EXECUTED' });
    expect(res.status).toBe(200);
    const updateParams = mockQueryOne.mock.calls[1][1] as any[];
    expect(updateParams[0]).toBe('FULLY_EXECUTED');
  });

  it('is idempotent when document is already VERIFIED_EXTERNAL (sent as CONFIRMED_EXTERNAL)', async () => {
    activeUser.current = owner();
    // SELECT returns document already at CONFIRMED_EXTERNAL (legacy, pre-migration)
    mockQueryOne.mockResolvedValueOnce({ ...sampleUploadedDoc, status: 'CONFIRMED_EXTERNAL' });

    const res = await reqWithBody(port, 'POST', '/d/doc-1/confirm', { status: 'CONFIRMED_EXTERNAL' });
    expect(res.status).toBe(200);
    // Cross-vocab idempotency: CONFIRMED_EXTERNAL === VERIFIED_EXTERNAL target
    // No UPDATE should have been issued (only 1 queryOne call — the SELECT)
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when document not found in org', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await reqWithBody(port, 'POST', '/d/doc-1/confirm', { status: 'CONFIRMED_EXTERNAL' });
    expect(res.status).toBe(404);
  });

  it('rejects invalid status values', async () => {
    activeUser.current = owner();
    const res = await reqWithBody(port, 'POST', '/d/doc-1/confirm', { status: 'INVALID_STATUS' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('requires OWNER role', async () => {
    activeUser.current = { ...owner(), role: 'TENANT' };
    const res = await reqWithBody(port, 'POST', '/d/doc-1/confirm', { status: 'CONFIRMED_EXTERNAL' });
    expect(res.status).toBe(403);
  });

  it('requires authentication', async () => {
    activeUser.current = null;
    const res = await reqWithBody(port, 'POST', '/d/doc-1/confirm', { status: 'CONFIRMED_EXTERNAL' });
    expect(res.status).toBe(401);
  });
});


// ════════════════════════════════════════════════════════════════════════════
// GET /lease-proof — Internal endpoint for lease activation gating
// ════════════════════════════════════════════════════════════════════════════

// Set a test internal service key (the env var controls actual auth)
const TEST_INTERNAL_KEY = 'test-internal-key-abc123';

describe('GET /lease-proof — internal activation proof check', () => {
  beforeEach(() => {
    // Set the env var for the internal key check
    process.env.INTERNAL_SERVICE_KEY = TEST_INTERNAL_KEY;
  });

  const validHeaders = { 'x-internal-service-key': TEST_INTERNAL_KEY };

  it('returns qualified=true when FULLY_EXECUTED lease document exists', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'doc-1', status: 'FULLY_EXECUTED' });

    const res = await reqWithBody(port, 'GET', '/d/lease-proof?leaseId=lease-1&organizationId=org-1', undefined, validHeaders);
    expect(res.status).toBe(200);
    expect(res.body.qualified).toBe(true);
    expect(res.body.document.id).toBe('doc-1');
    expect(res.body.document.status).toBe('FULLY_EXECUTED');

    // Verify the query scopes to LEASE type and correct statuses
    const sql = mockQueryOne.mock.calls[0][0] as string;
    expect(sql).toContain("related_type = 'LEASE'");
    // Status values are passed as params (not inline) — verify they appear in params
    const params = mockQueryOne.mock.calls[0][1] as any[];
    expect(params).toContain('FULLY_EXECUTED');
    expect(params).toContain('VERIFIED_EXTERNAL');
  });

  it('returns qualified=true when VERIFIED_EXTERNAL lease document exists', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'doc-2', status: 'VERIFIED_EXTERNAL' });

    const res = await reqWithBody(port, 'GET', '/d/lease-proof?leaseId=lease-1&organizationId=org-1', undefined, validHeaders);
    expect(res.status).toBe(200);
    expect(res.body.qualified).toBe(true);
    expect(res.body.document.status).toBe('VERIFIED_EXTERNAL');
  });

  it('returns qualified=false when only UPLOADED lease document exists', async () => {
    // The queryOne returns null because UPLOADED is not in the qualifying status list
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await reqWithBody(port, 'GET', '/d/lease-proof?leaseId=lease-1&organizationId=org-1', undefined, validHeaders);
    expect(res.status).toBe(200);
    expect(res.body.qualified).toBe(false);
    expect(res.body.document).toBeNull();

    // Verify UPLOADED is not in the qualifying status params
    const params = mockQueryOne.mock.calls[0][1] as any[];
    expect(params).not.toContain('UPLOADED');
  });

  it('returns qualified=false when no lease documents exist', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await reqWithBody(port, 'GET', '/d/lease-proof?leaseId=lease-999&organizationId=org-1', undefined, validHeaders);
    expect(res.status).toBe(200);
    expect(res.body.qualified).toBe(false);
  });

  it('non-LEASE documents do not qualify (SQL scopes to related_type=LEASE)', async () => {
    // Even if MAINTENANCE or PAYMENT documents exist in EXECUTED status,
    // they should not qualify because the query only checks related_type='LEASE'.
    // The mock returns null because the real query would filter them out.
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await reqWithBody(port, 'GET', '/d/lease-proof?leaseId=lease-1&organizationId=org-1', undefined, validHeaders);
    expect(res.status).toBe(200);
    expect(res.body.qualified).toBe(false);

    // Confirm the SQL explicitly filters related_type = 'LEASE'
    const sql = mockQueryOne.mock.calls[0][0] as string;
    expect(sql).toContain("related_type = 'LEASE'");
  });

  it('returns 401 for missing internal service key', async () => {
    const res = await reqWithBody(port, 'GET', '/d/lease-proof?leaseId=lease-1&organizationId=org-1');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 for wrong internal service key', async () => {
    const res = await reqWithBody(
      port, 'GET', '/d/lease-proof?leaseId=lease-1&organizationId=org-1',
      undefined,
      { 'x-internal-service-key': 'wrong-key' },
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 when leaseId is missing', async () => {
    const res = await reqWithBody(port, 'GET', '/d/lease-proof?organizationId=org-1', undefined, validHeaders);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_PARAMS');
  });

  it('returns 400 when organizationId is missing', async () => {
    const res = await reqWithBody(port, 'GET', '/d/lease-proof?leaseId=lease-1', undefined, validHeaders);
    expect(res.status).toBe(400);
  });

  it('scopes query to the given organizationId (prevents cross-org proof)', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    await reqWithBody(port, 'GET', '/d/lease-proof?leaseId=lease-1&organizationId=org-99', undefined, validHeaders);

    // The second param passed to queryOne should be the organizationId
    const queryParams = mockQueryOne.mock.calls[0][1] as any[];
    expect(queryParams[1]).toBe('org-99');
  });
});

export {};
