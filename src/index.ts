import { createApp, startApp, checkDbConnection } from '@leasebase/service-common';
import express from 'express';
import { documentsRouter } from './routes/documents';
import { templatesRouter } from './routes/templates';
import { signatureRequestsRouter } from './routes/signatureRequests';
import { webhooksRouter } from './routes/webhooks';

const app = createApp({
  healthChecks: [{ name: 'database', check: checkDbConnection }],
});

// Phase 3 — e-sign provider webhook (raw body capture BEFORE json parse)
// HelloSign sends application/x-www-form-urlencoded; we preserve rawBody for HMAC.
app.use('/webhooks', express.text({ type: '*/*', limit: '1mb' }), (req, _res, next) => {
  (req as any).rawBody = req.body;
  next();
});
app.use('/webhooks/esign', webhooksRouter);

// Phase 1 — core document endpoints
app.use('/internal/documents', documentsRouter);

// Phase 2 — templates and generation
app.use('/internal/documents/templates', templatesRouter);

// Phase 2 — signature requests (mixed prefixes handled by the router)
app.use('/internal/documents', signatureRequestsRouter);

startApp(app);
