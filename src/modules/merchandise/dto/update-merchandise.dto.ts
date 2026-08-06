import { ApiPropertyOptional } from '@nestjs/swagger';
import { ItemStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

import { toEnumToken } from '../../../common/dto/enum-token.transform';
import { MONEY_PATTERN } from '../../../common/money/money.util';

/**
 * Product fields only — deliberately NOT `PartialType(CreateMerchandiseDto)`.
 *
 * `variants` is absent because a partial array has no sane meaning: is
 * `[{size:'L'}]` a replacement of the whole set, an addition, or an edit of the
 * first row? The variant endpoints answer that unambiguously, one variant at a
 * time, and each writes its own audit entry.
 */
export class UpdateMerchandiseDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 120 })
  @IsOptional()
  @IsString()
  @Length(2, 120)
  productName?: string;

  @ApiPropertyOptional({ example: '39.95' })
  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN, {
    message: 'price must be a non-negative amount with up to 2 decimals',
  })
  price?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ enum: ItemStatus })
  @IsOptional()
  @Transform(toEnumToken)
  @IsEnum(ItemStatus)
  status?: ItemStatus;
}
