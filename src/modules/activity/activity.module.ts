import { Global, Module } from '@nestjs/common';

import { ActivityController } from './activity.controller';
import { ActivityLogService } from './activity.service';
import { ActivityLogRepository } from './repositories/activity.repository';

/**
 * Global for the same reason PrismaModule is: almost every module writes audit
 * entries, and AuditInterceptor is bound through APP_INTERCEPTOR in AppModule.
 * The alternative — importing ActivityModule into eight feature modules — adds
 * eight chances to forget.
 */
@Global()
@Module({
  controllers: [ActivityController],

  providers: [ActivityLogService, ActivityLogRepository],

  exports: [ActivityLogService],
})
export class ActivityModule {}
