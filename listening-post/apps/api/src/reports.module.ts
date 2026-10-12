import { Module } from '@nestjs/common';
import { AlertsController } from './alerts/alerts.controller';
import { AnalysisController } from './analysis/analysis.controller';
import { CostsController } from './costs/costs.controller';
import { InsightsController } from './insights/insights.controller';
import { ItemsController } from './items/items.controller';
import { OverviewController } from './overview/overview.controller';

/** Endpoints behind the dashboard's reports: overview, items, costs, insights, alerts and analysis. */
@Module({ controllers: [OverviewController, ItemsController, CostsController, InsightsController, AlertsController, AnalysisController] })
export class ReportsModule {}
