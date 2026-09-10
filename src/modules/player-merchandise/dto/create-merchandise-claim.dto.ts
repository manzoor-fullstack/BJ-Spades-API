import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';

export class CreateMerchandiseClaimDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  merchandiseId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  variantId!: string;

  @ApiProperty({ description: 'Stable for retries of the same claim action.' })
  @IsUUID()
  requestId!: string;

  @ApiProperty({ example: 'John Doe' })
  @IsString()
  @Length(2, 120)
  shippingName!: string;

  @ApiProperty({ example: '123 Main St' })
  @IsString()
  @Length(2, 200)
  addressLine1!: string;

  @ApiPropertyOptional({ example: 'Apt 4B' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  addressLine2?: string;

  @ApiProperty({ example: 'New York' })
  @IsString()
  @Length(2, 120)
  city!: string;

  @ApiPropertyOptional({ example: 'NY' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  state?: string;

  @ApiProperty({ example: '10001' })
  @IsString()
  @Length(2, 32)
  postalCode!: string;

  @ApiProperty({ example: 'United States' })
  @IsString()
  @Length(2, 80)
  country!: string;
}
