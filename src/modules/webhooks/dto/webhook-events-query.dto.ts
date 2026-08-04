import { ApiPropertyOptional } from '@nestjs/swagger';
import { WebhookEventStatus } from '@prisma/client';
import { IsEnum, IsIn, IsOptional } from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

/**
 * Allowlist for `sortBy`. Anything outside it is refused rather than silently
 * ignored, so a client sorting on a column that does not exist finds out.
 */
export const WEBHOOK_EVENT_SORT_FIELDS = [
  'receivedAt',
  'processedAt',
  'status',
  'type',
  'attempts',
] as const;

export const DEFAULT_WEBHOOK_EVENT_SORT = 'receivedAt';

export class WebhookEventsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: WebhookEventStatus })
  @IsOptional()
  @IsEnum(WebhookEventStatus)
  status?: WebhookEventStatus;

  // WebhookEvent has no `createdAt` column, so the inherited default would
  // produce a Prisma error on every unsorted request.
  @ApiPropertyOptional({
    enum: WEBHOOK_EVENT_SORT_FIELDS,
    default: DEFAULT_WEBHOOK_EVENT_SORT,
  })
  @IsOptional()
  @IsIn(WEBHOOK_EVENT_SORT_FIELDS)
  override sortBy: string = DEFAULT_WEBHOOK_EVENT_SORT;
}
