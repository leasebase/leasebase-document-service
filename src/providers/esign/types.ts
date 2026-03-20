/**
 * E-sign provider adapter types — Phase 3
 *
 * These are canonical internal types, independent of any specific provider's
 * API shape. All providers must map their responses to these types.
 */

/** Canonical provider identifiers. Extend when adding new providers. */
export type ESignProviderName = 'HELLOSIGN' | 'MANUAL';

// ── Request creation ─────────────────────────────────────────────────────────

export interface ESignSigner {
  /** Internal LeaseBase user identifier (for correlation) */
  userId: string;
  name: string;
  email: string;
  /** 1-based routing order for sequential signing */
  routingOrder: number;
  role?: string;
}

export interface CreateRequestParams {
  /** Friendly subject line displayed in provider email */
  subject: string;
  message: string;
  /** Human-readable title for the document */
  documentTitle: string;
  /** PDF bytes to be signed. Mutually exclusive with documentUrl. */
  documentBytes?: Buffer;
  /** Pre-signed S3 URL the provider can fetch. Mutually exclusive with documentBytes. */
  documentUrl?: string;
  signers: ESignSigner[];
  /** Internal signature_request.id — sent as provider metadata for correlation */
  internalRequestId: string;
}

export interface ProviderSignerResult {
  userId: string;
  email: string;
  /** Provider's per-signer identifier (e.g. HelloSign signature_id) */
  providerSignerId: string;
  /** Provider-issued signing URL for this signer (redirect flow) */
  signUrl: string;
}

export interface CreateRequestResult {
  /** Provider's request identifier (stored in signature_requests.provider_request_id) */
  providerRequestId: string;
  signers: ProviderSignerResult[];
}

// ── Webhook event ─────────────────────────────────────────────────────────────

export type ProviderEventType =
  | 'REQUEST_SENT'
  | 'SIGNER_VIEWED'
  | 'SIGNER_SIGNED'
  | 'SIGNER_DECLINED'
  | 'REQUEST_COMPLETED'
  | 'REQUEST_CANCELLED'
  | 'REQUEST_ERROR';

export interface ProviderWebhookEvent {
  /** Canonical event type */
  type: ProviderEventType;
  /** Provider-assigned unique ID for this event (used for idempotency) */
  providerEventId: string;
  /** Provider request ID — maps to signature_requests.provider_request_id */
  providerRequestId: string;
  /**
   * Provider signer ID — present for signer-level events.
   * Maps to signature_request_signers.provider_signer_id.
   */
  providerSignerId?: string;
  /** Signer email for cross-referencing */
  signerEmail?: string;
  /** ISO timestamp from provider */
  occurredAt: string;
  /** Raw provider payload for audit storage */
  rawPayload: string;
}

// ── Provider interface ────────────────────────────────────────────────────────

export interface ESignProvider {
  readonly name: ESignProviderName;

  /**
   * Create a signature request with the provider.
   * Returns provider IDs and per-signer signing URLs.
   */
  createRequest(params: CreateRequestParams): Promise<CreateRequestResult>;

  /**
   * Get a fresh signing URL for a specific signer.
   * Provider URLs may expire; call this when tenant requests to sign.
   */
  getSigningUrl(providerRequestId: string, providerSignerId: string): Promise<string>;

  /**
   * Cancel an active signature request at the provider.
   */
  cancelRequest(providerRequestId: string): Promise<void>;

  /**
   * Verify that an inbound webhook payload is authentic.
   * Returns true if the signature is valid, false otherwise.
   * Should throw only for non-recoverable infrastructure errors.
   */
  verifyWebhook(rawBody: string, headers: Record<string, string>): boolean;

  /**
   * Parse a raw webhook payload into a canonical ProviderWebhookEvent.
   * Only call after verifyWebhook returns true.
   */
  mapWebhookEvent(rawBody: string, headers: Record<string, string>): ProviderWebhookEvent;
}
