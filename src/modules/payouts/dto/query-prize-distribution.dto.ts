import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsLowercase,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';

/**
 * `tournamentId` is required: the Overview tab always renders exactly one
 * tournament, and "all tournaments at once" would be a different table with a
 * different shape.
 *
 * `currency` **filters**; it does not convert. There is no FX rate source in
 * this system, so offering conversion would misstate money on a finance
 * screen.
 */
export class QueryPrizeDistributionDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  tournamentId!: string;

  @ApiPropertyOptional({ example: 'usd' })
  @IsOptional()
  @IsString()
  @IsLowercase()
  @Length(3, 3)
  currency?: string;
}
