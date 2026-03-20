import { createApp, startApp, checkDbConnection } from '@leasebase/service-common';
import { documentsRouter } from './routes/documents';
import { templatesRouter } from './routes/templates';
import { signatureRequestsRouter } from './routes/signatureRequests';

const app = createApp({
  healthChecks: [{ name: 'database', check: checkDbConnection }],
});

// Phase 1 — core document endpoints
app.use('/internal/documents', documentsRouter);

// Phase 2 — templates and generation
app.use('/internal/documents/templates', templatesRouter);

// Phase 2 — signature requests (mixed prefixes handled by the router)
app.use('/internal/documents', signatureRequestsRouter);

startApp(app);
