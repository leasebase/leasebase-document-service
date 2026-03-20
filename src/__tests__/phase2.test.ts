import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

// ── Mocks ─────────────────────────────────────────────────────────────────────
const { mockQuery, mockQueryOne, activeUser } = vi.hoisted(() => ({
  mockQuery:    vi.fn(),
  mockQueryOne: vi.fn(),
  activeUser:   { current: null as any },
}));

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

// Mock pdfkit — avoid actual PDF generation in unit tests
vi.mock('pdfkit', () => {
  return {
    default: class FakePDF {
      _stream: any;
      on(_e: string, _fn: any) { return this; }
      pipe(stream: any)  { this._stream = stream; return this; }
      fontSize() { return this; }
      font()     { return this; }
      fillColor(){ return this; }
      text()     { return this; }
      moveDown() { return this; }
      end()      {
        if (this._stream) {
          this._stream.write(Buffer.from('%PDF-1.4 fake'));
          this._stream.end();
        }
      }
    },
  };
});

// Mock fetch for downstream calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import express from 'express';
import { templatesRouter } from '../routes/templates';
import { signatureRequestsRouter } from '../routes/signatureRequests';

// ── Test helpers ──────────────────────────────────────────────────────────────
function req(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: '127.0.0.1', port, path, method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data).toString() } : {}),
          ...headers,
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
    if (data) r.write(data);
    r.end();
  });
}

const ownerUser = {
  userId: 'user-owner', orgId: 'org-1', role: 'OWNER',
  email: 'owner@test.com', name: 'Owner', scopes: ['api/read', 'api/write'],
};

const tenantUser = {
  userId: 'user-tenant', orgId: 'org-1', role: 'TENANT',
  email: 'tenant@test.com', name: 'Tenant', scopes: ['api/read', 'api/write'],
};

let server: http.Server;
let port: number;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/t', templatesRouter);
  app.use('/d', signatureRequestsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode || err.status || 500).json({
      error: { code: err.code, message: err.message },
    });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      port = (server.address() as any).port;
      resolve();
    });
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
// TEMPLATES — CRUD
// ════════════════════════════════════════════════════════════════════════════

