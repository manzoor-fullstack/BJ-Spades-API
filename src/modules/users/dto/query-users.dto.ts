import { ApiPropertyOptional } from '@nestjs/swagger';
import { UserSource, UserStatus, UserTier } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional } from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

/**
 * `GET /users` and `GET /users/export` share this DTO so the export can never
 * apply a different filter set from the table it was exported from.
 */
export class QueryUsersDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: UserStatus,
    description:
      'Soft-deleted users are excluded from every response unless DELETED is asked for explicitly.',
  })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @ApiPropertyOptional({ enum: UserTier })
  @IsOptional()
  @IsEnum(UserTier)
  tier?: UserTier;

  @ApiPropertyOptional({ enum: UserSource })
  @IsOptional()
  @IsEnum(UserSource)
  source?: UserSource;

  @ApiPropertyOptional({ example: '2026-01-01', description: 'ISO date' })
  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  @ApiPropertyOptional({
    example: '2026-12-31',
    description:
      'ISO date. A date without a time covers the whole day, inclusive.',
  })
  @IsOptional()
  @IsDateString()
  createdTo?: string;
}
