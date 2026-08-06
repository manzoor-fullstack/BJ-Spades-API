import { ApiPropertyOptional } from '@nestjs/swagger';
import { PayoutMethod, PayoutStatus } from '@prisma/client';
import { IsEnum, IsISO8601, IsOptional, IsUUID } from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

/**
 * `page`, `limit`, `search`, `sortBy` and `sortOrder` are inherited.
 * `search` matches the recipient's name or email, or the tournament name.
 */
export class QueryPayoutsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PayoutStatus })
  @IsOptional()
  @IsEnum(PayoutStatus)
  status?: PayoutStatus;

  @ApiPropertyOptional({ enum: PayoutMethod })
  @IsOptional()
  @IsEnum(PayoutMethod)
  method?: PayoutMethod;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  tournamentId?: string;

  @ApiPropertyOptional({ example: '2026-08-01' })
  @IsOptional()
  @IsISO8601()
  owedFrom?: string;

  @ApiPropertyOptional({ example: '2026-08-31' })
  @IsOptional()
  @IsISO8601()
  owedTo?: string;
}
