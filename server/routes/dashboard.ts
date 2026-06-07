import type { FastifyInstance } from 'fastify';
import { registerCloseRoutes } from './dashboard/closeRoutes.js';
import { registerInsightRoutes } from './dashboard/insightRoutes.js';
import { registerReferenceRoutes } from './dashboard/referenceRoutes.js';
import { registerSummaryRoutes } from './dashboard/summaryRoutes.js';
import { registerTransactionRoutes } from './dashboard/transactionRoutes.js';
export { flowBucketWindows, type FlowBucketGranularity, type FlowBucketPreset } from './dashboard/helpers.js';

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  registerReferenceRoutes(app);
  registerTransactionRoutes(app);
  registerInsightRoutes(app);
  registerSummaryRoutes(app);
  registerCloseRoutes(app);
}
