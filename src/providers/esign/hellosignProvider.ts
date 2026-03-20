/**
 * Dropbox Sign (HelloSign) provider implementation — Phase 3
 *
 * Uses the Dropbox Sign REST API directly via fetch (no SDK dependency).
 * API reference: https://developers.hellosign.com/api/reference/
 *
 * Required env vars:
 *   HELLOSIGN_API_KEY       — API key (Basic auth username; password is empty)
 *   HELLOSIGN_CLIENT_ID     — Client ID for embedded signing URLs
 *   HELLOSIGN_WEBHOOK_SECRET — HMAC secret for webhook verification
 */

import crypto from 'node:crypto';
import { logger } from '@leasebase/service-common';
import type {
  ESignProvider,
  CreateRequestParams,
  CreateRequestResult,
  ProviderWebhookEvent,
  ProviderEventType,
} from './types.js';

const HELLOSIGN_API_BASE = 'https://api.hellosign.com/v3';

// ── HelloSign-specific event types → canonical mapping ──────────────────────

const EVENT_TYPE_MAP: Record<string, ProviderEventType | null> = {
  signature_request_sent:       'REQUEST_SENT',
  signature_request_viewed:     'SIGNER_VIEWED',
  signature_request_signed:     'SIGNER_SIGNED',
  signature_request_declined:   'SIGNER_DECLINED',
  signature_request_all_signed: 'REQUEST_COMPLETED',
  signature_request_canceled:   'REQUEST_CANCELLED',
  callback_test:                null,   // HelloSign test ping — ignore
};

// ── Provider class ────────────────────────────────────────────────────────────

export class HelloSignProvider implements ESignProvider {
  readonly name = 'HELLOSIGN' as const;

  private readonly apiKey: string;
  private readonly clientId: string;
  private readonly webhookSecret: string;

  constructor() {
    this.apiKey        = process.env.HELLOSIGN_API_KEY        || '';
    this.clientId      = process.env.HELLOSIGN_CLIENT_ID      || '';
    this.webhookSecret = process.env.HELLOSIGN_WEBHOOK_SECRET || '';

    if (!this.apiKey) {
      logger.warn('HELLOSIGN_API_KEY is not set — provider calls will fail');
    }
  }

  // ── HTTP helper ─────────────────────────────────────────────────────────────

  private authHeader(): string {
    // HelloSign uses HTTP Basic auth: apiKey as username, empty password
    return 'Basic ' + Buffer.from(`${this.apiKey}:`).toString('base64');
  }

