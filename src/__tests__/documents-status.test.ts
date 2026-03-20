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
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: '127.0.0.1', port, path, method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
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
  it('promotes UPLOADED document to CONFIRMED_EXTERNAL', async () => {
    activeUser.current = owner();
    // First call: SELECT existing document
    mockQueryOne.mockResolvedValueOnce({ ...sampleUploadedDoc, status: 'UPLOADED' });
    // Second call: UPDATE RETURNING
    mockQueryOne.mockResolvedValueOnce({ ...sampleUploadedDoc, status: 'CONFIRMED_EXTERNAL' });

    const res = await reqWithBody(port, 'POST', '/d/doc-1/confirm', { status: 'CONFIRMED_EXTERNAL' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CONFIRMED_EXTERNAL');
  });

  it('promotes UPLOADED document to EXECUTED', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce({ ...sampleUploadedDoc, status: 'UPLOADED' });
    mockQueryOne.mockResolvedValueOnce({ ...sampleUploadedDoc, status: 'EXECUTED' });

    const res = await reqWithBody(port, 'POST', '/d/doc-1/confirm', { status: 'EXECUTED' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('EXECUTED');
  });

  it('is idempotent when document is already at the target status', async () => {
    activeUser.current = owner();
    // SELECT returns document already at CONFIRMED_EXTERNAL
    mockQueryOne.mockResolvedValueOnce({ ...sampleUploadedDoc, status: 'CONFIRMED_EXTERNAL' });

    const res = await reqWithBody(port, 'POST', '/d/doc-1/confirm', { status: 'CONFIRMED_EXTERNAL' });
    expect(res.status).toBe(200);
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

export {};
