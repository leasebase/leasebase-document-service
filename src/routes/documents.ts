import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  requireAuth, requireRole, validateBody,
  query, queryOne, NotFoundError, AppError, logger,
  parsePagination, paginationMeta,
  type AuthenticatedRequest, UserRole,
} from '@leasebase/service-common';

const router = Router();

// ── S3 / AWS config ───────────────────────────────────────────────────────────
const S3_BUCKET = process.env.S3_DOCUMENTS_BUCKET || '';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const PRESIGN_UPLOAD_EXPIRES   = 3600; // 1 hour
const PRESIGN_DOWNLOAD_EXPIRES = 900;  // 15 minutes

const s3Client = new S3Client({ region: AWS_REGION });

async function presignPut(key: string, mimeType: string): Promise<string> {
  return getSignedUrl(
    s3Client,
    new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, ContentType: mimeType }),
    { expiresIn: PRESIGN_UPLOAD_EXPIRES },
  );
}

async function presignGet(key: string): Promise<string> {
  return getSignedUrl(
    s3Client,
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
    { expiresIn: PRESIGN_DOWNLOAD_EXPIRES },
  );
}

// ── Document constants ────────────────────────────────────────────────────────

export const DOCUMENT_CATEGORIES = [
  'LEASE_AGREEMENT',
  'LEASE_ADDENDUM',
  'NOTICE',
  'PAYMENT_RECEIPT',
  'MOVE_IN_CHECKLIST',
  'MOVE_OUT_CHECKLIST',
  'MAINTENANCE_ATTACHMENT',
  'OWNER_UPLOAD',
] as const;

export const DOCUMENT_STATUSES = [
  'DRAFT',
  'UPLOADED',
  'PENDING_TENANT_SIGNATURE',
  'FULLY_EXECUTED',
  'VERIFIED_EXTERNAL',
  'ARCHIVED',
  // Legacy values — retained in enum for backward compat during migration
  'EXECUTED',
  'CONFIRMED_EXTERNAL',
] as const;

/** Statuses that qualify a lease document for lease activation. */
export const ACTIVATABLE_STATUSES: ReadonlyArray<string> = [
  'FULLY_EXECUTED',
  'VERIFIED_EXTERNAL',
  // Legacy — retained for transition safety until all rows are backfilled
  'EXECUTED',
  'CONFIRMED_EXTERNAL',
];

/** Owner-allowed status transitions via PATCH (general). */
const OWNER_PATCH_STATUS_TARGETS: ReadonlyArray<string> = [
  'PENDING_TENANT_SIGNATURE',
  'ARCHIVED',
];

// ── Downstream service config ─────────────────────────────────────────────────
const LEASE_SERVICE_URL = process.env.LEASE_SERVICE_URL || 'http://localhost:3003';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

// ── Internal service key validation ──────────────────────────────────────────
function validateInternalKey(req: Request, res: Response): boolean {
  const configuredKey = process.env.INTERNAL_SERVICE_KEY || '';
  const key = req.headers['x-internal-service-key'];
  if (!configuredKey || key !== configuredKey) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing internal service key' } });
    return false;
  }
  return true;
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const uploadUrlSchema = z.object({
  relatedType:  z.string().min(1),
  relatedId:    z.string().min(1),
  category:     z.enum(DOCUMENT_CATEGORIES).default('OWNER_UPLOAD'),
  title:        z.string().min(1),
  description:  z.string().optional(),
  fileName:     z.string().min(1),
  mimeType:     z.string().min(1),
});

const uploadCompleteSchema = z.object({
  documentId:  z.string().min(1),
  versionId:   z.string().min(1),
  sizeBytes:   z.number().int().positive().optional(),
  sha256:      z.string().optional(),
});