  private async callApi(
    path: string,
    method: string,
    body?: FormData | string,
    contentType?: string,
  ): Promise<any> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      Accept: 'application/json',
    };
    if (contentType) headers['Content-Type'] = contentType;

    const res = await fetch(`${HELLOSIGN_API_BASE}${path}`, {
      method,
      headers,
      body: body as any,
    });

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const errBody = text ? JSON.parse(text).error ?? {} : {};
      throw new Error(
        `HelloSign API ${method} ${path} → ${res.status}: ${errBody.error_name ?? text}`,
      );
    }
    return text ? JSON.parse(text) : null;
  }

  // ── ESignProvider: createRequest ────────────────────────────────────────────

  async createRequest(params: CreateRequestParams): Promise<CreateRequestResult> {
    const form = new FormData();

    form.append('test_mode', '1');  // Remove in production by checking NODE_ENV
    form.append('title',   params.documentTitle);
    form.append('subject', params.subject);
    form.append('message', params.message);
    form.append('client_id', this.clientId);

    // Attach signers
    params.signers.forEach((signer, i) => {
      form.append(`signers[${i}][email_address]`, signer.email);
      form.append(`signers[${i}][name]`,          signer.name);
      form.append(`signers[${i}][order]`,         String(signer.routingOrder));
    });

    // Attach the document
    if (params.documentBytes) {
      const blob = new Blob([params.documentBytes as unknown as ArrayBuffer], { type: 'application/pdf' });
      form.append('file[0]', blob, `${params.documentTitle.replace(/\s+/g, '_')}.pdf`);
    } else if (params.documentUrl) {
      form.append('file_url[0]', params.documentUrl);
    } else {
      throw new Error('createRequest: either documentBytes or documentUrl is required');
    }

    // Store internal ID as metadata for webhook correlation
    form.append('metadata[internal_request_id]', params.internalRequestId);

    // Request per-signer embedded signing URLs
    form.append('is_for_embedded_signing', '1');

    logger.info(
      { internalRequestId: params.internalRequestId, signerCount: params.signers.length },
      'HelloSign: creating signature request',
    );

    const data = await this.callApi('/signature_request/send', 'POST', form);
    const sr = data.signature_request;

    // Map back to canonical result — fetch signing URL for each signer
    const signerResults = await Promise.all(
      (sr.signatures as any[]).map(async (sig: any) => {
        // Find internal user by email match
        const internalSigner = params.signers.find(
          (s) => s.email.toLowerCase() === sig.signer_email_address?.toLowerCase(),
        );

        let signUrl = '';
        try {
          const urlData = await this.callApi(
            `/embedded/sign_url/${sig.signature_id}`,
            'GET',
          );
          signUrl = urlData.embedded?.sign_url ?? '';
        } catch (err) {
          logger.warn({ err, signatureId: sig.signature_id }, 'HelloSign: failed to fetch sign_url');
        }

        return {
          userId:            internalSigner?.userId ?? '',
          email:             sig.signer_email_address ?? '',
          providerSignerId:  sig.signature_id ?? '',
          signUrl,
        };
      }),
    );

    logger.info(
      { providerRequestId: sr.signature_request_id, internalRequestId: params.internalRequestId },
      'HelloSign: signature request created',
    );

    return {
      providerRequestId: sr.signature_request_id,
      signers:           signerResults,
    };
  }

  // ── ESignProvider: getSigningUrl ────────────────────────────────────────────

  async getSigningUrl(providerRequestId: string, providerSignerId: string): Promise<string> {
    const data = await this.callApi(`/embedded/sign_url/${providerSignerId}`, 'GET');
    const url = data.embedded?.sign_url;
    if (!url) {
      throw new Error(`HelloSign: no sign_url for signer ${providerSignerId}`);
    }
    return url;
  }

  // ── ESignProvider: cancelRequest ────────────────────────────────────────────

  async cancelRequest(providerRequestId: string): Promise<void> {
    await this.callApi(`/signature_request/cancel/${providerRequestId}`, 'POST');
    logger.info({ providerRequestId }, 'HelloSign: signature request cancelled');
  }

  // ── ESignProvider: verifyWebhook ────────────────────────────────────────────

  /**
   * HelloSign signs webhooks with HMAC-SHA256 over the JSON event payload.
   * Header: X-HelloSign-Signature
   * https://developers.hellosign.com/api/reference/event-callback/
   */
  verifyWebhook(rawBody: string, headers: Record<string, string>): boolean {
    if (!this.webhookSecret) {
      logger.warn('HELLOSIGN_WEBHOOK_SECRET not set — skipping webhook verification');
      return true;  // allow in dev when secret not configured
    }

    // HelloSign sends the JSON in a form field named "json"
    // The verification is over the raw "json" field value
    let jsonValue: string;
    try {
      const params = new URLSearchParams(rawBody);
      jsonValue = params.get('json') ?? rawBody;
    } catch {
      jsonValue = rawBody;
    }

    const providedHash = headers['x-hellosign-signature'] ??
                         headers['X-HelloSign-Signature'] ?? '';
    if (!providedHash) {
      logger.warn('HelloSign webhook missing X-HelloSign-Signature header');
      return false;
    }

    const expected = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(jsonValue)
      .digest('hex');

    // timingSafeEqual requires buffers of equal length
    const expectedBuf = Buffer.from(expected, 'hex');
    const providedBuf = Buffer.from(providedHash.length === 64 ? providedHash : '0'.repeat(64), 'hex');
    const valid = expectedBuf.length === providedBuf.length &&
      crypto.timingSafeEqual(expectedBuf, providedBuf) &&
      providedHash.length === 64;

    if (!valid) {
      logger.warn({ expected: expected.slice(0, 8) + '…' }, 'HelloSign webhook HMAC mismatch');
    }
    return valid;
  }

  // ── ESignProvider: mapWebhookEvent ──────────────────────────────────────────

  mapWebhookEvent(rawBody: string, _headers: Record<string, string>): ProviderWebhookEvent {
    // HelloSign sends events as URL-encoded form with a "json" field
    let payload: any;
    try {
      const params = new URLSearchParams(rawBody);
      const jsonStr = params.get('json') ?? rawBody;
      payload = JSON.parse(jsonStr);
    } catch {
      payload = JSON.parse(rawBody);
    }

    const event      = payload.event ?? {};
    const sr         = payload.signature_request ?? {};
    const eventType  = event.event_type as string;

    const canonical = EVENT_TYPE_MAP[eventType];

    // Identify the affected signer for signer-level events
    let providerSignerId: string | undefined;
    let signerEmail: string | undefined;

    if (event.event_metadata?.related_signature_id) {
      providerSignerId = event.event_metadata.related_signature_id;
      // Find the signer from the signatures array
      const signer = (sr.signatures ?? []).find(
        (s: any) => s.signature_id === providerSignerId,
      );
      signerEmail = signer?.signer_email_address;
    }

    return {
      type:              (canonical ?? 'REQUEST_SENT') as any,
      providerEventId:   event.event_hash ?? `${eventType}_${sr.signature_request_id}_${Date.now()}`,
      providerRequestId: sr.signature_request_id ?? '',
      providerSignerId,
      signerEmail,
      occurredAt:        event.event_time
        ? new Date(Number(event.event_time) * 1000).toISOString()
        : new Date().toISOString(),
      rawPayload:        rawBody,
    };
  }
}
