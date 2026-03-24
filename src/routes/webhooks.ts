/**
 * E-sign provider webhook handler — Phase 3
 *
 * Route: POST /webhooks/esign/:provider
 *
 * This endpoint is NOT behind requireAuth (no JWT).
 * Authentication is via HMAC verification per provider.
 *
 * Processing sequence for each event:
 *   1. Verify HMAC signature
 *   2. Look up signature_request by provider_request_id
 *   3. Insert signature_request_events (idempotent via provider_event_id)
 *   4. Update signer status
 *   5. If all signers signed → complete request + FULLY_EXECUTE document
 *   6. Trigger lease activation if LEASE_AGREEMENT
 *   7. Emit notifications
 */

import { Router, type Request, type Response } from 'express';
import {
  queryOne, query, AppError, logger,
  emitNotification,
} from '@leasebase/service-common';
import { getESignProvider } from '../providers/esign/index.js';
import type { ProviderEventType } from '../providers/esign/index.js';

export const webhooksRouter = Router();

// ── Config ────────────────────────────────────────────────────────────────────
const LEASE_SERVICE_URL        = process.env.LEASE_SERVICE_URL        || 'http://localhost:3003';
const INTERNAL_SERVICE_KEY     = process.env.INTERNAL_SERVICE_KEY     || '';

// ── Downstream helpers ────────────────────────────────────────────────────────

async function triggerLeaseActivation(leaseId: string, orgId: string): Promise<void> {
  const res = await fetch(
    `${LEASE_SERVICE_URL}/internal/leases/${encodeURIComponent(leaseId)}/activate-from-document`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': INTERNAL_SERVICE_KEY },
      body: JSON.stringify({ organizationId: orgId }),
    },
  );
  if (!res.ok && res.status !== 207) {
    const body = await res.text().catch(() => '');
    logger.error({ status: res.status, body, leaseId }, 'Webhook: lease activation call failed');
    throw new AppError('LEASE_ACTIVATION_FAILED', 422,
      `Webhook: lease activation returned ${res.status}. Check lease status.`);
  }
  logger.info({ leaseId, orgId, status: res.status }, 'Webhook: lease activation triggered');
}

// emitNotification is now imported from @leasebase/service-common

// ── Signer status from provider event type ────────────────────────────────────

function signerStatusFromEvent(type: ProviderEventType): string | null {
  switch (type) {
    case 'SIGNER_VIEWED':   return 'VIEWED';
    case 'SIGNER_SIGNED':   return 'SIGNED';
    case 'SIGNER_DECLINED': return 'DECLINED';
    case 'REQUEST_ERROR':   return 'FAILED';
    default:                return null;
  }
}

// ── POST /webhooks/esign/:provider ────────────────────────────────────────────