const patchDocumentSchema = z.object({
  title:       z.string().min(1).optional(),
  description: z.string().optional(),
  category:    z.enum(DOCUMENT_CATEGORIES).optional(),
  status:      z.string().optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' });

// Legacy upload schema (backward compat)
const uploadSchema = z.object({
  relatedType: z.string().min(1),
  relatedId:   z.string().min(1),
  name:        z.string().min(1),
  mimeType:    z.string().min(1),
});

// Legacy confirm schema (backward compat — accepts old and new vocabulary)
const confirmSchema = z.object({
  status: z.enum(['EXECUTED', 'CONFIRMED_EXTERNAL', 'FULLY_EXECUTED', 'VERIFIED_EXTERNAL']),
});

// ── Orchestration helper ──────────────────────────────────────────────────────

/**
 * After a LEASE_AGREEMENT document is marked VERIFIED_EXTERNAL or FULLY_EXECUTED,
 * notify lease-service to activate the lease (which in turn activates tenants + unit).
 */
async function triggerLeaseActivation(leaseId: string, orgId: string): Promise<void> {
  const url = `${LEASE_SERVICE_URL}/internal/leases/${encodeURIComponent(leaseId)}/activate-from-document`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Service-Key': INTERNAL_SERVICE_KEY,
    },
    body: JSON.stringify({ organizationId: orgId }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.error({ status: res.status, body, leaseId, orgId }, 'Lease activation failed after document verified');
    throw new AppError(
      'LEASE_ACTIVATION_FAILED',
      422,
      `Document marked verified but lease activation returned ${res.status}. Check lease status.`,
    );
  }

  logger.info({ leaseId, orgId }, 'Lease activation triggered from document verification');
}

// ════════════════════════════════════════════════════════════════════════════
// INTERNAL ENDPOINTS (service-to-service, protected by X-Internal-Service-Key)
// ════════════════════════════════════════════════════════════════════════════

// ── GET /lease-proof — Activation proof check ─────────────────────────────────
// Returns { qualified: boolean, document: row | null }
router.get('/lease-proof', (req: Request, res: Response, next: NextFunction) => {
  if (!validateInternalKey(req, res)) return;
  const { leaseId, organizationId } = req.query as { leaseId?: string; organizationId?: string };
  if (!leaseId || !organizationId) {
    return res.status(400).json({ error: { code: 'MISSING_PARAMS', message: 'leaseId and organizationId are required' } });
  }
  const placeholders = ACTIVATABLE_STATUSES.map((_, i) => `$${i + 3}`).join(', ');
  queryOne<{ id: string; status: string }>(
    `SELECT id, status
     FROM document_service.documents
     WHERE related_id = $1
       AND related_type = 'LEASE'
       AND organization_id = $2
       AND status IN (${placeholders})
     LIMIT 1`,
    [leaseId, organizationId, ...ACTIVATABLE_STATUSES],
  )
    .then((row) => res.json({ qualified: !!row, document: row || null }))
    .catch(next);
});

// ════════════════════════════════════════════════════════════════════════════
// OWNER ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════

// ── GET /lease/:leaseId/execution-status ─────────────────────────────────────
router.get('/lease/:leaseId/execution-status', requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const { leaseId } = req.params;

      const row = await queryOne<{ id: string; status: string }>(
        `SELECT id, status
         FROM document_service.documents
         WHERE related_id = $1
           AND related_type = 'LEASE'
           AND organization_id = $2
           AND category = 'LEASE_AGREEMENT'
           AND archived_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
        [leaseId, user.orgId],
      );

      let executionStatus: string = 'NONE';
      if (row) {
        const s = row.status;
        if (s === 'FULLY_EXECUTED' || s === 'EXECUTED') executionStatus = 'FULLY_EXECUTED';
        else if (s === 'VERIFIED_EXTERNAL' || s === 'CONFIRMED_EXTERNAL') executionStatus = 'VERIFIED_EXTERNAL';
        else if (s === 'UPLOADED') executionStatus = 'UPLOADED';
        else executionStatus = s;
      }

      res.json({
        data: {
          leaseId,
          hasLeaseAgreement: !!row,
          executionStatus,
          documentId: row?.id || null,
        },
      });
    } catch (err) { next(err); }
  },
);

// ── POST /upload-url — Create document + presigned PUT URL ───────────────────
router.post('/upload-url', requireAuth, requireRole(UserRole.OWNER),
  validateBody(uploadUrlSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const { relatedType, relatedId, category, title, description, fileName, mimeType } = req.body;

      const storageKey = `${user.orgId}/${relatedType}/${relatedId}/${Date.now()}-${fileName}`;
      const storageBucket = S3_BUCKET || 'PENDING';

      // Create document record in DRAFT status
      const doc = await queryOne<{ id: string }>(
        `INSERT INTO document_service.documents
           (organization_id, category, status, related_type, related_id,
            title, description, created_by_user_id, updated_at)
         VALUES ($1, $2, 'DRAFT', $3, $4, $5, $6, $7, NOW())
         RETURNING *`,
        [user.orgId, category, relatedType, relatedId, title, description || null, user.userId],
      );
      if (!doc) throw new AppError('DB_ERROR', 500, 'Failed to create document record');

      // Create version 1 with storage location
      const version = await queryOne(
        `INSERT INTO document_service.document_versions
           (document_id, version_number, storage_bucket, storage_key,
            file_name, original_file_name, mime_type, uploaded_by_user_id)
         VALUES ($1, 1, $2, $3, $4, $4, $5, $6)
         RETURNING *`,
        [(doc as any).id, storageBucket, storageKey, fileName, mimeType, user.userId],
      );

      let uploadUrl: string;
      if (S3_BUCKET) {
        uploadUrl = await presignPut(storageKey, mimeType);
      } else {
        uploadUrl = `placeholder://upload/${storageKey}`;
      }

      logger.info({ documentId: (doc as any).id, storageKey, category }, 'Upload URL generated');

      res.status(201).json({ data: doc, version, uploadUrl, storageKey });
    } catch (err: any) {
      // Log structured detail for DB/schema errors to accelerate debugging
      if (err?.code || err?.constraint || err?.column) {
        logger.error(
          { pgCode: err.code, constraint: err.constraint, column: err.column, detail: err.detail, table: err.table },
          'upload-url DB error — possible schema drift or NOT NULL violation',
        );
      }
      next(err);
    }
  },
);

