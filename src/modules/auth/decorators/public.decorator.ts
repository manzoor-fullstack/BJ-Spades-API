import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Exempts a route from the global JwtAuthGuard.
 *
 * Guards are registered globally (see docs/01-ARCHITECTURE.md ADR-002), so every
 * route is protected by default and must opt out explicitly. Only three routes
 * should ever carry this: login, refresh, and the HMAC-authenticated
 * registration webhook. Health is public too, but exposes nothing sensitive.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
