import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';

import { MONEY_PATTERN } from './create-tournament.dto';

export class TournamentResultDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  userId: string;

  @ApiProperty({ example: 1, minimum: 1, description: '1 is first place.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  placement: number;

  @ApiPropertyOptional({
    example: '500.00',
    description:
      'Recorded on the registration. No money moves in Phase 4 — see the service.',
  })
  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN, {
    message: 'prizeWon must be a non-negative amount with up to 2 decimals',
  })
  prizeWon?: string;
}

export class SubmitResultsDto {
  @ApiProperty({ type: [TournamentResultDto] })
  @IsArray()
  @ArrayMinSize(1)
  // Bounded so a single request cannot be used to drive an unbounded number of
  // writes; comfortably above the largest bracket the DTO permits (1024).
  @ArrayMaxSize(1024)
  @ValidateNested({ each: true })
  @Type(() => TournamentResultDto)
  results: TournamentResultDto[];
}
