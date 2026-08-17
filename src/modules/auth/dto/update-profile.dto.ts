import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

/**
 * Self-service profile edit. Sent as `multipart/form-data`, because it carries
 * the avatar alongside the text fields.
 *
 * Note what is absent: `email`, `roleId`, `isActive`, `password`. The global
 * ValidationPipe runs with `forbidNonWhitelisted`, so sending any of them is a
 * 400 rather than a silent no-op — an admin cannot quietly promote themselves
 * through the route they use to fix a typo in their surname.
 */
export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Ada', minLength: 1, maxLength: 60 })
  @IsOptional()
  // Trimmed before validation, so "   " fails `Length(1, 60)` rather than
  // being stored as a name made entirely of spaces.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 60)
  firstName?: string;

  @ApiPropertyOptional({ example: 'Lovelace', minLength: 1, maxLength: 60 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 60)
  lastName?: string;

  @ApiPropertyOptional({
    description: "Send 'true' to clear the current avatar.",
    type: Boolean,
  })
  @IsOptional()
  // Multipart delivers everything as a string, so the coercion is explicit
  // rather than left to enableImplicitConversion — this way exactly one input
  // means true and the rule is readable at the point it applies.
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  removeAvatar?: boolean;
}
