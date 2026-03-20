import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
  requireAuth, requireRole, validateBody,
  query, queryOne, NotFoundError, AppError, logger,
  parsePagination, paginationMeta,
  type AuthenticatedRequest, UserRole,
} from '@leasebase/service-common';

const router = Router();

const S3_BUCKET = process.env.S3_DOCUMENTS_BUCKET || '';

// Note: In production, presigned URLs are generated via AWS SDK S3 client.
// For now, we store metadata in DB and return presigned URL placeholders.

// ── Document status constants ────────────────────────────────────────────────
// These are the durable lifecycle states for a lease document.
//   UPLOADED           — stored but not yet confirmed/executed
//   EXECUTED           — signed/executed through the platform
//   CONFIRMED_EXTERNAL — owner confirmed an externally-executed doc is on file
//
// A document is considered "activation-sufficient" when its status is either
// EXECUTED or CONFIRMED_EXTERNAL.  The lease-service activation gate queries
// this table before promoting ACKNOWLEDGED → ACTIVE.
export const DOCUMENT_STATUSES = ['UPLOADED', 'EXECUTED', 'CONFIRMED_EXTERNAL'] as const;
export const ACTIVATABLE_STATUSES = ['EXECUTED', 'CONFIRMED_EXTERNAL'] as const;

const uploadSchema = z.object({
  relatedType: z.string().min(1),
  relatedId: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
});

const confirmSchema = z.object({
  /** New status — owner can promote a document to EXECUTED or CONFIRMED_EXTERNAL. */
  status: z.enum(['EXECUTED', 'CONFIRMED_EXTERNAL']),
});

// GET / - List documents
router.get('/', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const pg = parsePagination(req.query as Record<string, unknown>);
      const offset = (pg.page - 1) * pg.limit;

      const relatedType = req.query.relatedType as string | undefined;
      const relatedId = req.query.relatedId as string | undefined;

      let whereClause = `organization_id = $1`;
      const params: unknown[] = [user.orgId];
      let idx = 2;

      if (relatedType) { whereClause += ` AND related_type = $${idx}`; params.push(relatedType); idx++; }
      if (relatedId) { whereClause += ` AND related_id = $${idx}`; params.push(relatedId); idx++; }

      const [rows, countResult] = await Promise.all([
        query(`SELECT * FROM documents WHERE ${whereClause} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
          [...params, pg.limit, offset]),
        queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM documents WHERE ${whereClause}`, params),
      ]);

      res.json({ data: rows, meta: paginationMeta(Number(countResult?.count || 0), pg) });
    } catch (err) { next(err); }
  }
);

// GET /mine - Tenant's own documents (resolved via JWT → lease_tenants → lease)
router.get('/mine', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const pg = parsePagination(req.query as Record<string, unknown>);
    const offset = (pg.page - 1) * pg.limit;

    // Fail closed: resolve through lease_tenants JOIN — only LEASE-related documents
    // Exclude s3_key from tenant response (internal storage detail)
    const [rows, countResult] = await Promise.all([
      query(
        `SELECT d.id, d.organization_id, d.related_type, d.related_id, d.name, d.mime_type,
                d.created_by_user_id, d.created_at, d.updated_at
         FROM documents d
         JOIN lease_service.lease_tenants lt ON d.related_id = lt.lease_id AND d.related_type = 'LEASE'
         JOIN lease_service.leases l ON l.id = lt.lease_id AND l.org_id = $2
         WHERE lt.tenant_id = $1
         ORDER BY d.created_at DESC LIMIT $3 OFFSET $4`,
        [user.userId, user.orgId, pg.limit, offset],
      ),
      queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM documents d
         JOIN lease_service.lease_tenants lt ON d.related_id = lt.lease_id AND d.related_type = 'LEASE'
         JOIN lease_service.leases l ON l.id = lt.lease_id AND l.org_id = $2
         WHERE lt.tenant_id = $1`,
        [user.userId, user.orgId],
      ),
    ]);

    res.json({ data: rows, meta: paginationMeta(Number(countResult?.count || 0), pg) });
  } catch (err) { next(err); }
});

// POST /upload - Upload document (returns presigned upload URL)
// Status is set to UPLOADED on creation; owner must subsequently confirm/mark
// as EXECUTED or CONFIRMED_EXTERNAL before lease activation is allowed.
router.post('/upload', requireAuth, requireRole(UserRole.OWNER),
  validateBody(uploadSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const { relatedType, relatedId, name, mimeType } = req.body;

      const s3Key = `${user.orgId}/${relatedType}/${relatedId}/${Date.now()}-${name}`;

      const row = await queryOne(
        `INSERT INTO documents
         (organization_id, related_type, related_id, name, s3_key, mime_type, created_by_user_id, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'UPLOADED', NOW())
         RETURNING *`,
        [user.orgId, relatedType, relatedId, name, s3Key, mimeType, user.userId],
      );

      // In production, generate presigned PUT URL:
      // const url = await getSignedUrl(s3Client, new PutObjectCommand({Bucket, Key: s3Key, ContentType: mimeType}), {expiresIn: 3600});
      const uploadUrl = S3_BUCKET ? `https://${S3_BUCKET}.s3.amazonaws.com/${s3Key}` : `placeholder://upload/${s3Key}`;

      logger.info({ documentId: (row as any)?.id, s3Key, status: 'UPLOADED' }, 'Document metadata created');
      res.status(201).json({ data: row, uploadUrl });
    } catch (err) { next(err); }
  },
);

