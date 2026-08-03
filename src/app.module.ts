import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import configuration from './config/configuration';
import { envValidationSchema } from './config/env.validation';

import { PrismaModule } from './modules/prisma/prisma.module';
import { PasswordModule } from './common/password/password.module';
import { RolesModule } from './modules/roles/roles.module';
import { AuthModule } from './modules/auth/auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: envValidationSchema,
    }),

    PrismaModule,

    PasswordModule,

    AuthModule,

    RolesModule,
  ],
})
export class AppModule {}
