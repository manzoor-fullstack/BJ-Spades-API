import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * One endpoint for both directions: negative debits, positive credits.
 * A reason is mandatory — an unexplained balance change is indistinguishable
 * from fraud when the ledger is audited.
 */
export class AdjustBalanceDto {
  @ApiProperty({
    example: -500,
    description: 'Negative debits, positive credits. Max two decimal places.',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  amount: number;

  @ApiProperty({ example: 'Chargeback on deposit #1234', minLength: 3 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}