// ── POST /upload-complete — Mark document as uploaded ────────────────────────
router.post('/upload-complete', requireAuth, requireRole(UserRole.OWNER),
  validateBody(uploadCompleteSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const { documentId, versionId, sizeBytes, sha256 } = req.body;

      const doc = await queryOne<{ id: string; status: string }>(
        `SELECT id, status FROM document_service.documents
         WHERE id = $1 AND organization_id = $2`,
        [documentId, user.orgId],
      );
      if (!doc) throw new NotFoundError('Document not found');

      const version = await queryOne(
        `SELECT id FROM document_service.document_versions
         WHERE id = $1 AND document_id = $2`,
        [versionId, documentId],
      );
      if (!version) throw new NotFoundError('Document version not found');

      if (sizeBytes !== undefined || sha256 !== undefined) {
        await queryOne(
          `UPDATE document_service.document_versions
           SET size_bytes = COALESCE($1, size_bytes),
               sha256 = COALESCE($2, sha256)
           WHERE id = $3`,
          [sizeBytes || null, sha256 || null, versionId],
        );
      }

      const updated = await queryOne(
        `UPDATE document_service.documents
         SET status = 'UPLOADED', current_version_id = $1, updated_at = NOW()
         WHERE id = $2 AND organization_id = $3
         RETURNING *`,
        [versionId, documentId, user.orgId],
      );

      await queryOne(
        `INSERT INTO document_service.document_audit_events
           (document_id, event_type, actor_user_id, actor_role, metadata_json)
         VALUES ($1, 'UPLOAD_COMPLETE', $2, 'OWNER', $3)`,
        [documentId, user.userId, JSON.stringify({ versionId, sizeBytes, sha256 })],
      );

      logger.info({ documentId, versionId }, 'Upload complete — document marked UPLOADED');
      res.json({ data: updated });
    } catch (err) { next(err); }
  },
);

// ── GET / — Owner: list documents ─────────────────────────────────────────────
router.get('/', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const pg = parsePagination(req.query as Record<string, unknown>);
      const offset = (pg.page - 1) * pg.limit;

      const { relatedType, relatedId, category, status } = req.query as Record<string, string | undefined>;

      let whereClause = `organization_id = $1 AND archived_at IS NULL`;
      const params: unknown[] = [user.orgId];
      let idx = 2;

      if (relatedType) { whereClause += ` AND related_type = $${idx}`; params.push(relatedType); idx++; }
      if (relatedId)   { whereClause += ` AND related_id = $${idx}`;   params.push(relatedId);   idx++; }
      if (category)    { whereClause += ` AND category = $${idx}`;     params.push(category);    idx++; }
      if (status)      { whereClause += ` AND status = $${idx}`;       params.push(status);      idx++; }

      const [rows, countResult] = await Promise.all([
        query(
          `SELECT id, organization_id, category, status, related_type, related_id,
                  title, description, current_version_id, created_by_user_id,
                  created_at, updated_at, archived_at
           FROM document_service.documents
           WHERE ${whereClause}
           ORDER BY created_at DESC
           LIMIT $${idx} OFFSET $${idx + 1}`,
          [...params, pg.limit, offset],
        ),
        queryOne<{ count: string }>(
          `SELECT COUNT(*) as count FROM document_service.documents WHERE ${whereClause}`,
          params,
        ),
      ]);

      res.json({ data: rows, meta: paginationMeta(Number(countResult?.count || 0), pg) });
    } catch (err) { next(err); }
  },
);

