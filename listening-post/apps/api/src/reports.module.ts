import { Module } from '@nestjs/common';
import { CostsController } from './costs/costs.controller';
import { InsightsController } from './insights/insights.controller';
import { ItemsController } from './items/items.controller';
import { OverviewController } from './overview/overview.controller';

/** Read-only endpoints behind the dashboard: overview, items, costs and insights. */
@Module({ controllers: [OverviewController, ItemsController, CostsController, InsightsController] })
export class ReportsModule {}
