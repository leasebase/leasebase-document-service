import { createApp, startApp, checkDbConnection } from '@leasebase/service-common';
import { documentsRouter } from './routes/documents';

const app = createApp({
  healthChecks: [{ name: 'database', check: checkDbConnection }],
});

app.use('/internal/documents', documentsRouter);

startApp(app);
