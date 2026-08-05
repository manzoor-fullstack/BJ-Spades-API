import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import configuration from './config/configuration';
import { envValidationSchema } from './config/env.validation';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { PasswordModule } from './common/password/password.module';

import { ActivityModule } from './modules/activity/activity.module';
import { AdminsModule } from './modules/admins/admins.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from './modules/auth/guards/permissions.guard';
import { HealthModule } from './modules/health/health.module';
import { PermissionsModule } from './modules/permissions/permissions.module';
import { PrismaModule } from './modules/prisma/prisma.module';
import { RolesModule } from './modules/roles/roles.module';
import { UsersModule } from './modules/users/users.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: envValidationSchema,
    }),

    // Baseline limits for every route.
    //
    // One throttler MUST be named `default`: that is the name @Throttle()
    // overrides unless told otherwise. Naming them all something else makes
    // per-route overrides silently no-ops.
    ThrottlerModule.forRoot({
      throttlers: [
        { name: 'default', ttl: 60_000, limit: 100 },
        { name: 'burst', ttl: 1_000, limit: 10 },
      ],
      // Integration suites sign in dozens of times and would otherwise trip the
      // 5-per-minute login limit. Read per request, so a single spec can switch
      // it back on to cover throttling deliberately.
      skipIf: () => process.env.THROTTLE_DISABLED === 'true',
    }),

    PrismaModule,

    PasswordModule,

    // @Global: nearly every module writes audit entries, and AuditInterceptor
    // is bound below through APP_INTERCEPTOR.
    ActivityModule,

    AuthModule,

    RolesModule,

    // The permission catalogue behind the role permissions modal, which used to
    // render a hardcoded list of six camelCase ids (docs/phases/PHASE-3.md).
    PermissionsModule,

    // Previously written but never imported, so their routes did not exist.
    AdminsModule,

    UsersModule,

    // The second registration path: HMAC-signed posts from the external
    // signup form. Requires the raw-body middleware wired up in main.ts.
    WebhooksModule,

    HealthModule,
  ],

  providers: [
    // Order matters: global guards run in registration order. Rate limiting
    // first so unauthenticated floods are cheap, then authentication, then
    // authorisation — which needs the admin the previous guard attached.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // useExisting, not useClass: the guard owns a permission cache that Phase 3
    // invalidates through the AuthModule-provided instance.
    { provide: APP_GUARD, useExisting: PermissionsGuard },

    { provide: APP_FILTER, useClass: AllExceptionsFilter },

    // Order matters here too, in reverse: the first-registered interceptor is
    // the outermost, so its response mapping runs last. TransformInterceptor
    // must sit outside AuditInterceptor, otherwise `@AuditLog` resolvers would
    // be handed `{ success: true, data: ... }` instead of the handler's result.
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
