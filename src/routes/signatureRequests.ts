import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
  requireAuth, requireRole, queryOne, query, NotFoundError, AppError, logger,
  type AuthenticatedRequest, UserRole,
} from '@leasebase/service-common';

const router = Router();

// ── Config ────────────────────────────────────────────────────────────────────
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3007';
const LEASE_SERVICE_URL        = process.env.LEASE_SERVICE_URL        || 'http://localhost:3003';
const INTERNAL_SERVICE_KEY     = process.env.INTERNAL_SERVICE_KEY     || '';

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  try {
    const res = await fetch(`${NOTIFICATION_SERVICE_URL}/internal/notifications/internal-emit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': INTERNAL_SERVICE_KEY },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      logger.warn({ eventType: payload.eventType, status: res.status }, 'Notification emit failed (non-fatal)');
    }
  } catch (err) {
    logger.warn({ err, eventType: payload.eventType }, 'Notification emit threw (non-fatal)');
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
    logger.error({ status: res.status, body, leaseId }, 'Lease activation failed after signature completion');
    throw new AppError('LEASE_ACTIVATION_FAILED', 422,
      `Signatures complete but lease activation returned ${res.status}. Check lease status.`);
  }
  logger.info({ leaseId, orgId }, 'Lease activation triggered from signature completion');
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const signerSchema = z.object({
  user_id:       z.string().min(1),
  signer_type:   z.enum(['OWNER', 'TENANT', 'WITNESS']).default('TENANT'),
  email:         z.string().email().optional(),
  display_name:  z.string().optional(),
  routing_order: z.number().int().min(1).default(1),
});

const createSignatureRequestSchema = z.object({
  signers: z.array(signerSchema).min(1),
});

const patchSignatureRequestSchema = z.object({
  status: z.enum(['CANCELLED']),
});

const signerSignSchema = z.object({
  signerId: z.string().min(1),
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /documents/:documentId/signature-requests — Create signature request
// ═════════════════════════════════════════════════════════════════════════════

router.post('/documents/:documentId/signature-requests', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const parsed = createSignatureRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.errors } });
      }

      // Verify document belongs to org
      const doc = await queryOne<{
        id: string; related_type: string; related_id: string; category: string; status: string;
      }>(
        `SELECT id, related_type, related_id, category, status
         FROM document_service.documents
         WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL`,
        [req.params.documentId, user.orgId],
      );
      if (!doc) throw new NotFoundError('Document not found');

      // Create signature request
      const sigReq = await queryOne<{ id: string }>(
        `INSERT INTO document_service.signature_requests
           (document_id, organization_id, status, requested_by_user_id)
         VALUES ($1, $2, 'REQUESTED', $3)
         RETURNING *`,
        [req.params.documentId, user.orgId, user.userId],
      );
      if (!sigReq) throw new AppError('DB_ERROR', 500, 'Failed to create signature request');

      // Add signers
      const insertedSigners = [];
      for (const signer of parsed.data.signers) {
        const signerRow = await queryOne(
          `INSERT INTO document_service.signature_request_signers
             (signature_request_id, signer_type, user_id, email, display_name, routing_order, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
           RETURNING *`,
          [(sigReq as any).id, signer.signer_type, signer.user_id,
           signer.email || null, signer.display_name || null, signer.routing_order],
        );
        insertedSigners.push(signerRow);
      }

      // Write CREATED event
      await queryOne(
        `INSERT INTO document_service.signature_request_events
           (signature_request_id, event_type, payload_json)
         VALUES ($1, 'CREATED', $2::jsonb)`,
        [(sigReq as any).id, JSON.stringify({
          requestedBy: user.userId,
          signerCount: parsed.data.signers.length,
        })],
      );

      // Update document to PENDING_TENANT_SIGNATURE
      await queryOne(
        `UPDATE document_service.documents
         SET status = 'PENDING_TENANT_SIGNATURE', updated_at = NOW()
         WHERE id = $1 AND organization_id = $2`,
        [req.params.documentId, user.orgId],
      );

      logger.info(
        { sigReqId: (sigReq as any).id, documentId: req.params.documentId, signerCount: insertedSigners.length },
        'Signature request created',
      );

      // Notify all signers (non-fatal)
      const signerUserIds = parsed.data.signers.map((s) => s.user_id);
      emitNotification({
        organizationId: user.orgId,
        recipientUserIds: signerUserIds,
        eventType: 'signature_request_created',
        title: 'Signature required',
        body: 'A document has been shared with you for signature. Please review and sign.',
        relatedType: 'SIGNATURE_REQUEST',
        relatedId: (sigReq as any).id,
        metadata: { signatureRequestId: (sigReq as any).id, documentId: req.params.documentId },
      }).catch(() => {});

      res.status(201).json({
        data: { ...(sigReq as any), signers: insertedSigners },
      });
    } catch (err) { next(err); }
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// GET /documents/:documentId/signature-requests — List requests for a document
// ═════════════════════════════════════════════════════════════════════════════

router.get('/documents/:documentId/signature-requests', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;

      // Verify document belongs to org
      const doc = await queryOne(
        `SELECT id FROM document_service.documents WHERE id = $1 AND organization_id = $2`,
        [req.params.documentId, user.orgId],
      );
      if (!doc) throw new NotFoundError('Document not found');

      const requests = await query(
        `SELECT sr.*,
           (SELECT json_agg(s ORDER BY s.routing_order ASC)
            FROM document_service.signature_request_signers s
            WHERE s.signature_request_id = sr.id) AS signers
         FROM document_service.signature_requests sr
         WHERE sr.document_id = $1 AND sr.organization_id = $2
         ORDER BY sr.created_at DESC`,
        [req.params.documentId, user.orgId],
      );

      res.json({ data: requests });
    } catch (err) { next(err); }
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// GET /signature-requests/:id — Get single request with signers and events
// ═════════════════════════════════════════════════════════════════════════════

router.get('/signature-requests/:id', requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;

      const sigReq = await queryOne(
        `SELECT sr.* FROM document_service.signature_requests sr
         WHERE sr.id = $1 AND sr.organization_id = $2`,
        [req.params.id, user.orgId],
      );
      if (!sigReq) throw new NotFoundError('Signature request not found');

      const [signers, events] = await Promise.all([
        query(
          `SELECT * FROM document_service.signature_request_signers
           WHERE signature_request_id = $1 ORDER BY routing_order ASC`,
          [req.params.id],
        ),
        query(
          `SELECT * FROM document_service.signature_request_events
           WHERE signature_request_id = $1 ORDER BY created_at ASC`,
          [req.params.id],
        ),
      ]);

      res.json({ data: { ...(sigReq as any), signers, events } });
    } catch (err) { next(err); }
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// PATCH /signature-requests/:id/status — Cancel (owner only)
// ═════════════════════════════════════════════════════════════════════════════

router.patch('/signature-requests/:id/status', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const parsed = patchSignatureRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.errors } });
      }

      const sigReq = await queryOne<{ id: string; status: string; document_id: string }>(
        `SELECT id, status, document_id
         FROM document_service.signature_requests
         WHERE id = $1 AND organization_id = $2`,
        [req.params.id, user.orgId],
      );
      if (!sigReq) throw new NotFoundError('Signature request not found');

      if (sigReq.status === 'CANCELLED') {
        return res.json({ data: sigReq, alreadyCancelled: true });
      }

      if (sigReq.status === 'COMPLETED') {
        throw new AppError('INVALID_TRANSITION', 400, 'Cannot cancel a completed signature request.');
      }

      const updated = await queryOne(
        `UPDATE document_service.signature_requests
         SET status = 'CANCELLED', updated_at = NOW()
         WHERE id = $1 AND organization_id = $2
         RETURNING *`,
        [req.params.id, user.orgId],
      );

      // Write CANCELLED event
      await queryOne(
        `INSERT INTO document_service.signature_request_events
           (signature_request_id, event_type, payload_json)
         VALUES ($1, 'CANCELLED', $2::jsonb)`,
        [req.params.id, JSON.stringify({ cancelledBy: user.userId })],
      );

      logger.info({ sigReqId: req.params.id }, 'Signature request cancelled');
      res.json({ data: updated });
    } catch (err) { next(err); }
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// POST /signature-requests/:id/sign — Tenant or owner marks own signer as SIGNED
// ═════════════════════════════════════════════════════════════════════════════

router.post('/signature-requests/:id/sign', requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const parsed = signerSignSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.errors } });
      }

      const sigReq = await queryOne<{
        id: string; status: string; document_id: string; organization_id: string;
      }>(
        `SELECT id, status, document_id, organization_id
         FROM document_service.signature_requests
         WHERE id = $1 AND organization_id = $2`,
        [req.params.id, user.orgId],
      );
      if (!sigReq) throw new NotFoundError('Signature request not found');

      if (!['REQUESTED', 'PARTIALLY_SIGNED'].includes(sigReq.status)) {
        throw new AppError('INVALID_STATE', 400,
          `Cannot sign a request in status '${sigReq.status}'.`);
      }

      // Verify the signer row belongs to this user
      const signer = await queryOne<{ id: string; status: string; user_id: string }>(
        `SELECT id, status, user_id
         FROM document_service.signature_request_signers
         WHERE id = $1 AND signature_request_id = $2`,
        [parsed.data.signerId, req.params.id],
      );
      if (!signer) throw new NotFoundError('Signer not found on this request');

      // Allow signing only if the signer's user_id matches the caller
      if (signer.user_id !== user.userId) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You are not the designated signer for this slot.' } });
      }

      if (signer.status === 'SIGNED') {
        return res.json({ data: signer, alreadySigned: true });
      }

      // Mark signer as SIGNED
      const updatedSigner = await queryOne(
        `UPDATE document_service.signature_request_signers
         SET status = 'SIGNED', signed_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [parsed.data.signerId],
      );

      // Write SIGNED event
      await queryOne(
        `INSERT INTO document_service.signature_request_events
           (signature_request_id, event_type, payload_json)
         VALUES ($1, 'SIGNED', $2::jsonb)`,
        [req.params.id, JSON.stringify({ signerId: parsed.data.signerId, userId: user.userId })],
      );

      // Check if all signers are now SIGNED
      const pendingSigners = await queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM document_service.signature_request_signers
         WHERE signature_request_id = $1 AND status NOT IN ('SIGNED', 'DECLINED')
         AND status != 'FAILED'`,
        [req.params.id],
      );
      const remainingCount = Number(pendingSigners?.count || 0);

      let newStatus = remainingCount === 0 ? 'COMPLETED' : 'PARTIALLY_SIGNED';

      const updatedReq = await queryOne<{ id: string; status: string }>(
        `UPDATE document_service.signature_requests
         SET status = $1, updated_at = NOW(),
             completed_at = CASE WHEN $1 = 'COMPLETED' THEN NOW() ELSE NULL END
         WHERE id = $2
         RETURNING *`,
        [newStatus, req.params.id],
      );

      logger.info(
        { sigReqId: req.params.id, signerId: parsed.data.signerId, newStatus },
        'Signature recorded',
      );

      // On completion: mark document FULLY_EXECUTED and trigger lease activation
      if (newStatus === 'COMPLETED') {
        const docRow = await queryOne<{
          id: string; related_type: string; related_id: string; category: string;
        }>(
          `UPDATE document_service.documents
           SET status = 'FULLY_EXECUTED', updated_at = NOW()
           WHERE id = $1
           RETURNING id, related_type, related_id, category`,
          [sigReq.document_id],
        );

        await queryOne(
          `INSERT INTO document_service.document_audit_events
             (document_id, event_type, actor_user_id, actor_role, metadata_json)
           VALUES ($1, 'FULLY_EXECUTED', $2, $3, $4)`,
          [sigReq.document_id, user.userId, user.role,
           JSON.stringify({ signatureRequestId: req.params.id })],
        );

        // Trigger lease activation if LEASE_AGREEMENT doc
        if (docRow?.category === 'LEASE_AGREEMENT' && docRow?.related_type === 'LEASE') {
          await triggerLeaseActivation(docRow.related_id, sigReq.organization_id);
        }

        logger.info(
          { sigReqId: req.params.id, documentId: sigReq.document_id },
          'All signers completed — document FULLY_EXECUTED',
        );
      }

      res.json({ data: { signatureRequest: updatedReq, signer: updatedSigner } });
    } catch (err) { next(err); }
  },
);

export { router as signatureRequestsRouter };