webhooksRouter.post('/:provider',
  async (req: Request, res: Response) => {
    const { provider } = req.params;
    const rawBody = (req as any).rawBody as string ?? JSON.stringify(req.body);

    logger.info({ provider }, 'Webhook received');

    // 1. Get provider adapter
    let providerAdapter: ReturnType<typeof getESignProvider>;
    try {
      providerAdapter = getESignProvider();
      if (providerAdapter.name !== provider.toUpperCase()) {
        // Accept if it's MANUAL (misconfigured) but still process
        if (providerAdapter.name === 'MANUAL') {
          logger.warn({ provider, configured: providerAdapter.name }, 'Webhook: provider mismatch — MANUAL mode');
          return res.status(200).send('Hello API Event Received');
        }
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'Webhook: provider not available');
      return res.status(500).json({ error: 'Provider not configured' });
    }

    // 2. Verify webhook authenticity
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : (v ?? '')]),
    ) as Record<string, string>;

    if (!providerAdapter.verifyWebhook(rawBody, headers)) {
      logger.warn({ provider }, 'Webhook HMAC verification failed');
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    // 3. Parse event
    let event: ReturnType<typeof providerAdapter.mapWebhookEvent>;
    try {
      event = providerAdapter.mapWebhookEvent(rawBody, headers);
    } catch (err: any) {
      logger.error({ err: err.message }, 'Webhook: failed to parse event');
      return res.status(400).json({ error: 'Failed to parse webhook event' });
    }

    // HelloSign test ping — ack immediately
    if (!event.providerRequestId) {
      logger.info({ event: event.type }, 'Webhook: ignoring test/ping event');
      return res.status(200).send('Hello API Event Received');
    }

    logger.info(
      { type: event.type, providerRequestId: event.providerRequestId, eventId: event.providerEventId },
      'Webhook: processing event',
    );

    // 4. Look up internal signature request
    const sigReq = await queryOne<{
      id: string; document_id: string; organization_id: string; status: string;
    }>(
      `SELECT id, document_id, organization_id, status
       FROM document_service.signature_requests
       WHERE provider = $1 AND provider_request_id = $2`,
      [provider.toUpperCase(), event.providerRequestId],
    );

    if (!sigReq) {
      logger.warn({ providerRequestId: event.providerRequestId }, 'Webhook: unknown signature request');
      // Still ack — don't cause provider to retry indefinitely
      return res.status(200).send('Hello API Event Received');
    }

    // 5. Idempotent event recording
    const existingEvent = event.providerEventId ? await queryOne(
      `SELECT id FROM document_service.signature_request_events
       WHERE provider_event_id = $1`,
      [event.providerEventId],
    ) : null;

    if (!existingEvent) {
      await queryOne(
        `INSERT INTO document_service.signature_request_events
           (signature_request_id, event_type, payload_json, provider_event_id)
         VALUES ($1, $2, $3::jsonb, $4)`,
        [sigReq.id, event.type, JSON.stringify({ raw: event.rawPayload.slice(0, 4096) }), event.providerEventId || null],
      );
    } else {
      // Duplicate event — already processed, ack and return
      logger.info({ providerEventId: event.providerEventId }, 'Webhook: duplicate event ignored (idempotent)');
      return res.status(200).send('Hello API Event Received');
    }

    // 6. Update signer status if this is a signer-level event
    const newSignerStatus = signerStatusFromEvent(event.type);
    if (newSignerStatus && event.providerSignerId) {
      await queryOne(
        `UPDATE document_service.signature_request_signers
         SET status = $1,
             signed_at = CASE WHEN $1 = 'SIGNED' THEN NOW() ELSE signed_at END
         WHERE signature_request_id = $2
           AND provider_signer_id = $3
           AND status != $1`,
        [newSignerStatus, sigReq.id, event.providerSignerId],
      );
      logger.info(
        { sigReqId: sigReq.id, providerSignerId: event.providerSignerId, newStatus: newSignerStatus },
        'Webhook: signer status updated',
      );
    }

    // 7. Handle request-level completions
    if (event.type === 'REQUEST_CANCELLED') {
      await queryOne(
        `UPDATE document_service.signature_requests
         SET status = 'CANCELLED', updated_at = NOW()
         WHERE id = $1 AND status NOT IN ('COMPLETED', 'CANCELLED')`,
        [sigReq.id],
      );
      logger.info({ sigReqId: sigReq.id }, 'Webhook: request cancelled');
      return res.status(200).send('Hello API Event Received');
    }

    if (event.type === 'REQUEST_ERROR') {
      await queryOne(
        `UPDATE document_service.signature_requests
         SET status = 'FAILED', updated_at = NOW()
         WHERE id = $1 AND status NOT IN ('COMPLETED', 'CANCELLED', 'FAILED')`,
        [sigReq.id],
      );
      return res.status(200).send('Hello API Event Received');
    }

    if (event.type === 'REQUEST_COMPLETED' || event.type === 'SIGNER_SIGNED') {
      // Check if all signers are now SIGNED
      const pendingCount = await queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM document_service.signature_request_signers
         WHERE signature_request_id = $1
           AND status NOT IN ('SIGNED', 'DECLINED', 'FAILED')`,
        [sigReq.id],
      );
      const allDone = Number(pendingCount?.count || 0) === 0 || event.type === 'REQUEST_COMPLETED';

      if (allDone && sigReq.status !== 'COMPLETED') {
        // Mark request COMPLETED
        await queryOne(
          `UPDATE document_service.signature_requests
           SET status = 'COMPLETED', updated_at = NOW(), completed_at = NOW()
           WHERE id = $1`,
          [sigReq.id],
        );

        // Fetch document info for downstream
        const doc = await queryOne<{
          id: string; category: string; related_type: string; related_id: string;
          organization_id: string;
        }>(
          `SELECT id, category, related_type, related_id, organization_id
           FROM document_service.documents WHERE id = $1`,
          [sigReq.document_id],
        );

        if (doc) {
          // Mark document FULLY_EXECUTED
          await queryOne(
            `UPDATE document_service.documents
             SET status = 'FULLY_EXECUTED', updated_at = NOW()
             WHERE id = $1`,
            [doc.id],
          );

          // Write document audit event
          await queryOne(
            `INSERT INTO document_service.document_audit_events
               (document_id, event_type, actor_user_id, actor_role, metadata_json)
             VALUES ($1, 'FULLY_EXECUTED', 'provider', 'ESIGN_PROVIDER', $2)`,
            [doc.id, JSON.stringify({
              signatureRequestId: sigReq.id,
              provider: provider.toUpperCase(),
              providerRequestId: event.providerRequestId,
            })],
          );

          logger.info({ documentId: doc.id, sigReqId: sigReq.id }, 'Webhook: document FULLY_EXECUTED');

          // Trigger lease activation if this is a LEASE_AGREEMENT
          if (doc.category === 'LEASE_AGREEMENT' && doc.related_type === 'LEASE') {
            try {
              await triggerLeaseActivation(doc.related_id, doc.organization_id);
            } catch (err: any) {
              logger.error({ err: err.message, leaseId: doc.related_id }, 'Webhook: lease activation failed (non-blocking)');
            }
          }

          // Emit document_fully_executed notification
          // Fetch owner (requester) for notification
          const sigReqFull = await queryOne<{ requested_by_user_id: string }>(
            `SELECT requested_by_user_id FROM document_service.signature_requests WHERE id = $1`,
            [sigReq.id],
          );
          const tenantSigners = await query<{ user_id: string }>(
            `SELECT user_id FROM document_service.signature_request_signers
             WHERE signature_request_id = $1`,
            [sigReq.id],
          );
          const allRecipients = [
            ...(sigReqFull ? [sigReqFull.requested_by_user_id] : []),
            ...tenantSigners.map((s) => s.user_id),
          ].filter((id, i, arr) => id && arr.indexOf(id) === i);

          emitNotification({
            organizationId:   doc.organization_id,
            recipientUserIds: allRecipients,
            eventType:        'document_fully_executed',
            title:            'Document fully executed',
            body:             'All parties have signed. The document is now fully executed.',
            relatedType:      'SIGNATURE_REQUEST',
            relatedId:        sigReq.id,
            metadata:         { documentId: doc.id, signatureRequestId: sigReq.id },
          }).catch(() => {});
        }
      } else if (!allDone && sigReq.status === 'REQUESTED') {
        // Update to PARTIALLY_SIGNED
        await queryOne(
          `UPDATE document_service.signature_requests
           SET status = 'PARTIALLY_SIGNED', updated_at = NOW()
           WHERE id = $1 AND status = 'REQUESTED'`,
          [sigReq.id],
        );
      }
    }

    // Emit signer_signed notification
    if (event.type === 'SIGNER_SIGNED' && event.providerSignerId) {
      const signer = await queryOne<{ user_id: string }>(
        `SELECT user_id FROM document_service.signature_request_signers
         WHERE signature_request_id = $1 AND provider_signer_id = $2`,
        [sigReq.id, event.providerSignerId],
      );
      if (signer?.user_id) {
        emitNotification({
          organizationId:   sigReq.organization_id,
          recipientUserIds: [signer.user_id],
          eventType:        'signer_signed',
          title:            'Signature recorded',
          body:             'Your signature has been successfully recorded.',
          relatedType:      'SIGNATURE_REQUEST',
          relatedId:        sigReq.id,
          metadata:         { signatureRequestId: sigReq.id },
        }).catch(() => {});
      }
    }

    if (event.type === 'SIGNER_VIEWED' && event.providerSignerId) {
      const signer = await queryOne<{ user_id: string }>(
        `SELECT user_id FROM document_service.signature_request_signers
         WHERE signature_request_id = $1 AND provider_signer_id = $2`,
        [sigReq.id, event.providerSignerId],
      );
      if (signer?.user_id) {
        emitNotification({
          organizationId:   sigReq.organization_id,
          recipientUserIds: [signer.user_id],
          eventType:        'signer_viewed',
          title:            'Document opened for signing',
          body:             'The document has been opened for your signature.',
          relatedType:      'SIGNATURE_REQUEST',
          relatedId:        sigReq.id,
          metadata:         { signatureRequestId: sigReq.id },
        }).catch(() => {});
      }
    }

    // HelloSign expects exact response: "Hello API Event Received"
    return res.status(200).send('Hello API Event Received');
  },
);
