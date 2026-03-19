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

function req(port: number, method: string, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json' } },
      (res) => { let raw = ''; res.on('data', (c) => (raw += c)); res.on('end', () => { try { resolve({ status: res.statusCode!, body: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode!, body: raw }); } }); },
    );
    r.on('error', reject);
    r.end();
  });
}

const tenant = (overrides: Record<string, any> = {}) => ({
  sub: 'u1', userId: 'u1', orgId: 'org-1', email: 't@t.com', role: 'TENANT', name: 'Tenant', scopes: ['api/read'], ...overrides,
});

const owner = (overrides: Record<string, any> = {}) => ({
  sub: 'o1', userId: 'o1', orgId: 'org-1', email: 'o@t.com', role: 'OWNER', name: 'Owner', scopes: ['api/read'], ...overrides,
});

const sampleDoc = {
  id: 'doc-1', organization_id: 'org-1', related_type: 'LEASE', related_id: 'lease-1',
  name: 'Lease Agreement.pdf', s3_key: 'org-1/LEASE/lease-1/agreement.pdf', mime_type: 'application/pdf',
  created_by_user_id: 'o1', created_at: '2024-01-01', updated_at: '2024-01-01',
};

let server: http.Server;
let port: number;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/d', documentsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => { res.status(err.statusCode || 500).json({ error: { code: err.code, message: err.message } }); });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; resolve(); }); });
});
afterAll(() => server?.close());
beforeEach(() => { mockQuery.mockReset(); mockQueryOne.mockReset(); });

// ════════════════════════════════════════════════════════════════════════════
// GET /:id — Tenant document detail access
// ════════════════════════════════════════════════════════════════════════════

describe('GET /:id — tenant access', () => {
  it('allows TENANT to view document they own via tenant_profiles', async () => {
    activeUser.current = tenant();
    mockQueryOne
      .mockResolvedValueOnce(sampleDoc) // document lookup
      .mockResolvedValueOnce({ user_id: 'u1' }); // ownership check

    const res = await req(port, 'GET', '/d/doc-1');
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('doc-1');
  });

  it('rejects TENANT who does not own the document', async () => {
    activeUser.current = tenant({ userId: 'u-other' });
    mockQueryOne
      .mockResolvedValueOnce(sampleDoc) // document found
      .mockResolvedValueOnce(null); // ownership check fails

    const res = await req(port, 'GET', '/d/doc-1');
    expect(res.status).toBe(404);
  });

  it('uses lease_tenants for ownership verification (not deprecated TenantProfile)', async () => {
    activeUser.current = tenant();
    mockQueryOne
      .mockResolvedValueOnce(sampleDoc)
      .mockResolvedValueOnce({ user_id: 'u1' });

    await req(port, 'GET', '/d/doc-1');

    // Second queryOne call = ownership check
    const ownershipSql = mockQueryOne.mock.calls[1][0] as string;
    expect(ownershipSql).toContain('lease_tenants');
    expect(ownershipSql).not.toContain('"TenantProfile"');
    expect(ownershipSql).not.toContain('tenant_profiles');
  });

  it('allows OWNER to view document without ownership check', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce(sampleDoc);

    const res = await req(port, 'GET', '/d/doc-1');
    expect(res.status).toBe(200);
    // Only 1 queryOne call (no ownership check for OWNER)
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
  });

  it('requires authentication', async () => {
    activeUser.current = null;
    const res = await req(port, 'GET', '/d/doc-1');
    expect(res.status).toBe(401);
  });

  it('returns 404 for non-existent document', async () => {
    activeUser.current = tenant();
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await req(port, 'GET', '/d/nonexistent');
    expect(res.status).toBe(404);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /:id/download — Tenant document download access
// ════════════════════════════════════════════════════════════════════════════

describe('GET /:id/download — tenant access', () => {
  it('allows TENANT to download document they own', async () => {
    activeUser.current = tenant();
    mockQueryOne
      .mockResolvedValueOnce(sampleDoc)
      .mockResolvedValueOnce({ user_id: 'u1' });

    const res = await req(port, 'GET', '/d/doc-1/download');
    expect(res.status).toBe(200);
    expect(res.body.downloadUrl).toContain(sampleDoc.s3_key);
  });

  it('rejects TENANT who does not own the document', async () => {
    activeUser.current = tenant({ userId: 'u-other' });
    mockQueryOne
      .mockResolvedValueOnce(sampleDoc)
      .mockResolvedValueOnce(null); // ownership fails

    const res = await req(port, 'GET', '/d/doc-1/download');
    expect(res.status).toBe(404);
  });

  it('allows OWNER to download without ownership check', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce(sampleDoc);

    const res = await req(port, 'GET', '/d/doc-1/download');
    expect(res.status).toBe(200);
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for non-existent document', async () => {
    activeUser.current = tenant();
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await req(port, 'GET', '/d/nonexistent/download');
    expect(res.status).toBe(404);
  });

  it('scopes ownership check with user_id and related_id from document', async () => {
    activeUser.current = tenant({ userId: 'u-42' });
    mockQueryOne
      .mockResolvedValueOnce({ ...sampleDoc, related_id: 'lease-99' })
      .mockResolvedValueOnce({ user_id: 'u-42' });

    await req(port, 'GET', '/d/doc-1/download');

    const ownershipParams = mockQueryOne.mock.calls[1][1] as any[];
    expect(ownershipParams[0]).toBe('u-42');
    expect(ownershipParams[1]).toBe('lease-99');
  });
});
