import { Global, Module } from '@nestjs/common';

import { SettingsRepository } from './repositories/settings.repository';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

/**
 * Global for the same reason ActivityModule is: the settings it owns are
 * consumed outside this module — `AuthService` reads the session timeout at
 * login, and anything needing the company profile reads it here. Importing
 * SettingsModule into each of those is an import to forget, and one of them
 * (AuthModule) would introduce an import cycle if this module ever needed auth.
 */
@Global()
@Module({
  controllers: [SettingsController],
  providers: [SettingsService, SettingsRepository],
  exports: [SettingsService],
})
export class SettingsModule {}
