import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserTier } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import type { TransformFnParams } from 'class-transformer';
import {
  Equals,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** The only `event` value this endpoint accepts. Version 1 of the contract. */
export const USER_REGISTRATION_EVENT = 'user.registration';

/** Collapses runs of whitespace so " David   Kim " scores as 8 characters. */
function normaliseWhitespace({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;
}

function trimValue({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * Emails are stored and compared lower-cased. Without this, `David@x.com` and
 * `david@x.com` are two different users as far as the unique index is
 * concerned, and the duplicate check silently lets the second one through.
 */
function normaliseEmail({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

/**
 * The `data` object of a `user.registration` webhook.
 *
 * These are exactly the fields the admin panel's Create User form collects —
 * both registration paths produce the same shape of record, differing only in
 * `source`. See docs/specs/WEBHOOK-CONTRACT.md, "Field reference".
 */
export class UserRegistrationDataDto {
  @ApiProperty({ minLength: 2, maxLength: 100, example: 'David Kim' })
  @Transform(normaliseWhitespace)
  @IsString()
  @IsNotEmpty()
  @Length(2, 100)
  fullName: string;

  @ApiProperty({ example: 'david.kim@email.com' })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiPropertyOptional({ example: '+15555551234' })
  @Transform(trimValue)
  @IsOptional()
  @IsString()
  @MaxLength(30)
  mobileNumber?: string;

  @ApiPropertyOptional({ enum: UserTier, default: UserTier.PLAYER })
  @IsOptional()
  @IsEnum(UserTier)
  tier?: UserTier;

  @ApiPropertyOptional({ maxLength: 200 })
  @Transform(trimValue)
  @IsOptional()
  @IsString()
  @MaxLength(200)
  addressLine1?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @Transform(trimValue)
  @IsOptional()
  @IsString()
  @MaxLength(200)
  addressLine2?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @Transform(trimValue)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @Transform(trimValue)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @ApiPropertyOptional({ maxLength: 20 })
  @Transform(trimValue)
  @IsOptional()
  @IsString()
  @MaxLength(20)
  postalCode?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @Transform(trimValue)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;
}

/**
 * Full webhook envelope.
 *
 * Validated by hand inside WebhooksService rather than by the global
 * ValidationPipe: a validly signed request with a bad payload must return 200
 * with a stored FAILED event, and a pipe would turn it into a 400 the sender
 * retries forever.
 */
export class UserRegistrationWebhookDto {
  @ApiProperty({ example: USER_REGISTRATION_EVENT })
  @Equals(USER_REGISTRATION_EVENT)
  event: string;

  @ApiProperty({ type: UserRegistrationDataDto })
  @IsObject()
  @ValidateNested()
  @Type(() => UserRegistrationDataDto)
  data: UserRegistrationDataDto;
}
