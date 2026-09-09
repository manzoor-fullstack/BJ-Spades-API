import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Matches } from 'class-validator';

import { MONEY_PATTERN } from '../../../common/money/money.util';

export class CreateWithdrawalDto {
  @ApiProperty({ example: '100.00', minimum: 100 })
  @IsString()
  @Matches(MONEY_PATTERN, {
    message: 'amount must be a positive USD amount with at most two decimals',
  })
  amount!: string;

  @ApiProperty({
    description: 'A verified payout destination owned by the player.',
  })
  @IsUUID()
  destinationId!: string;

  @ApiProperty({ description: 'Stable for retries of the same button action.' })
  @IsUUID()
  requestId!: string;
}
