/**
 * Provider factory — Phase 3
 *
 * Selects the active e-sign provider based on ESIGN_PROVIDER env var.
 * Returns a singleton instance per process lifetime.
 *
 * ESIGN_PROVIDER values:
 *   HELLOSIGN  — Dropbox Sign (default for Phase 3)
 *   MANUAL     — No provider; signature flow is manual/external (Phase 1/2 mode)
 */

import { logger } from '@leasebase/service-common';
import type { ESignProvider, ESignProviderName } from './types.js';

let _instance: ESignProvider | null = null;

export function getESignProvider(): ESignProvider {
  if (_instance) return _instance;

  const name = (process.env.ESIGN_PROVIDER ?? 'MANUAL').toUpperCase() as ESignProviderName;

  switch (name) {
    case 'HELLOSIGN': {
      const { HelloSignProvider } = require('./hellosignProvider.js');
      _instance = new HelloSignProvider();
      logger.info({ provider: 'HELLOSIGN' }, 'E-sign provider initialized');
      break;
    }
    case 'MANUAL':
    default:
      _instance = new ManualProvider();
      logger.info({ provider: 'MANUAL' }, 'E-sign provider: MANUAL mode (no provider calls)');
  }

  return _instance!;
}

/**
 * Stub provider for MANUAL / Phase 1-2 mode.
 * All calls are no-ops or throw; signature flow uses external verification.
 */
class ManualProvider implements ESignProvider {
  readonly name = 'MANUAL' as const;

  async createRequest(): Promise<never> {
    throw new Error(
      'MANUAL provider does not support createRequest. Set ESIGN_PROVIDER=HELLOSIGN to enable real e-sign.',
    );
  }
  async getSigningUrl(): Promise<never> {
    throw new Error('MANUAL provider does not support getSigningUrl.');
  }
  async cancelRequest(): Promise<never> {
    throw new Error('MANUAL provider does not support cancelRequest.');
  }
  verifyWebhook(): boolean { return false; }
  mapWebhookEvent(): never {
    throw new Error('MANUAL provider does not process webhooks.');
  }
}
