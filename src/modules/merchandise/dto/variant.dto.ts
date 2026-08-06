import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { emptyStringToUndefined } from '../../../common/dto/enum-token.transform';

/** A typo in a stock field should not be able to claim a million jerseys. */
export const MAX_VARIANT_STOCK = 1_000_000;

/** Uppercase alphanumerics and dashes: a SKU travels through URLs and CSVs. */
export const SKU_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,63}$/;

export class CreateVariantDto {
  @ApiPropertyOptional({ example: 'L', maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  size?: string;

  @ApiPropertyOptional({ example: 'Black', maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  color?: string;

  @ApiPropertyOptional({
    example: 'MERCH-A3F2-L-BLACK',
    description:
      'Optional. Generated from the product id, size and colour when omitted; a supplied value is used as-is and returns 409 if it is already taken.',
  })
  @IsOptional()
  @Transform(emptyStringToUndefined)
  @IsString()
  @Matches(SKU_PATTERN, {
    message:
      'sku must be 3-64 characters of uppercase letters, digits and dashes, starting with a letter or digit',
  })
  sku?: string;

  @ApiPropertyOptional({
    default: 0,
    minimum: 0,
    maximum: MAX_VARIANT_STOCK,
    description: '0 means out of stock, not hidden — the admin still sees it.',
  })
  @IsOptional()
  @Transform(emptyStringToUndefined)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_VARIANT_STOCK)
  stock?: number;
}

/**
 * Every create field, all optional — but written out rather than derived with
 * `PartialType`, because `size` and `color` mean something different here: a
 * supplied empty string clears the attribute, where an omitted key leaves it
 * alone. That distinction only exists on update.
 */
export class UpdateVariantDto {
  @ApiPropertyOptional({
    maxLength: 40,
    description: 'An empty string clears the size.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  size?: string;

  @ApiPropertyOptional({
    maxLength: 40,
    description: 'An empty string clears the colour.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  color?: string;

  @ApiPropertyOptional({ example: 'MERCH-A3F2-L-BLACK' })
  @IsOptional()
  @Transform(emptyStringToUndefined)
  @IsString()
  @Matches(SKU_PATTERN, {
    message:
      'sku must be 3-64 characters of uppercase letters, digits and dashes, starting with a letter or digit',
  })
  sku?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: MAX_VARIANT_STOCK })
  @IsOptional()
  @Transform(emptyStringToUndefined)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_VARIANT_STOCK)
  stock?: number;
}