// POST /:id/confirm - Owner confirms document execution status
// Promotes a document to EXECUTED or CONFIRMED_EXTERNAL.
// This is the machine-checkable signal that satisfies the lease activation gate.
router.post('/:id/confirm', requireAuth, requireRole(UserRole.OWNER),
  validateBody(confirmSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const { status } = req.body as { status: 'EXECUTED' | 'CONFIRMED_EXTERNAL' };

      // Verify ownership and that the current status allows promotion
      const existing = await queryOne<{ id: string; status: string; related_type: string; related_id: string }>(
        `SELECT id, status, related_type, related_id FROM documents
         WHERE id = $1 AND organization_id = $2`,
        [req.params.id, user.orgId],
      );
      if (!existing) throw new NotFoundError('Document not found');

      // Allow UPLOADED → EXECUTED or CONFIRMED_EXTERNAL (idempotent if already at target)
      if (existing.status === status) {
        return res.json({ data: existing });
      }
      if (!(['UPLOADED', 'EXECUTED', 'CONFIRMED_EXTERNAL'] as string[]).includes(existing.status)) {
        throw new AppError('INVALID_STATUS', 400, `Cannot confirm document in status: ${existing.status}`);
      }

      const row = await queryOne(
        `UPDATE documents SET status = $1, updated_at = NOW()
         WHERE id = $2 AND organization_id = $3
         RETURNING *`,
        [status, req.params.id, user.orgId],
      );
      if (!row) throw new NotFoundError('Document not found');

      logger.info(
        { documentId: req.params.id, newStatus: status, relatedType: existing.related_type, relatedId: existing.related_id },
        'Document status confirmed by owner',
      );

      res.json({ data: row });
    } catch (err) { next(err); }
  },
);

// GET /:id - Get document metadata (OWNER or TENANT with lease-ownership check)
router.get('/:id', requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const row = await queryOne(`SELECT * FROM documents WHERE id = $1 AND organization_id = $2`, [req.params.id, user.orgId]);
      if (!row) throw new NotFoundError('Document not found');

      // TENANT: verify document belongs to a lease the tenant owns (via lease_tenants)
      if (user.role === UserRole.TENANT) {
        const ownership = await queryOne(
          `SELECT lt.tenant_id AS user_id FROM lease_service.lease_tenants lt
           WHERE lt.tenant_id = $1 AND lt.lease_id = $2`,
          [user.userId, (row as any).related_id],
        );
        if (!ownership) throw new NotFoundError('Document not found');
      }

      res.json({ data: row });
    } catch (err) { next(err); }
  }
);

// GET /:id/download - Get download URL (OWNER or TENANT with lease-ownership check)
router.get('/:id/download', requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const row = await queryOne<{ s3_key: string; related_id: string }>(
        `SELECT * FROM documents WHERE id = $1 AND organization_id = $2`,
        [req.params.id, user.orgId],
      );
      if (!row) throw new NotFoundError('Document not found');

      // TENANT: verify document belongs to a lease the tenant owns (via lease_tenants)
      if (user.role === UserRole.TENANT) {
        const ownership = await queryOne(
          `SELECT lt.tenant_id AS user_id FROM lease_service.lease_tenants lt
           WHERE lt.tenant_id = $1 AND lt.lease_id = $2`,
          [user.userId, row.related_id],
        );
        if (!ownership) throw new NotFoundError('Document not found');
      }

      // In production, generate presigned GET URL
      const downloadUrl = S3_BUCKET
        ? `https://${S3_BUCKET}.s3.amazonaws.com/${row.s3_key}`
        : `placeholder://download/${row.s3_key}`;

      res.json({ data: row, downloadUrl });
    } catch (err) { next(err); }
  }
);

// DELETE /:id
router.delete('/:id', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const row = await queryOne(`DELETE FROM documents WHERE id = $1 AND organization_id = $2 RETURNING id, s3_key`, [req.params.id, user.orgId]);
      if (!row) throw new NotFoundError('Document not found');
      // TODO: Also delete from S3
      res.status(204).send();
    } catch (err) { next(err); }
  }
);

export { router as documentsRouter };
