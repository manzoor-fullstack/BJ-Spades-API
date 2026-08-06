import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Approval may carry a note; it is not required to approve. */
export class ApprovePayoutDto {
  @ApiPropertyOptional({
    example: 'Verified against the bracket',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * A reason is mandatory. Cancelling a payout takes money off a player who was
 * told they had won it; an unexplained cancellation is indistinguishable from
 * an error when the ledger is audited later.
 */
export class CancelPayoutDto {
  @ApiProperty({ example: 'Duplicate of payout #4821', minLength: 3 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}
