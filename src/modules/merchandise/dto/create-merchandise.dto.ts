import { BadRequestException } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ItemStatus } from '@prisma/client';
import { plainToInstance, Transform, Type } from 'class-transformer';
import type { TransformFnParams } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { toEnumToken } from '../../../common/dto/enum-token.transform';
import { MONEY_PATTERN } from '../../../common/money/money.util';

import { CreateVariantDto } from './variant.dto';

/** A product with more variants than this is a data-entry accident. */
export const MAX_VARIANTS_PER_PRODUCT = 50;

/**
 * `multipart/form-data` has no notion of a nested array — every part is a
 * string. The modal therefore sends `variants` as a JSON document in a single
 * field, and this unpacks it.
 *
 * A plain JSON request body (no image) sends a real array, which `@Type` has
 * already turned into `CreateVariantDto` instances by the time this runs; that
 * case is passed straight through.
 *
 * The multipart case has to build the instances itself. `@Transform` runs AFTER
 * `@Type`, so a string that only became an array here would never be handed back
 * for element conversion — `@ValidateNested` would then be inspecting plain
 * objects with no constraints on them and would pass anything.
 *
 * A malformed document is a 400 rather than a 500: a `SyntaxError` escaping a
 * transformer would otherwise surface as an unhandled server error.
 */
function parseVariants(params: TransformFnParams): unknown {
  const raw = (params.obj as Record<string, unknown>)[params.key];

  if (typeof raw !== 'string') {
    return params.value;
  }

  const trimmed = raw.trim();

  if (trimmed === '') {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new BadRequestException(
      'variants must be a JSON array, e.g. [{"size":"L","color":"Black","stock":10}]',
    );
  }

  if (!Array.isArray(parsed)) {
    throw new BadRequestException('variants must be a JSON array');
  }

  if (parsed.some((entry) => typeof entry !== 'object' || entry === null)) {
    throw new BadRequestException('each variant must be a JSON object');
  }

  return plainToInstance(CreateVariantDto, parsed, {
    enableImplicitConversion: true,
  });
}

/** Mirrors `create-products-modal.tsx`, which posts `multipart/form-data`. */
export class CreateMerchandiseDto {
  @ApiProperty({ example: 'Team Jersey', minLength: 2, maxLength: 120 })
  @IsString()
  @Length(2, 120)
  productName: string;

  @ApiProperty({
    example: '39.95',
    description:
      'A non-negative amount with at most two decimals, as a string. Sent and returned as a string so no client parses it into a float.',
  })
  @IsString()
  @Matches(MONEY_PATTERN, {
    message: 'price must be a non-negative amount with up to 2 decimals',
  })
  price: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ enum: ItemStatus, default: ItemStatus.ACTIVE })
  @IsOptional()
  @Transform(toEnumToken)
  @IsEnum(ItemStatus)
  status?: ItemStatus;

  @ApiPropertyOptional({
    type: [CreateVariantDto],
    description:
      'JSON array in multipart, a real array in JSON. Created with the product in ONE transaction — a product with a half-written variant set has no user-visible symptom.',
  })
  @IsOptional()
  @Transform(parseVariants)
  @IsArray()
  @ArrayMaxSize(MAX_VARIANTS_PER_PRODUCT)
  @ValidateNested({ each: true })
  @Type(() => CreateVariantDto)
  variants?: CreateVariantDto[];
}
