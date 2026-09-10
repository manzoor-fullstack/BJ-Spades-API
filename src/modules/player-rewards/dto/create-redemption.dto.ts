import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Matches } from 'class-validator';

import { MONEY_PATTERN } from '../../../common/money/money.util';

export class CreateRedemptionDto {
  @ApiProperty()
  @IsUUID()
  rewardId!: string;

  @ApiProperty({ example: '10.00' })
  @IsString()
  @Matches(MONEY_PATTERN, {
    message: 'denomination must be a positive amount with at most two decimals',
  })
  denomination!: string;

  @ApiProperty({
    description: 'Stable for retries of the same purchase action.',
  })
  @IsUUID()
  requestId!: string;
}
