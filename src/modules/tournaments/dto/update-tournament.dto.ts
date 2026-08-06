import { ApiPropertyOptional } from '@nestjs/swagger';
import { TournamentStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import {
  DATE_PATTERN,
  MONEY_PATTERN,
  TIME_PATTERN,
} from './create-tournament.dto';

/**
 * Written out rather than derived with `PartialType(CreateTournamentDto)`.
 *
 * Two things genuinely differ: `status` here accepts the full enum (the
 * transition table decides what is legal, not the DTO), and `startDate` /
 * `startTime` must be supplied together or not at all — a rule enforced in the
 * service, where both values are visible at once.
 */
export class UpdateTournamentDto {
  @ApiPropertyOptional({ minLength: 3, maxLength: 120 })
  @IsOptional()
  @IsString()
  @Length(3, 120)
  name?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ example: '25.00' })
  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN, {
    message: 'entryFee must be a non-negative amount with up to 2 decimals',
  })
  entryFee?: string;

  @ApiPropertyOptional({ example: '1000.00' })
  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN, {
    message: 'prizePool must be a non-negative amount with up to 2 decimals',
  })
  prizePool?: string;

  @ApiPropertyOptional({ example: 16, minimum: 2, maximum: 1024 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(1024)
  maxPlayers?: number;

  @ApiPropertyOptional({
    example: '2026-05-30',
    description: 'UTC calendar date',
  })
  @IsOptional()
  @IsString()
  @Matches(DATE_PATTERN, { message: 'startDate must be formatted YYYY-MM-DD' })
  startDate?: string;

  @ApiPropertyOptional({ example: '20:00', description: 'UTC wall-clock time' })
  @IsOptional()
  @IsString()
  @Matches(TIME_PATTERN, { message: 'startTime must be formatted HH:mm' })
  startTime?: string;

  @ApiPropertyOptional({
    enum: TournamentStatus,
    description:
      'Validated against the transition table; an illegal move returns 422.',
  })
  @IsOptional()
  @IsEnum(TournamentStatus)
  status?: TournamentStatus;
}
