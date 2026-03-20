import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { Writable } from 'node:stream';
import PDFDocument from 'pdfkit';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  requireAuth, requireRole, queryOne, query, NotFoundError, AppError, logger,
  type AuthenticatedRequest, UserRole,
} from '@leasebase/service-common';

const router = Router();

// ── Config ────────────────────────────────────────────────────────────────────
const S3_BUCKET            = process.env.S3_DOCUMENTS_BUCKET || '';
const AWS_REGION           = process.env.AWS_REGION || 'us-east-1';
const PRESIGN_UPLOAD_EXPIRES = 3600;

const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3007';
const LEASE_SERVICE_URL        = process.env.LEASE_SERVICE_URL        || 'http://localhost:3003';
const INTERNAL_SERVICE_KEY     = process.env.INTERNAL_SERVICE_KEY     || '';

const s3Client = new S3Client({ region: AWS_REGION });

// ── Helpers ───────────────────────────────────────────────────────────────────

async function presignPut(key: string, mimeType: string): Promise<string> {
  return getSignedUrl(
    s3Client,
    new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, ContentType: mimeType }),
    { expiresIn: PRESIGN_UPLOAD_EXPIRES },
  );
}

async function emitNotification(payload: {
  organizationId: string;
  recipientUserIds: string[];
  eventType: string;
  title: string;
  body: string;
  relatedType?: string;
  relatedId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const logCtx = {
    eventType:      payload.eventType,
    organizationId: payload.organizationId,
    recipientCount: payload.recipientUserIds.length,
    relatedType:    payload.relatedType,
    relatedId:      payload.relatedId,
  };
  try {
    const res = await fetch(`${NOTIFICATION_SERVICE_URL}/internal/notifications/internal-emit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': INTERNAL_SERVICE_KEY },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const responseBody = await res.text().catch(() => '');
      logger.warn(
        { ...logCtx, httpStatus: res.status, responseBody },
        'Notification emit failed — HTTP error (non-fatal)',
      );
    } else {
      logger.info(logCtx, 'Notification emitted successfully');
    }
  } catch (err: any) {
    logger.warn(
      { ...logCtx, errorMessage: err?.message ?? String(err) },
      'Notification emit threw — network/config error (non-fatal)',
    );
  }
}

async function triggerLeaseActivation(leaseId: string, orgId: string): Promise<void> {
  const res = await fetch(
    `${LEASE_SERVICE_URL}/internal/leases/${encodeURIComponent(leaseId)}/activate-from-document`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': INTERNAL_SERVICE_KEY },
      body: JSON.stringify({ organizationId: orgId }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.error({ status: res.status, body, leaseId }, 'Lease activation failed from generated doc completion');
    throw new AppError('LEASE_ACTIVATION_FAILED', 422,
      `Document completed but lease activation returned ${res.status}. Check lease status.`);
  }
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const TEMPLATE_CATEGORIES = [
  'LEASE_AGREEMENT', 'LEASE_ADDENDUM', 'NOTICE',
  'MOVE_IN_CHECKLIST', 'MOVE_OUT_CHECKLIST', 'OWNER_UPLOAD',
] as const;

const VARIABLE_DATA_TYPES = ['STRING', 'NUMBER', 'DATE', 'BOOLEAN', 'CURRENCY', 'TEXT'] as const;

const createTemplateSchema = z.object({
  name:        z.string().min(1),
  description: z.string().optional(),
  category:    z.enum(TEMPLATE_CATEGORIES).default('LEASE_AGREEMENT'),
});

const updateTemplateSchema = z.object({
  name:        z.string().min(1).optional(),
  description: z.string().optional(),
  category:    z.enum(TEMPLATE_CATEGORIES).optional(),
  is_active:   z.boolean().optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' });

// TEXT = in-DB content_text (supported for generation in Phase 2).
// PDF / DOCX / HTML = S3-backed file storage (stored but NOT used for generation in Phase 2).
const templateVersionUploadUrlSchema = z.object({
  fileName:      z.string().min(1),
  mimeType:      z.string().min(1),
  sourceFormat:  z.enum(['TEXT', 'PDF', 'DOCX', 'HTML']).default('PDF'),
  contentText:   z.string().optional(),
});

const templateVersionCompleteSchema = z.object({
  versionId: z.string().min(1),
});

const variableSchema = z.object({
  variable_key:       z.string().min(1),
  label:              z.string().min(1),
  data_type:          z.enum(VARIABLE_DATA_TYPES).default('STRING'),
  required:           z.boolean().default(false),
  default_value_json: z.string().optional(),
  sort_order:         z.number().int().default(0),
});

const setVariablesSchema = z.array(variableSchema);

const generateSchema = z.object({
  leaseId:   z.string().min(1),
  variables: z.record(z.unknown()).default({}),
  title:     z.string().optional(),
});

// ═════════════════════════════════════════════════════════════════════════════
// TEMPLATE ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════════

// ── POST /templates ─────────────────────────────────────────────────────────
router.post('/', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const parsed = createTemplateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.errors } });
      }
      const { name, description, category } = parsed.data;

      const row = await queryOne(
        `INSERT INTO document_service.document_templates
           (organization_id, category, name, description, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [user.orgId, category, name, description || null, user.userId],
      );

      logger.info({ templateId: (row as any)?.id, orgId: user.orgId }, 'Template created');
      res.status(201).json({ data: row });
    } catch (err) { next(err); }
  },
);

// ── GET /templates — List templates ────────────────────────────────────────
router.get('/', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const { category, active } = req.query as Record<string, string | undefined>;

      let where = `organization_id = $1`;
      const params: unknown[] = [user.orgId];
      let idx = 2;

      if (category) { where += ` AND category = $${idx}`; params.push(category); idx++; }
      if (active !== undefined) { where += ` AND is_active = $${idx}`; params.push(active === 'true'); idx++; }

      const rows = await query(
        `SELECT t.*,
           (SELECT json_agg(tv ORDER BY tv.version_number DESC)
            FROM document_service.document_template_versions tv
            WHERE tv.template_id = t.id
            LIMIT 1) AS latest_version
         FROM document_service.document_templates t
         WHERE ${where}
         ORDER BY t.created_at DESC`,
        params,
      );

      res.json({ data: rows });
    } catch (err) { next(err); }
  },
);

