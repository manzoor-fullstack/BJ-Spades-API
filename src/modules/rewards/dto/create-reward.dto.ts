import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ItemStatus, RewardCategory } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import {
  emptyStringToUndefined,
  toEnumToken,
} from '../../../common/dto/enum-token.transform';

/**
 * An upper bound on `stock` so a typo cannot claim four billion gift cards.
 * `null` (the field omitted) already means unlimited.
 */
export const MAX_REWARD_STOCK = 1_000_000;

/**
 * Mirrors `create-reward-modal.tsx`, which posts `multipart/form-data`.
 *
 * The wire names are the modal's own — `rewardName` and `termsConditions` —
 * rather than the column names. The mapping happens once, in RewardsService,
 * which is cheaper than a frontend change that buys nothing.
 */
export class CreateRewardDto {
  @ApiProperty({ example: 'Free Coffee', minLength: 2, maxLength: 120 })
  @IsString()
  @Length(2, 120)
  rewardName: string;

  @ApiProperty({ example: 'Starbucks', minLength: 1, maxLength: 120 })
  @IsString()
  @Length(1, 120)
  company: string;

  @ApiPropertyOptional({
    enum: RewardCategory,
    default: RewardCategory.GENERAL,
    description: 'Case-insensitive; the modal submits "food", "tech", …',
  })
  @IsOptional()
  @Transform(toEnumToken)
  @IsEnum(RewardCategory)
  category?: RewardCategory;

  @ApiProperty({
    example: '$10 Gift Card',
    description:
      'A display STRING, not an amount. The field mixes currency with token counts — accepted debt, docs/05-DEFERRED-SCOPE.md D-17.',
    maxLength: 60,
  })
  @IsString()
  @Length(1, 60)
  value: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  termsConditions?: string;

  @ApiPropertyOptional({ enum: ItemStatus, default: ItemStatus.ACTIVE })
  @IsOptional()
  @Transform(toEnumToken)
  @IsEnum(ItemStatus)
  status?: ItemStatus;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: MAX_REWARD_STOCK,
    description:
      'Omit for unlimited — correct for a digital gift-card code. 0 means out of stock, not hidden.',
  })
  @IsOptional()
  @Transform(emptyStringToUndefined)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_REWARD_STOCK)
  stock?: number;
}
