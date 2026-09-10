import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, Length } from 'class-validator';

export class FulfillRedemptionDto {
  @ApiProperty({ description: 'The real supplier/manual bearer code.' })
  @IsString()
  @Length(4, 512)
  code!: string;

  @ApiProperty({ description: 'Stable supplier operation identifier.' })
  @IsString()
  @Length(1, 255)
  supplierReference!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