describe('Templates — CRUD', () => {
  it('POST /t — creates a template and returns 201', async () => {
    activeUser.current = ownerUser;
    mockQueryOne.mockResolvedValueOnce({
      id: 'tmpl-1', organization_id: 'org-1', category: 'LEASE_AGREEMENT',
      name: 'Standard Lease', description: null, is_active: true,
    });

    const { status, body } = await req(port, 'POST', '/t', {
      name: 'Standard Lease',
      category: 'LEASE_AGREEMENT',
    });

    expect(status).toBe(201);
    expect(body.data.id).toBe('tmpl-1');
    expect(body.data.name).toBe('Standard Lease');
  });

  it('POST /t — returns 400 when name is missing', async () => {
    activeUser.current = ownerUser;
    const { status } = await req(port, 'POST', '/t', { category: 'LEASE_AGREEMENT' });
    expect(status).toBe(400);
  });

  it('POST /t — returns 401 when unauthenticated', async () => {
    const { status } = await req(port, 'POST', '/t', { name: 'Test', category: 'LEASE_AGREEMENT' });
    expect(status).toBe(401);
  });

  it('GET /t — lists templates for org', async () => {
    activeUser.current = ownerUser;
    mockQuery.mockResolvedValueOnce([
      { id: 'tmpl-1', name: 'Standard Lease', category: 'LEASE_AGREEMENT' },
      { id: 'tmpl-2', name: 'Short Term', category: 'LEASE_ADDENDUM' },
    ]);

    const { status, body } = await req(port, 'GET', '/t');
    expect(status).toBe(200);
    expect(body.data).toHaveLength(2);
  });

  it('GET /t/:id — returns template with versions', async () => {
    activeUser.current = ownerUser;
    mockQueryOne.mockResolvedValueOnce({ id: 'tmpl-1', name: 'Standard Lease' });
    mockQuery.mockResolvedValueOnce([
      { id: 'ver-1', version_number: 1, storage_key: 'org-1/templates/tmpl-1/v1-template.pdf' },
    ]);

    const { status, body } = await req(port, 'GET', '/t/tmpl-1');
    expect(status).toBe(200);
    expect(body.data.versions).toHaveLength(1);
  });

  it('GET /t/:id — returns 404 for non-existent template', async () => {
    activeUser.current = ownerUser;
    mockQueryOne.mockResolvedValueOnce(null);
    const { status } = await req(port, 'GET', '/t/not-found');
    expect(status).toBe(404);
  });

  it('PATCH /t/:id — updates template name', async () => {
    activeUser.current = ownerUser;
    mockQueryOne
      .mockResolvedValueOnce({ id: 'tmpl-1' })   // exists check
      .mockResolvedValueOnce({ id: 'tmpl-1', name: 'Updated Name', is_active: true }); // update

    const { status, body } = await req(port, 'PATCH', '/t/tmpl-1', { name: 'Updated Name' });
    expect(status).toBe(200);
    expect(body.data.name).toBe('Updated Name');
  });

  it('DELETE /t/:id — archives template', async () => {
    activeUser.current = ownerUser;
    mockQueryOne.mockResolvedValueOnce({ id: 'tmpl-1' });
    const { status } = await req(port, 'DELETE', '/t/tmpl-1');
    expect(status).toBe(204);
  });

  it('DELETE /t/:id — returns 404 for already-archived template', async () => {
    activeUser.current = ownerUser;
    mockQueryOne.mockResolvedValueOnce(null);
    const { status } = await req(port, 'DELETE', '/t/not-active');
    expect(status).toBe(404);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TEMPLATE VERSIONS
// ════════════════════════════════════════════════════════════════════════════

describe('Template Versions', () => {
  it('POST /t/:id/versions/upload-url — returns upload URL', async () => {
    activeUser.current = ownerUser;
    mockQueryOne
      .mockResolvedValueOnce({ id: 'tmpl-1', organization_id: 'org-1' }) // template lookup
      .mockResolvedValueOnce({ count: '0' })  // version count
      .mockResolvedValueOnce({ id: 'ver-1', version_number: 1, storage_key: 'key-1' }); // insert

    const { status, body } = await req(port, 'POST', '/t/tmpl-1/versions/upload-url', {
      fileName: 'template.pdf',
      mimeType: 'application/pdf',
      sourceFormat: 'PDF',
    });

    expect(status).toBe(201);
    expect(body.uploadUrl).toContain('placeholder://upload/');
    expect(body.storageKey).toContain('tmpl-1');
  });

  it('POST /t/:id/versions/upload-url — returns 404 for unknown template', async () => {
    activeUser.current = ownerUser;
    mockQueryOne.mockResolvedValueOnce(null);
    const { status } = await req(port, 'POST', '/t/unknown/versions/upload-url', {
      fileName: 'x.pdf', mimeType: 'application/pdf',
    });
    expect(status).toBe(404);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TEMPLATE VARIABLES
// ════════════════════════════════════════════════════════════════════════════

describe('Template Variables', () => {
  it('GET /t/:id/variables — returns variables for latest version', async () => {
    activeUser.current = ownerUser;
    mockQueryOne
      .mockResolvedValueOnce({ id: 'tmpl-1' })   // template
      .mockResolvedValueOnce({ id: 'ver-1', version_number: 1 }); // latest version
    mockQuery.mockResolvedValueOnce([
      { id: 'v1', variable_key: 'tenant_name', label: 'Tenant Name', data_type: 'STRING', required: true },
      { id: 'v2', variable_key: 'rent_amount', label: 'Monthly Rent', data_type: 'CURRENCY', required: true },
    ]);

    const { status, body } = await req(port, 'GET', '/t/tmpl-1/variables');
    expect(status).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(body.versionId).toBe('ver-1');
  });

  it('GET /t/:id/variables — returns empty array when no version uploaded', async () => {
    activeUser.current = ownerUser;
    mockQueryOne
      .mockResolvedValueOnce({ id: 'tmpl-1' })
      .mockResolvedValueOnce(null); // no version

    const { status, body } = await req(port, 'GET', '/t/tmpl-1/variables');
    expect(status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.versionId).toBeNull();
  });

  it('PUT /t/:id/variables — replaces variables', async () => {
    activeUser.current = ownerUser;
    mockQueryOne
      .mockResolvedValueOnce({ id: 'tmpl-1' })    // template check
      .mockResolvedValueOnce({ id: 'ver-1' })      // latest version
      .mockResolvedValueOnce({ id: 'v1', variable_key: 'tenant_name' }) // insert 1
      .mockResolvedValueOnce({ id: 'v2', variable_key: 'start_date' }); // insert 2
    mockQuery.mockResolvedValueOnce([]); // delete

    const { status, body } = await req(port, 'PUT', '/t/tmpl-1/variables', [
      { variable_key: 'tenant_name', label: 'Tenant Name', required: true },
      { variable_key: 'start_date',  label: 'Start Date',  required: true, data_type: 'DATE' },
    ]);

    expect(status).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(body.versionId).toBe('ver-1');
  });

  it('PUT /t/:id/variables — returns 400 with no version', async () => {
    activeUser.current = ownerUser;
    mockQueryOne
      .mockResolvedValueOnce({ id: 'tmpl-1' })
      .mockResolvedValueOnce(null); // no version

    const { status } = await req(port, 'PUT', '/t/tmpl-1/variables', [
      { variable_key: 'x', label: 'X', required: false },
    ]);
    expect(status).toBe(400);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PDF GENERATION
// ════════════════════════════════════════════════════════════════════════════

describe('Template Generation', () => {
  it('POST /t/:id/generate — creates document from template', async () => {
    activeUser.current = ownerUser;
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // notification (non-fatal)

    mockQueryOne
      .mockResolvedValueOnce({ id: 'tmpl-1', name: 'Standard Lease', category: 'LEASE_AGREEMENT', organization_id: 'org-1' }) // template
      .mockResolvedValueOnce({ id: 'ver-1', version_number: 1, content_text: 'Lease for {{tenant_name}}', storage_key: 'key' }) // version
    mockQuery.mockResolvedValueOnce([]); // required vars (none)

    mockQueryOne
      .mockResolvedValueOnce({ id: 'doc-1', category: 'LEASE_AGREEMENT', status: 'UPLOADED' }) // insert document
      .mockResolvedValueOnce({ id: 'docver-1', version_number: 1 }) // insert version
      .mockResolvedValueOnce({ id: 'doc-1' }) // update current_version_id
      .mockResolvedValueOnce({ id: 'gendoc-1' }) // insert generated_documents
      .mockResolvedValueOnce({ id: 'audit-1' }); // audit event

    const { status, body } = await req(port, 'POST', '/t/tmpl-1/generate', {
      leaseId: 'lease-99',
      variables: { tenant_name: 'Alice Smith' },
    });

    expect(status).toBe(201);
    expect(body.data.id).toBe('doc-1');
    expect(body.generatedDocument.id).toBe('gendoc-1');
  });

  it('POST /t/:id/generate — returns 400 for missing required variables', async () => {
    activeUser.current = ownerUser;
    mockQueryOne
      .mockResolvedValueOnce({ id: 'tmpl-1', name: 'Lease', category: 'LEASE_AGREEMENT', organization_id: 'org-1' })
      .mockResolvedValueOnce({ id: 'ver-1', version_number: 1, content_text: null, storage_key: 'k' });
    mockQuery.mockResolvedValueOnce([
      { variable_key: 'tenant_name', label: 'Tenant Name' }, // required
    ]);

    const { status, body } = await req(port, 'POST', '/t/tmpl-1/generate', {
      leaseId: 'lease-99',
      variables: {}, // missing tenant_name
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe('MISSING_VARIABLES');
  });

  it('POST /t/:id/generate — returns 404 for inactive template', async () => {
    activeUser.current = ownerUser;
    mockQueryOne.mockResolvedValueOnce(null);
    const { status } = await req(port, 'POST', '/t/tmpl-1/generate', {
      leaseId: 'lease-99',
      variables: {},
    });
    expect(status).toBe(404);
  });

  it('POST /t/:id/generate — returns 400 when no version uploaded', async () => {
    activeUser.current = ownerUser;
    mockQueryOne
      .mockResolvedValueOnce({ id: 'tmpl-1', name: 'Lease', category: 'LEASE_AGREEMENT', organization_id: 'org-1' })
      .mockResolvedValueOnce(null); // no version

    const { status, body } = await req(port, 'POST', '/t/tmpl-1/generate', {
      leaseId: 'lease-99',
      variables: {},
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe('NO_VERSION');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SIGNATURE REQUESTS
// ════════════════════════════════════════════════════════════════════════════

describe('Signature Requests', () => {
  it('POST /d/documents/:id/signature-requests — creates request with signers', async () => {
    activeUser.current = ownerUser;
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // notification

    mockQueryOne
      .mockResolvedValueOnce({ id: 'doc-1', related_type: 'LEASE', related_id: 'lease-1', category: 'LEASE_AGREEMENT', status: 'UPLOADED' }) // doc
      .mockResolvedValueOnce({ id: 'sig-1' }) // insert sig request
      .mockResolvedValueOnce({ id: 'signer-1', user_id: 'user-tenant', status: 'PENDING' }) // signer 1
      .mockResolvedValueOnce({ id: 'audit-1' }) // event
      .mockResolvedValueOnce({ id: 'doc-1' }); // update doc status

    const { status, body } = await req(port, 'POST', '/d/documents/doc-1/signature-requests', {
      signers: [{ user_id: 'user-tenant', signer_type: 'TENANT', routing_order: 1 }],
    });

    expect(status).toBe(201);
    expect(body.data.signers).toHaveLength(1);
  });

  it('POST /d/documents/:id/signature-requests — returns 400 when signers is empty', async () => {
    activeUser.current = ownerUser;
    const { status } = await req(port, 'POST', '/d/documents/doc-1/signature-requests', {
      signers: [],
    });
    expect(status).toBe(400);
  });

  it('POST /d/documents/:id/signature-requests — returns 404 for unknown document', async () => {
    activeUser.current = ownerUser;
    mockQueryOne.mockResolvedValueOnce(null);
    const { status } = await req(port, 'POST', '/d/documents/unknown/signature-requests', {
      signers: [{ user_id: 'user-tenant', signer_type: 'TENANT' }],
    });
    expect(status).toBe(404);
  });

  it('GET /d/documents/:id/signature-requests — lists requests', async () => {
    activeUser.current = ownerUser;
    mockQueryOne.mockResolvedValueOnce({ id: 'doc-1' }); // doc exists
    mockQuery.mockResolvedValueOnce([
      { id: 'sig-1', status: 'REQUESTED', signers: [] },
    ]);

    const { status, body } = await req(port, 'GET', '/d/documents/doc-1/signature-requests');
    expect(status).toBe(200);
    expect(body.data).toHaveLength(1);
  });

  it('GET /d/signature-requests/:id — returns detail with signers and events', async () => {
    activeUser.current = ownerUser;
    mockQueryOne.mockResolvedValueOnce({ id: 'sig-1', status: 'REQUESTED', document_id: 'doc-1' });
    mockQuery
      .mockResolvedValueOnce([{ id: 'signer-1', status: 'PENDING' }]) // signers
      .mockResolvedValueOnce([{ id: 'evt-1', event_type: 'CREATED' }]); // events

    const { status, body } = await req(port, 'GET', '/d/signature-requests/sig-1');
    expect(status).toBe(200);
    expect(body.data.signers).toHaveLength(1);
    expect(body.data.events).toHaveLength(1);
  });

  it('PATCH /d/signature-requests/:id/status — cancels request', async () => {
    activeUser.current = ownerUser;
    mockQueryOne
      .mockResolvedValueOnce({ id: 'sig-1', status: 'REQUESTED', document_id: 'doc-1' }) // lookup
      .mockResolvedValueOnce({ id: 'sig-1', status: 'CANCELLED' }) // update
      .mockResolvedValueOnce({ id: 'evt-1' }); // event

    const { status, body } = await req(port, 'PATCH', '/d/signature-requests/sig-1/status', {
      status: 'CANCELLED',
    });
    expect(status).toBe(200);
    expect(body.data.status).toBe('CANCELLED');
  });

  it('PATCH /d/signature-requests/:id/status — idempotent for already-cancelled', async () => {
    activeUser.current = ownerUser;
    mockQueryOne.mockResolvedValueOnce({ id: 'sig-1', status: 'CANCELLED', document_id: 'doc-1' });

    const { status, body } = await req(port, 'PATCH', '/d/signature-requests/sig-1/status', {
      status: 'CANCELLED',
    });
    expect(status).toBe(200);
    expect(body.alreadyCancelled).toBe(true);
  });

  it('PATCH /d/signature-requests/:id/status — returns 400 if COMPLETED', async () => {
    activeUser.current = ownerUser;
    mockQueryOne.mockResolvedValueOnce({ id: 'sig-1', status: 'COMPLETED', document_id: 'doc-1' });

    const { status } = await req(port, 'PATCH', '/d/signature-requests/sig-1/status', {
      status: 'CANCELLED',
    });
    expect(status).toBe(400);
  });

  it('POST /d/signature-requests/:id/sign — signs the request', async () => {
    activeUser.current = { ...tenantUser };
    // All signers complete → request COMPLETED
    mockQueryOne
      .mockResolvedValueOnce({ id: 'sig-1', status: 'REQUESTED', document_id: 'doc-1', organization_id: 'org-1' })
      .mockResolvedValueOnce({ id: 'signer-1', status: 'PENDING', user_id: 'user-tenant' }) // signer lookup
      .mockResolvedValueOnce({ id: 'signer-1', status: 'SIGNED', signed_at: new Date() }) // update signer
      .mockResolvedValueOnce({ id: 'evt-signed' }) // SIGNED event
      .mockResolvedValueOnce({ count: '0' }) // no remaining pending signers
      .mockResolvedValueOnce({ id: 'sig-1', status: 'COMPLETED', completed_at: new Date() }) // update request
      .mockResolvedValueOnce({ id: 'doc-1', related_type: 'LEASE', related_id: 'lease-1', category: 'LEASE_AGREEMENT' }) // update doc
      .mockResolvedValueOnce({ id: 'audit-1' }); // audit event

    // Mock lease activation call
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { status: 'ACTIVE' } }) });

    const { status, body } = await req(port, 'POST', '/d/signature-requests/sig-1/sign', {
      signerId: 'signer-1',
    });

    expect(status).toBe(200);
    expect(body.data.signatureRequest.status).toBe('COMPLETED');
    // Verify lease activation was called
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/internal/leases/lease-1/activate-from-document');
    expect(JSON.parse(opts.body)).toMatchObject({ organizationId: 'org-1' });
  });

  it('POST /d/signature-requests/:id/sign — returns 403 if signer user_id mismatch', async () => {
    activeUser.current = ownerUser; // owner, but signer record points to tenant
    mockQueryOne
      .mockResolvedValueOnce({ id: 'sig-1', status: 'REQUESTED', document_id: 'doc-1', organization_id: 'org-1' })
      .mockResolvedValueOnce({ id: 'signer-1', status: 'PENDING', user_id: 'different-user' }); // wrong user_id

    const { status } = await req(port, 'POST', '/d/signature-requests/sig-1/sign', {
      signerId: 'signer-1',
    });
    expect(status).toBe(403);
  });

  it('POST /d/signature-requests/:id/sign — idempotent for already-signed signer', async () => {
    activeUser.current = tenantUser;
    mockQueryOne
      .mockResolvedValueOnce({ id: 'sig-1', status: 'PARTIALLY_SIGNED', document_id: 'doc-1', organization_id: 'org-1' })
      .mockResolvedValueOnce({ id: 'signer-1', status: 'SIGNED', user_id: 'user-tenant' });

    const { status, body } = await req(port, 'POST', '/d/signature-requests/sig-1/sign', {
      signerId: 'signer-1',
    });
    expect(status).toBe(200);
    expect(body.alreadySigned).toBe(true); // top-level: { data: signer, alreadySigned: true }
  });

  it('POST /d/signature-requests/:id/sign — PARTIALLY_SIGNED when not all signers done', async () => {
    activeUser.current = tenantUser;
    mockQueryOne
      .mockResolvedValueOnce({ id: 'sig-1', status: 'REQUESTED', document_id: 'doc-1', organization_id: 'org-1' })
      .mockResolvedValueOnce({ id: 'signer-1', status: 'PENDING', user_id: 'user-tenant' })
      .mockResolvedValueOnce({ id: 'signer-1', status: 'SIGNED', signed_at: new Date() })
      .mockResolvedValueOnce({ id: 'evt-1' }) // SIGNED event
      .mockResolvedValueOnce({ count: '1' }) // 1 remaining pending signer
      .mockResolvedValueOnce({ id: 'sig-1', status: 'PARTIALLY_SIGNED' }); // update request

    const { status, body } = await req(port, 'POST', '/d/signature-requests/sig-1/sign', {
      signerId: 'signer-1',
    });

    expect(status).toBe(200);
    expect(body.data.signatureRequest.status).toBe('PARTIALLY_SIGNED');
    // No lease activation
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