// ── GET /mine — Tenant's own documents ───────────────────────────────────────
router.get('/mine', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const pg = parsePagination(req.query as Record<string, unknown>);
    const offset = (pg.page - 1) * pg.limit;

    const [rows, countResult] = await Promise.all([
      query(
        `SELECT d.id, d.organization_id, d.related_type, d.related_id,
                d.category, d.title, d.status, d.mime_type,
                d.created_by_user_id, d.created_at, d.updated_at
         FROM document_service.documents d
         JOIN lease_service.lease_tenants lt ON d.related_id = lt.lease_id AND d.related_type = 'LEASE'
         JOIN lease_service.leases l ON l.id = lt.lease_id AND l.org_id = $2
         WHERE lt.tenant_id = $1
           AND d.archived_at IS NULL
         ORDER BY d.created_at DESC LIMIT $3 OFFSET $4`,
        [user.userId, user.orgId, pg.limit, offset],
      ),
      queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM document_service.documents d
         JOIN lease_service.lease_tenants lt ON d.related_id = lt.lease_id AND d.related_type = 'LEASE'
         JOIN lease_service.leases l ON l.id = lt.lease_id AND l.org_id = $2
         WHERE lt.tenant_id = $1 AND d.archived_at IS NULL`,
        [user.userId, user.orgId],
      ),
    ]);

    res.json({ data: rows, meta: paginationMeta(Number(countResult?.count || 0), pg) });
  } catch (err) { next(err); }
});

// ── GET /:id — Document metadata ──────────────────────────────────────────────
router.get('/:id', requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const row = await queryOne(
        `SELECT id, organization_id, category, status, related_type, related_id,
                title, description, current_version_id, created_by_user_id,
                created_at, updated_at, archived_at
         FROM document_service.documents
         WHERE id = $1 AND organization_id = $2`,
        [req.params.id, user.orgId],
      );
      if (!row) throw new NotFoundError('Document not found');

      if (user.role === UserRole.TENANT) {
        const ownership = await queryOne(
          `SELECT lt.tenant_id FROM lease_service.lease_tenants lt
           WHERE lt.tenant_id = $1 AND lt.lease_id = $2`,
          [user.userId, (row as any).related_id],
        );
        if (!ownership) throw new NotFoundError('Document not found');
      }

      res.json({ data: row });
    } catch (err) { next(err); }
  },
);

// ── PATCH /:id — Owner: update document metadata ─────────────────────────────
router.patch('/:id', requireAuth, requireRole(UserRole.OWNER),
  validateBody(patchDocumentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const existing = await queryOne<{ id: string; status: string }>(
        `SELECT id, status FROM document_service.documents WHERE id = $1 AND organization_id = $2`,
        [req.params.id, user.orgId],
      );
      if (!existing) throw new NotFoundError('Document not found');

      const { title, description, category, status } = req.body;

      if (status !== undefined && status !== existing.status) {
        if (!OWNER_PATCH_STATUS_TARGETS.includes(status)) {
          throw new AppError('INVALID_STATUS_TRANSITION', 400,
            `Use mark-verified-external for verification, or valid target statuses: ${OWNER_PATCH_STATUS_TARGETS.join(', ')}`);
        }
      }

      const sets: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      if (title !== undefined)       { sets.push(`title = $${idx}`);       values.push(title);       idx++; }
      if (description !== undefined) { sets.push(`description = $${idx}`); values.push(description); idx++; }
      if (category !== undefined)    { sets.push(`category = $${idx}`);    values.push(category);    idx++; }
      if (status !== undefined)      { sets.push(`status = $${idx}`);      values.push(status);      idx++; }

      sets.push(`updated_at = NOW()`);
      values.push(req.params.id, user.orgId);

      const row = await queryOne(
        `UPDATE document_service.documents
         SET ${sets.join(', ')}
         WHERE id = $${idx} AND organization_id = $${idx + 1}
         RETURNING *`,
        values,
      );
      if (!row) throw new NotFoundError('Document not found');

      res.json({ data: row });
    } catch (err) { next(err); }
  },
);

// ── POST /:id/mark-verified-external ─────────────────────────────────────────
router.post('/:id/mark-verified-external', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;

      const existing = await queryOne<{
        id: string; status: string; category: string; related_type: string; related_id: string;
      }>(
        `SELECT id, status, category, related_type, related_id
         FROM document_service.documents
         WHERE id = $1 AND organization_id = $2`,
        [req.params.id, user.orgId],
      );
      if (!existing) throw new NotFoundError('Document not found');

      if (existing.status === 'VERIFIED_EXTERNAL') {
        return res.json({ data: existing, alreadyVerified: true });
      }

      if (!['UPLOADED', 'DRAFT', 'PENDING_TENANT_SIGNATURE'].includes(existing.status)) {
        throw new AppError('INVALID_STATUS_TRANSITION', 400,
          `Cannot mark document in status '${existing.status}' as verified external. Document must be in UPLOADED status.`);
      }

      const updated = await queryOne(
        `UPDATE document_service.documents
         SET status = 'VERIFIED_EXTERNAL', updated_at = NOW()
         WHERE id = $1 AND organization_id = $2
         RETURNING *`,
        [req.params.id, user.orgId],
      );
      if (!updated) throw new NotFoundError('Document not found');

      await queryOne(
        `INSERT INTO document_service.document_audit_events
           (document_id, event_type, actor_user_id, actor_role, metadata_json)
         VALUES ($1, 'VERIFIED_EXTERNAL', $2, 'OWNER', $3)`,
        [req.params.id, user.userId, JSON.stringify({ previousStatus: existing.status })],
      );

      logger.info(
        { documentId: req.params.id, category: existing.category, relatedId: existing.related_id },
        'Document marked VERIFIED_EXTERNAL',
      );

      // Phase 5 orchestration: trigger lease activation for LEASE_AGREEMENT docs
      if (existing.category === 'LEASE_AGREEMENT' && existing.related_type === 'LEASE') {
        await triggerLeaseActivation(existing.related_id, user.orgId);
      }

      res.json({ data: updated });
    } catch (err) { next(err); }
  },
);

// ── GET /:id/download — Presigned download URL ────────────────────────────────
router.get('/:id/download', requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const row = await queryOne<{
        id: string; related_id: string; current_version_id: string | null; s3_key: string | null;
      }>(
        `SELECT id, related_id, current_version_id, s3_key
         FROM document_service.documents
         WHERE id = $1 AND organization_id = $2`,
        [req.params.id, user.orgId],
      );
      if (!row) throw new NotFoundError('Document not found');

      if (user.role === UserRole.TENANT) {
        const ownership = await queryOne(
          `SELECT lt.tenant_id FROM lease_service.lease_tenants lt
           WHERE lt.tenant_id = $1 AND lt.lease_id = $2`,
          [user.userId, row.related_id],
        );
        if (!ownership) throw new NotFoundError('Document not found');
      }

      // Resolve storage key: prefer document_versions, fall back to legacy s3_key
      let storageKey: string | null = null;
      if (row.current_version_id) {
        const version = await queryOne<{ storage_key: string }>(
          `SELECT storage_key FROM document_service.document_versions WHERE id = $1`,
          [row.current_version_id],
        );
        storageKey = version?.storage_key || null;
      }
      if (!storageKey) storageKey = row.s3_key || null;
      if (!storageKey) throw new AppError('NO_VERSION', 404, 'Document has no uploaded version yet');

      let downloadUrl: string;
      if (S3_BUCKET) {
        downloadUrl = await presignGet(storageKey);
      } else {
        downloadUrl = `placeholder://download/${storageKey}`;
      }

      res.json({ data: row, downloadUrl });
    } catch (err) { next(err); }
  },
);

