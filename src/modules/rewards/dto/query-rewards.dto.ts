import { ApiPropertyOptional } from '@nestjs/swagger';
import { ItemStatus, RewardCategory } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination.dto';
import {
  toBooleanFlag,
  toEnumToken,
} from '../../../common/dto/enum-token.transform';

/** `search` from the base DTO covers the reward name and the company. */
export class QueryRewardsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ItemStatus })
  @IsOptional()
  @Transform(toEnumToken)
  @IsEnum(ItemStatus)
  status?: ItemStatus;

  @ApiPropertyOptional({
    enum: RewardCategory,
    description:
      'Case-insensitive. Anything outside the enum is a 400 — the filter reaches a Prisma enum column, and an unchecked value would either error at the driver or, worse, be ignored and silently return everything.',
  })
  @IsOptional()
  @Transform(toEnumToken)
  @IsEnum(RewardCategory)
  category?: RewardCategory;

  @ApiPropertyOptional({
    description:
      'Include soft-deleted rewards. Off by default: a deleted reward is gone as far as the catalogue is concerned.',
  })
  @IsOptional()
  @Transform(toBooleanFlag)
  @IsBoolean()
  includeDeleted?: boolean;
}
