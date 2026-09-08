import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { DATE_PATTERN, TIME_PATTERN } from './create-tournament.dto';

export class CreatePlayerTournamentDto {
  @ApiProperty({ example: 'Friends & Family Cup' })
  @IsString()
  @Length(3, 120)
  name!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ minimum: 2, maximum: 64, example: 8 })
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(64)
  maxPlayers!: number;

  @ApiProperty({ example: '2026-10-20' })
  @IsString()
  @Matches(DATE_PATTERN, { message: 'startDate must be formatted YYYY-MM-DD' })
  startDate!: string;

  @ApiProperty({ example: '20:00' })
  @IsString()
  @Matches(TIME_PATTERN, { message: 'startTime must be formatted HH:mm' })
  startTime!: string;
}