// ── DELETE /:id — Owner: soft archive ────────────────────────────────────────
router.delete('/:id', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const row = await queryOne(
        `UPDATE document_service.documents
         SET status = 'ARCHIVED', archived_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL
         RETURNING id`,
        [req.params.id, user.orgId],
      );
      if (!row) throw new NotFoundError('Document not found or already archived');
      res.status(204).send();
    } catch (err) { next(err); }
  },
);

// ════════════════════════════════════════════════════════════════════════════
// DEPRECATED ENDPOINTS — kept for backward compatibility
// Use /upload-url + /upload-complete instead of /upload
// Use /mark-verified-external instead of /:id/confirm
// ════════════════════════════════════════════════════════════════════════════

/** @deprecated Use POST /upload-url + POST /upload-complete instead. */
router.post('/upload', requireAuth, requireRole(UserRole.OWNER),
  validateBody(uploadSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const { relatedType, relatedId, name, mimeType } = req.body;

      const storageKey = `${user.orgId}/${relatedType}/${relatedId}/${Date.now()}-${name}`;

      const row = await queryOne(
        `INSERT INTO document_service.documents
           (organization_id, category, related_type, related_id,
            title, mime_type, s3_key, created_by_user_id, status, updated_at)
         VALUES ($1, 'OWNER_UPLOAD', $2, $3, $4, $5, $6, $7, 'UPLOADED', NOW())
         RETURNING *`,
        [user.orgId, relatedType, relatedId, name, mimeType, storageKey, user.userId],
      );

      let uploadUrl: string;
      if (S3_BUCKET) {
        uploadUrl = await presignPut(storageKey, mimeType);
      } else {
        uploadUrl = `placeholder://upload/${storageKey}`;
      }

      logger.info({ documentId: (row as any)?.id, storageKey }, 'Document created via legacy /upload');
      res.status(201).json({ data: row, uploadUrl });
    } catch (err) { next(err); }
  },
);