// ── GET /templates/:templateId ───────────────────────────────────────────────
router.get('/:templateId', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const row = await queryOne(
        `SELECT t.*
         FROM document_service.document_templates t
         WHERE t.id = $1 AND t.organization_id = $2`,
        [req.params.templateId, user.orgId],
      );
      if (!row) throw new NotFoundError('Template not found');

      const versions = await query(
        `SELECT * FROM document_service.document_template_versions
         WHERE template_id = $1 ORDER BY version_number DESC`,
        [req.params.templateId],
      );

      res.json({ data: { ...(row as any), versions } });
    } catch (err) { next(err); }
  },
);

// ── PATCH /templates/:templateId ─────────────────────────────────────────────
router.patch('/:templateId', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const parsed = updateTemplateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.errors } });
      }

      const existing = await queryOne(
        `SELECT id FROM document_service.document_templates WHERE id = $1 AND organization_id = $2`,
        [req.params.templateId, user.orgId],
      );
      if (!existing) throw new NotFoundError('Template not found');

      const sets: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      const { name, description, category, is_active } = parsed.data;
      if (name !== undefined)       { sets.push(`name = $${idx}`);        values.push(name);        idx++; }
      if (description !== undefined){ sets.push(`description = $${idx}`); values.push(description); idx++; }
      if (category !== undefined)   { sets.push(`category = $${idx}`);    values.push(category);    idx++; }
      if (is_active !== undefined)  { sets.push(`is_active = $${idx}`);   values.push(is_active);   idx++; }

      sets.push(`updated_at = NOW()`);
      values.push(req.params.templateId, user.orgId);

      const row = await queryOne(
        `UPDATE document_service.document_templates
         SET ${sets.join(', ')}
         WHERE id = $${idx} AND organization_id = $${idx + 1}
         RETURNING *`,
        values,
      );
      if (!row) throw new NotFoundError('Template not found');

      res.json({ data: row });
    } catch (err) { next(err); }
  },
);

// ── DELETE /templates/:templateId ────────────────────────────────────────────
router.delete('/:templateId', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const row = await queryOne(
        `UPDATE document_service.document_templates
         SET is_active = false, updated_at = NOW()
         WHERE id = $1 AND organization_id = $2 AND is_active = true
         RETURNING id`,
        [req.params.templateId, user.orgId],
      );
      if (!row) throw new NotFoundError('Template not found or already archived');
      res.status(204).send();
    } catch (err) { next(err); }
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// TEMPLATE VERSIONS
// ═════════════════════════════════════════════════════════════════════════════

