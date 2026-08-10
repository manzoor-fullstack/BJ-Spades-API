import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DisputeRisk, DisputeStatus } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

/** `page`, `limit` and `search` are inherited. */
export class QueryDisputesDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: DisputeStatus })
  @IsOptional()
  @IsEnum(DisputeStatus)
  status?: DisputeStatus;

  @ApiPropertyOptional({ enum: DisputeRisk })
  @IsOptional()
  @IsEnum(DisputeRisk)
  risk?: DisputeRisk;
}

/**
 * Both verdicts require a note.
 *
 * Unlike a claim approval, neither outcome here is self-explanatory: clearing
 * a flagged player and disqualifying one are each decisions someone may have
 * to defend to that player later, and a verdict with no stated reason cannot
 * be.
 */
export class ResolveDisputeDto {
  @ApiProperty({ example: 'Reviewed match logs; bidding pattern explained.' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  note!: string;
}
