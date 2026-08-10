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
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from './modules/auth/guards/permissions.guard';
import { HealthModule } from './modules/health/health.module';
import { MerchandiseModule } from './modules/merchandise/merchandise.module';
import { ClaimsModule } from './modules/claims/claims.module';
import { DisputesModule } from './modules/disputes/disputes.module';
import { PayoutsModule } from './modules/payouts/payouts.module';
import { PermissionsModule } from './modules/permissions/permissions.module';
import { PrismaModule } from './modules/prisma/prisma.module';
import { RewardsModule } from './modules/rewards/rewards.module';
import { RolesModule } from './modules/roles/roles.module';
import { SecurityModule } from './modules/security/security.module';
import { SettingsModule } from './modules/settings/settings.module';
import { StorageModule } from './modules/storage/storage.module';
import { StripeModule } from './modules/stripe/stripe.module';
import { TournamentsModule } from './modules/tournaments/tournaments.module';
import { TransactionsModule } from './modules/transactions/transactions.module';
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

    // @Global, and imported before anything that moves money: it owns the only
    // code path allowed to write `User.balance` (docs/02-DATA-MODEL.md,
    // "Balance integrity rules").
    TransactionsModule,

    AuthModule,

    RolesModule,

    // The permission catalogue behind the role permissions modal, which used to
    // render a hardcoded list of six camelCase ids (docs/phases/PHASE-3.md).
    PermissionsModule,

    // Previously written but never imported, so their routes did not exist.
    AdminsModule,

    UsersModule,

    // Uploads behind the ADR-003 interface. Imported here as well as by
    // TournamentsModule so a future maintenance endpoint can reach
    // MediaService.cleanupOrphans() without a second binding of the token.
    StorageModule,

    TournamentsModule,

    // Both guarded by the single `rewards.manage` permission, and both reusing
    // the Phase 4 upload pipeline rather than growing one of their own.
    RewardsModule,

    MerchandiseModule,

    // The Stripe SDK behind an injectable interface. Starts cleanly with no
    // STRIPE_SECRET_KEY — the payout routes answer 503 until one is set,
    // rather than the whole API refusing to boot.
    StripeModule,

    // Payouts: approval, the Stripe Connect transfer, and Connect onboarding.
    PayoutsModule,
    ClaimsModule,
    DisputesModule,

    // @Global: the session timeout is read by AuthService at login, and the
    // low-stock threshold and audit retention window are pushed from here into
    // the code that consumes them.
    SettingsModule,

    // Active sessions, revocation, and the alerts feed — which reads real
    // ActivityLog rows rather than the SecurityAlert table (D-06).
    SecurityModule,

    // The four aggregate cards. Last, because it sums what every other module
    // writes.
    DashboardModule,

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
