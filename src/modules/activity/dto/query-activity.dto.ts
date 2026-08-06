import { ApiPropertyOptional } from '@nestjs/swagger';
import { ActivityCategory } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination.dto';
import { toBooleanFlag } from '../../../common/dto/enum-token.transform';

export class QueryActivityDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ActivityCategory })
  @IsOptional()
  @IsEnum(ActivityCategory)
  category?: ActivityCategory;

  @ApiPropertyOptional({ description: 'Entries written by this admin' })
  @IsOptional()
  @IsUUID()
  adminId?: string;

  @ApiPropertyOptional({ example: 'User' })
  @IsOptional()
  @IsString()
  entityType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  entityId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toBooleanFlag)
  @IsBoolean()
  isHighPriority?: boolean;

  @ApiPropertyOptional({
    description: 'Inclusive lower bound. A bare date means 00:00:00 UTC.',
    example: '2026-08-01',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    description: 'Inclusive upper bound. A bare date covers the whole day.',
    example: '2026-08-04',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export const DEFAULT_RECENT_LIMIT = 5;
export const MAX_RECENT_LIMIT = 50;

/** `/activity/recent` backs the dashboard sidebar, so it never paginates. */
export class RecentActivityQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_RECENT_LIMIT,
    default: DEFAULT_RECENT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_RECENT_LIMIT)
  limit: number = DEFAULT_RECENT_LIMIT;
}
