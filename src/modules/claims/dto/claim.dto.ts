import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ClaimStatus } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

/** `page`, `limit` and `search` are inherited. */
export class QueryClaimsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ClaimStatus })
  @IsOptional()
  @IsEnum(ClaimStatus)
  status?: ClaimStatus;
}

/**
 * A decline must say why.
 *
 * An approval may carry a note but does not need one: "yes" is
 * self-explanatory, whereas a refusal the player can query later is not
 * defensible without a stated reason.
 */
export class DeclineClaimDto {
  @ApiProperty({ example: 'Terms were not accepted at submission.' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class ApproveClaimDto {
  @ApiPropertyOptional({ example: 'Verified against tournament results.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
