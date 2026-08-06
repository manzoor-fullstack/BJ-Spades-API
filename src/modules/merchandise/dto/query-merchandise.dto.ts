import { ApiPropertyOptional } from '@nestjs/swagger';
import { ItemStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination.dto';
import {
  toBooleanFlag,
  toEnumToken,
} from '../../../common/dto/enum-token.transform';

/** `search` from the base DTO covers the product name. */
export class QueryMerchandiseDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ItemStatus })
  @IsOptional()
  @Transform(toEnumToken)
  @IsEnum(ItemStatus)
  status?: ItemStatus;

  @ApiPropertyOptional({
    description: 'Include soft-deleted products. Off by default.',
  })
  @IsOptional()
  @Transform(toBooleanFlag)
  @IsBoolean()
  includeDeleted?: boolean;
}
