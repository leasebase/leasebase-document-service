import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
  requireAuth, requireRole, validateBody,
  query, queryOne, NotFoundError, logger,
  parsePagination, paginationMeta,
  type AuthenticatedRequest, UserRole,
} from '@leasebase/service-common';

const router = Router();

const S3_BUCKET = process.env.S3_DOCUMENTS_BUCKET || '';

// Note: In production, presigned URLs are generated via AWS SDK S3 client.
// For now, we store metadata in DB and return presigned URL placeholders.

const uploadSchema = z.object({
  relatedType: z.string().min(1),
  relatedId: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
});

// GET / - List documents
router.get('/', requireAuth, requireRole(UserRole.ORG_ADMIN, UserRole.PM_STAFF, UserRole.OWNER),
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

// POST /upload - Upload document (returns presigned upload URL)
router.post('/upload', requireAuth, requireRole(UserRole.ORG_ADMIN, UserRole.PM_STAFF),
  validateBody(uploadSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const { relatedType, relatedId, name, mimeType } = req.body;

      const s3Key = `${user.orgId}/${relatedType}/${relatedId}/${Date.now()}-${name}`;

      const row = await queryOne(
        `INSERT INTO documents (organization_id, related_type, related_id, name, s3_key, mime_type, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [user.orgId, relatedType, relatedId, name, s3Key, mimeType, user.userId]
      );

      // In production, generate presigned PUT URL:
      // const url = await getSignedUrl(s3Client, new PutObjectCommand({Bucket, Key: s3Key, ContentType: mimeType}), {expiresIn: 3600});
      const uploadUrl = S3_BUCKET ? `https://${S3_BUCKET}.s3.amazonaws.com/${s3Key}` : `placeholder://upload/${s3Key}`;

      logger.info({ documentId: (row as any)?.id, s3Key }, 'Document metadata created');
      res.status(201).json({ data: row, uploadUrl });
    } catch (err) { next(err); }
  }
);

// GET /:id - Get document metadata
router.get('/:id', requireAuth, requireRole(UserRole.ORG_ADMIN, UserRole.PM_STAFF, UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const row = await queryOne(`SELECT * FROM documents WHERE id = $1 AND organization_id = $2`, [req.params.id, user.orgId]);
      if (!row) throw new NotFoundError('Document not found');
      res.json({ data: row });
    } catch (err) { next(err); }
  }
);

// GET /:id/download - Get download URL
router.get('/:id/download', requireAuth, requireRole(UserRole.ORG_ADMIN, UserRole.PM_STAFF, UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const row = await queryOne<{ s3_key: string }>(`SELECT * FROM documents WHERE id = $1 AND organization_id = $2`, [req.params.id, user.orgId]);
      if (!row) throw new NotFoundError('Document not found');

      // In production, generate presigned GET URL
      const downloadUrl = S3_BUCKET
        ? `https://${S3_BUCKET}.s3.amazonaws.com/${row.s3_key}`
        : `placeholder://download/${row.s3_key}`;

      res.json({ data: row, downloadUrl });
    } catch (err) { next(err); }
  }
);

// DELETE /:id
router.delete('/:id', requireAuth, requireRole(UserRole.ORG_ADMIN),
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