// ── POST /templates/:templateId/versions/upload-url ─────────────────────────
router.post('/:templateId/versions/upload-url', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const parsed = templateVersionUploadUrlSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.errors } });
      }

      const tmpl = await queryOne<{ id: string; organization_id: string }>(
        `SELECT id, organization_id FROM document_service.document_templates
         WHERE id = $1 AND organization_id = $2`,
        [req.params.templateId, user.orgId],
      );
      if (!tmpl) throw new NotFoundError('Template not found');

      const { fileName, mimeType, sourceFormat, contentText } = parsed.data;

      // Get next version number
      const versionCount = await queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM document_service.document_template_versions WHERE template_id = $1`,
        [req.params.templateId],
      );
      const nextVersion = Number(versionCount?.count || 0) + 1;

      const storageKey    = `${user.orgId}/templates/${req.params.templateId}/v${nextVersion}-${fileName}`;
      const storageBucket = S3_BUCKET || 'PENDING';

      const version = await queryOne(
        `INSERT INTO document_service.document_template_versions
           (template_id, version_number, storage_bucket, storage_key,
            source_format, content_text, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [req.params.templateId, nextVersion, storageBucket, storageKey,
         sourceFormat, contentText || null, user.userId],
      );

      let uploadUrl: string;
      if (S3_BUCKET) {
        uploadUrl = await presignPut(storageKey, mimeType);
      } else {
        uploadUrl = `placeholder://upload/${storageKey}`;
      }

      res.status(201).json({ data: version, uploadUrl, storageKey });
    } catch (err) { next(err); }
  },
);

// ── POST /templates/:templateId/versions/upload-complete ─────────────────────
router.post('/:templateId/versions/upload-complete', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const parsed = templateVersionCompleteSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.errors } });
      }

      const tmpl = await queryOne(
        `SELECT id FROM document_service.document_templates WHERE id = $1 AND organization_id = $2`,
        [req.params.templateId, user.orgId],
      );
      if (!tmpl) throw new NotFoundError('Template not found');

      const version = await queryOne(
        `SELECT id FROM document_service.document_template_versions
         WHERE id = $1 AND template_id = $2`,
        [parsed.data.versionId, req.params.templateId],
      );
      if (!version) throw new NotFoundError('Template version not found');

      // Update template's updated_at to signal a new version is ready
      await queryOne(
        `UPDATE document_service.document_templates SET updated_at = NOW() WHERE id = $1`,
        [req.params.templateId],
      );

      res.json({ data: version });
    } catch (err) { next(err); }
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// TEMPLATE VARIABLES
// ═════════════════════════════════════════════════════════════════════════════

// ── GET /templates/:templateId/variables ─────────────────────────────────────
router.get('/:templateId/variables', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;

      const tmpl = await queryOne(
        `SELECT id FROM document_service.document_templates WHERE id = $1 AND organization_id = $2`,
        [req.params.templateId, user.orgId],
      );
      if (!tmpl) throw new NotFoundError('Template not found');

      const latestVersion = await queryOne<{ id: string; version_number: number }>(
        `SELECT id, version_number FROM document_service.document_template_versions
         WHERE template_id = $1 ORDER BY version_number DESC LIMIT 1`,
        [req.params.templateId],
      );
      if (!latestVersion) {
        return res.json({ data: [], versionId: null });
      }

      const vars = await query(
        `SELECT * FROM document_service.document_template_variables
         WHERE template_version_id = $1 ORDER BY sort_order ASC, variable_key ASC`,
        [latestVersion.id],
      );

      res.json({ data: vars, versionId: latestVersion.id, versionNumber: latestVersion.version_number });
    } catch (err) { next(err); }
  },
);

