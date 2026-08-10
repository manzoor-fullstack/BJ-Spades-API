import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { toBooleanFlag } from '../../../common/dto/enum-token.transform';
import { SETTINGS_REGISTRY } from '../settings.registry';

/**
 * A partial settings update: every property optional, only the keys present
 * are written (docs/03-API-CONTRACT.md).
 *
 * The keys are spelled out one by one rather than accepted as a free-form
 * object because the global pipe runs with `forbidNonWhitelisted` — which is
 * precisely what turns an unknown key into a 400 before it can reach the
 * database and become a setting nothing reads. `SettingsService` validates the
 * same keys again against `SETTINGS_REGISTRY`, which stays the single source of
 * truth for bounds; a unit test asserts the two lists cannot drift apart.
 *
 * There is no `twoFactorAuth` and no `ipWhitelisting` property. See
 * `settings.registry.ts` — D-08 and D-09.
 */
export class UpdateSettingsDto {
  @ApiPropertyOptional({ example: 'BJ Spades', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(SETTINGS_REGISTRY['company.name'].maxLength)
  'company.name'?: string;

  @ApiPropertyOptional({ example: 'admin@bjspades.com' })
  @IsOptional()
  @IsEmail()
  'company.adminEmail'?: string;

  @ApiPropertyOptional({
    example: 'America/New_York',
    description: 'IANA timezone identifier',
  })
  @IsOptional()
  @IsString()
  'company.timezone'?: string;

  @ApiPropertyOptional({ example: 5, minimum: 0, maximum: 1000 })
  @IsOptional()
  @IsInt()
  @Min(SETTINGS_REGISTRY['inventory.lowStockThreshold'].min)
  @Max(SETTINGS_REGISTRY['inventory.lowStockThreshold'].max)
  'inventory.lowStockThreshold'?: number;

  // `@Transform(toBooleanFlag)` reads the raw value off `params.obj`:
  // implicit conversion runs first and turns the string "false" into `true`,
  // which would silently flip a toggle the operator meant to switch off.
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @Transform(toBooleanFlag)
  @IsBoolean()
  'notifications.newUsers'?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @Transform(toBooleanFlag)
  @IsBoolean()
  'notifications.securityAlerts'?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @Transform(toBooleanFlag)
  @IsBoolean()
  'notifications.largeTransactions'?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @Transform(toBooleanFlag)
  @IsBoolean()
  'notifications.dailySummary'?: boolean;

  @ApiPropertyOptional({ example: 10080, minimum: 15, maximum: 43200 })
  @IsOptional()
  @IsInt()
  @Min(SETTINGS_REGISTRY['security.sessionTimeoutMinutes'].min)
  @Max(SETTINGS_REGISTRY['security.sessionTimeoutMinutes'].max)
  'security.sessionTimeoutMinutes'?: number;

  @ApiPropertyOptional({
    example: false,
    description:
      'Emergency stop. While true, processing a payout is refused with 422.',
  })
  @IsOptional()
  @Transform(toBooleanFlag)
  @IsBoolean()
  'payouts.frozen'?: boolean;

  @ApiPropertyOptional({ example: 180, minimum: 30, maximum: 730 })
  @IsOptional()
  @IsInt()
  @Min(SETTINGS_REGISTRY['activity.retentionDays'].min)
  @Max(SETTINGS_REGISTRY['activity.retentionDays'].max)
  'activity.retentionDays'?: number;
}