/** @deprecated Use POST /:id/mark-verified-external instead. */
router.post('/:id/confirm', requireAuth, requireRole(UserRole.OWNER),
  validateBody(confirmSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      let { status } = req.body as { status: string };
      // Normalize legacy status values to Phase 1 vocabulary
      if (status === 'EXECUTED') status = 'FULLY_EXECUTED';
      if (status === 'CONFIRMED_EXTERNAL') status = 'VERIFIED_EXTERNAL';

      const existing = await queryOne<{
        id: string; status: string; category: string; related_type: string; related_id: string;
      }>(
        `SELECT id, status, category, related_type, related_id
         FROM document_service.documents
         WHERE id = $1 AND organization_id = $2`,
        [req.params.id, user.orgId],
      );
      if (!existing) throw new NotFoundError('Document not found');

      // Cross-vocabulary idempotency: treat legacy ↔ Phase 1 equivalents as matches
      const isAlreadyTarget =
        existing.status === status ||
        (existing.status === 'CONFIRMED_EXTERNAL' && status === 'VERIFIED_EXTERNAL') ||
        (existing.status === 'EXECUTED' && status === 'FULLY_EXECUTED');
      if (isAlreadyTarget) {
        return res.json({ data: existing });
      }

      const allowedSources = ['UPLOADED', 'DRAFT', 'FULLY_EXECUTED', 'VERIFIED_EXTERNAL', 'EXECUTED', 'CONFIRMED_EXTERNAL'];
      if (!allowedSources.includes(existing.status)) {
        throw new AppError('INVALID_STATUS', 400, `Cannot confirm document in status: ${existing.status}`);
      }

      const row = await queryOne(
        `UPDATE document_service.documents
         SET status = $1, updated_at = NOW()
         WHERE id = $2 AND organization_id = $3
         RETURNING *`,
        [status, req.params.id, user.orgId],
      );
      if (!row) throw new NotFoundError('Document not found');

      await queryOne(
        `INSERT INTO document_service.document_audit_events
           (document_id, event_type, actor_user_id, actor_role, metadata_json)
         VALUES ($1, 'STATUS_CONFIRMED', $2, 'OWNER', $3)`,
        [req.params.id, user.userId, JSON.stringify({ newStatus: status, via: 'legacy_confirm' })],
      );

      logger.info({ documentId: req.params.id, newStatus: status }, 'Document status confirmed (legacy endpoint)');

      // Trigger lease activation for qualifying LEASE_AGREEMENT docs
      if (
        (status === 'VERIFIED_EXTERNAL' || status === 'FULLY_EXECUTED') &&
        existing.category === 'LEASE_AGREEMENT' &&
        existing.related_type === 'LEASE'
      ) {
        triggerLeaseActivation(existing.related_id, user.orgId).catch((err) => {
          logger.warn({ err, documentId: req.params.id }, 'Lease activation trigger failed via legacy /confirm');
        });
      }

      res.json({ data: row });
    } catch (err) { next(err); }
  },
);

export { router as documentsRouter };