// ── PUT /templates/:templateId/variables ─────────────────────────────────────
router.put('/:templateId/variables', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const parsed = setVariablesSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid variables', details: parsed.error.errors } });
      }

      const tmpl = await queryOne(
        `SELECT id FROM document_service.document_templates WHERE id = $1 AND organization_id = $2`,
        [req.params.templateId, user.orgId],
      );
      if (!tmpl) throw new NotFoundError('Template not found');

      const latestVersion = await queryOne<{ id: string }>(
        `SELECT id FROM document_service.document_template_versions
         WHERE template_id = $1 ORDER BY version_number DESC LIMIT 1`,
        [req.params.templateId],
      );
      if (!latestVersion) {
        throw new AppError('NO_VERSION', 400, 'Template has no uploaded version yet. Upload a version first.');
      }

      // Replace all variables for this version
      await query(
        `DELETE FROM document_service.document_template_variables WHERE template_version_id = $1`,
        [latestVersion.id],
      );

      const inserted = [];
      for (const v of parsed.data) {
        const row = await queryOne(
          `INSERT INTO document_service.document_template_variables
             (template_version_id, variable_key, label, data_type,
              required, default_value_json, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [latestVersion.id, v.variable_key, v.label, v.data_type,
           v.required, v.default_value_json || null, v.sort_order],
        );
        inserted.push(row);
      }

      res.json({ data: inserted, versionId: latestVersion.id });
    } catch (err) { next(err); }
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// GENERATION
// ═════════════════════════════════════════════════════════════════════════════

// ── POST /templates/:templateId/generate ─────────────────────────────────────
router.post('/:templateId/generate', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const parsed = generateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.errors } });
      }
      const { leaseId, variables, title } = parsed.data;

      // Resolve template + latest version
      const tmpl = await queryOne<{
        id: string; name: string; category: string; organization_id: string;
      }>(
        `SELECT id, name, category, organization_id
         FROM document_service.document_templates
         WHERE id = $1 AND organization_id = $2 AND is_active = true`,
        [req.params.templateId, user.orgId],
      );
      if (!tmpl) throw new NotFoundError('Template not found or inactive');

      const latestVersion = await queryOne<{
        id: string; version_number: number; content_text: string | null; storage_key: string;
      }>(
        `SELECT id, version_number, content_text, storage_key
         FROM document_service.document_template_versions
         WHERE template_id = $1 ORDER BY version_number DESC LIMIT 1`,
        [req.params.templateId],
      );
      if (!latestVersion) {
        throw new AppError('NO_VERSION', 400, 'Template has no uploaded version. Upload a version first.');
      }

      // Phase 2 generation only supports text-backed templates (content_text must be present).
      // S3-backed versions (source_format=PDF/DOCX/HTML without content_text) are stored but
      // cannot be used for generation until a provider rendering pipeline is added in Phase 3.
      if (!latestVersion.content_text) {
        throw new AppError(
          'UNSUPPORTED_TEMPLATE_FORMAT', 422,
          'This template version has no in-DB text content. ' +
          'Phase 2 generation only supports text-backed templates. ' +
          'Upload a new version with source_format=TEXT and a populated content_text body.',
        );
      }

      // Validate required variables
      const requiredVars = await query<{ variable_key: string; label: string }>(
        `SELECT variable_key, label FROM document_service.document_template_variables
         WHERE template_version_id = $1 AND required = true`,
        [latestVersion.id],
      );
      const missing = requiredVars.filter((v) => !(v.variable_key in variables));
      if (missing.length > 0) {
        throw new AppError(
          'MISSING_VARIABLES', 400,
          `Missing required variables: ${missing.map((v) => v.variable_key).join(', ')}`,
        );
      }

      // Generate PDF in-memory using pdfkit
      const pdfBuffer = await generatePdf(tmpl.name, variables, latestVersion.content_text);

      // Determine storage key
      const docTitle  = title || `${tmpl.name} — ${new Date().toISOString().split('T')[0]}`;
      const fileName  = `${tmpl.name.replace(/\s+/g, '-').toLowerCase()}-generated.pdf`;
      const storageKey = `${user.orgId}/LEASE/${leaseId}/${Date.now()}-${fileName}`;
      const storageBucket = S3_BUCKET || 'PENDING';

      // Upload PDF to S3 if bucket configured
      if (S3_BUCKET) {
        const s3 = new S3Client({ region: AWS_REGION });
        await s3.send(new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: storageKey,
          Body: pdfBuffer,
          ContentType: 'application/pdf',
        }));
      }

      // Create document record
      const doc = await queryOne<{ id: string }>(
        `INSERT INTO document_service.documents
           (organization_id, category, status, related_type, related_id,
            title, description, created_by_user_id, updated_at)
         VALUES ($1, $2, 'UPLOADED', 'LEASE', $3, $4, $5, $6, NOW())
         RETURNING *`,
        [user.orgId, tmpl.category, leaseId, docTitle,
         `Generated from template: ${tmpl.name}`, user.userId],
      );
      if (!doc) throw new AppError('DB_ERROR', 500, 'Failed to create document record');

      // Create version 1
      const docVersion = await queryOne(
        `INSERT INTO document_service.document_versions
           (document_id, version_number, storage_bucket, storage_key,
            file_name, original_file_name, mime_type, uploaded_by_user_id)
         VALUES ($1, 1, $2, $3, $4, $4, 'application/pdf', $5)
         RETURNING *`,
        [(doc as any).id, storageBucket, storageKey, fileName, user.userId],
      );

      // Update current_version_id
      await queryOne(
        `UPDATE document_service.documents
         SET current_version_id = $1, updated_at = NOW()
         WHERE id = $2`,
        [(docVersion as any).id, (doc as any).id],
      );

      // Record in generated_documents
      const genDoc = await queryOne(
        `INSERT INTO document_service.generated_documents
           (document_id, template_version_id, lease_id,
            generation_input_json, created_by_user_id)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         RETURNING *`,
        [(doc as any).id, latestVersion.id, leaseId,
         JSON.stringify(variables), user.userId],
      );

      // Write audit event
      await queryOne(
        `INSERT INTO document_service.document_audit_events
           (document_id, event_type, actor_user_id, actor_role, metadata_json)
         VALUES ($1, 'GENERATED_FROM_TEMPLATE', $2, 'OWNER', $3)`,
        [(doc as any).id, user.userId,
         JSON.stringify({ templateId: tmpl.id, templateVersionId: latestVersion.id, leaseId })],
      );

      logger.info(
        { documentId: (doc as any).id, templateId: tmpl.id, leaseId },
        'Document generated from template',
      );

      // Notify lease_packet_generated (non-fatal)
      emitNotification({
        organizationId: user.orgId,
        recipientUserIds: [user.userId],
        eventType: 'lease_packet_generated',
        title: 'Lease packet generated',
        body: `"${docTitle}" has been generated and is ready for review.`,
        relatedType: 'DOCUMENT',
        relatedId: (doc as any).id,
        metadata: { documentId: (doc as any).id, templateId: tmpl.id, leaseId },
      }).catch(() => {/* logged inside emitNotification */});

      res.status(201).json({
        data: { ...(doc as any), current_version: docVersion },
        generatedDocument: genDoc,
      });
    } catch (err) { next(err); }
  },
);

// ── PDF generation helper ─────────────────────────────────────────────────────

function generatePdf(
  templateName: string,
  variables: Record<string, unknown>,
  contentText: string | null,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({ autoFirstPage: true, margin: 60 });
    const stream = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
    });

    doc.on('error', reject);
    stream.on('error', reject);
    stream.on('finish', () => resolve(Buffer.concat(chunks)));

    doc.pipe(stream);

    // Header
    doc
      .fontSize(18)
      .font('Helvetica-Bold')
      .text(templateName, { align: 'center' });

    doc.moveDown();
    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor('grey')
      .text(`Generated: ${new Date().toISOString()}`, { align: 'center' });

    doc.moveDown(2);
    doc.fillColor('black');

    // Body content from in-DB template text (if provided)
    if (contentText) {
      // Simple variable substitution: replace {{key}} with value
      let body = contentText;
      for (const [key, val] of Object.entries(variables)) {
        body = body.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(val ?? ''));
      }
      doc.fontSize(11).font('Helvetica').text(body, { lineGap: 4 });
      doc.moveDown(2);
    }

    // Variable summary section
    if (Object.keys(variables).length > 0) {
      doc.fontSize(11).font('Helvetica-Bold').text('Document Details');
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica');

      for (const [key, val] of Object.entries(variables)) {
        const label = key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        doc.text(`${label}: ${String(val ?? '')}`, { lineGap: 2 });
      }
    }

    doc.moveDown(4);
    // Signature block placeholder
    doc.fontSize(10).font('Helvetica').text('______________________________     ______________________________');
    doc.text('Owner Signature / Date             Tenant Signature / Date');

    doc.end();
  });
}

export { router as templatesRouter };
