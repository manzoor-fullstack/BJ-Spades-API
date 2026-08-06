import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TournamentStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { CREATABLE_STATUSES } from '../tournament-status';

/**
 * A two-decimal money amount, as a string.
 *
 * Money is a string on the way in as well as on the way out. `entryFee` reaches
 * a `NUMERIC(18,2)` column whose range exceeds what an IEEE-754 double can hold
 * exactly, so parsing it as a number first would quietly round it. Multipart
 * fields arrive as strings anyway; declaring the property as `string` also makes
 * `enableImplicitConversion` stringify a JSON number rather than the reverse.
 */
export const MONEY_PATTERN = /^\d{1,16}(\.\d{1,2})?$/;

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Mirrors the Create Tournament modal, which posts `multipart/form-data`. */
export class CreateTournamentDto {
  @ApiProperty({ example: 'Spring Championship', minLength: 3, maxLength: 120 })
  @IsString()
  @Length(3, 120)
  name: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ example: '25.00', default: '0.00' })
  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN, {
    message: 'entryFee must be a non-negative amount with up to 2 decimals',
  })
  entryFee?: string;

  @ApiPropertyOptional({ example: '1000.00', default: '0.00' })
  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN, {
    message: 'prizePool must be a non-negative amount with up to 2 decimals',
  })
  prizePool?: string;

  @ApiProperty({ example: 16, minimum: 2, maximum: 1024 })
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(1024)
  maxPlayers: number;

  @ApiProperty({
    example: '2026-05-30',
    description:
      'Calendar date, interpreted as UTC. Combined with startTime into startsAt.',
  })
  @IsString()
  @Matches(DATE_PATTERN, { message: 'startDate must be formatted YYYY-MM-DD' })
  startDate: string;

  @ApiProperty({
    example: '20:00',
    description: 'Wall-clock time, interpreted as UTC. 24-hour, HH:mm.',
  })
  @IsString()
  @Matches(TIME_PATTERN, { message: 'startTime must be formatted HH:mm' })
  startTime: string;

  @ApiPropertyOptional({
    enum: CREATABLE_STATUSES,
    default: TournamentStatus.SCHEDULED,
    description:
      'Only SCHEDULED or REGISTERING. A tournament cannot be created already finished or cancelled.',
  })
  @IsOptional()
  // The modal offers all five statuses; creation accepts two. IN_PROGRESS,
  // COMPLETED and CANCELLED are states a tournament reaches, not states it
  // starts in — allowing them would let a cancelled tournament exist that was
  // never scheduled.
  @IsIn(CREATABLE_STATUSES)
  status?: TournamentStatus;
}
