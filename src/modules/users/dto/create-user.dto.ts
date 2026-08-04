import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserTier } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Mirrors the fields of the create-user modal exactly — one `fullName` box, one
 * `mobileNumber` box — rather than the database columns. The split into
 * firstName / lastName happens server-side so the modal and the registration
 * webhook cannot drift apart. See docs/03-API-CONTRACT.md, `POST /users`.
 */
export class CreateUserDto {
  @ApiProperty({ example: 'John Mitchell', minLength: 2, maxLength: 100 })
  @IsString()
  @Length(2, 100)
  // Two spaces pass @Length but would split into an empty first name.
  @Matches(/\S\s*\S/, {
    message: 'fullName must contain at least two non-whitespace characters',
  })
  fullName: string;

  @ApiProperty({ example: 'john.mitchell@email.com', maxLength: 255 })
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiPropertyOptional({ example: '+15555551234' })
  @IsOptional()
  @IsString()
  @Length(5, 20)
  @Matches(/^[+0-9][0-9\s()\-.]{4,19}$/, {
    message: 'mobileNumber must be a valid phone number',
  })
  mobileNumber?: string;

  @ApiPropertyOptional({ enum: UserTier, default: UserTier.PLAYER })
  @IsOptional()
  @IsEnum(UserTier)
  tier?: UserTier;

  @ApiPropertyOptional({ example: 100, minimum: 0 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  initialBalance?: number;

  @ApiPropertyOptional({ example: '123 Main St' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  addressLine1?: string;

  @ApiPropertyOptional({ example: 'Apt 4B' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  addressLine2?: string;

  @ApiPropertyOptional({ example: 'New York' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({ example: 'NY' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @ApiPropertyOptional({ example: '10001' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  postalCode?: string;

  @ApiPropertyOptional({ example: 'United States' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;
}
