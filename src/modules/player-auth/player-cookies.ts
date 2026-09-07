import type { Request, Response } from 'express';

export const PLAYER_ACCESS_COOKIE = 'bjs_player_access';
export const PLAYER_REFRESH_COOKIE = 'bjs_player_refresh';
export const PLAYER_CSRF_COOKIE = 'bjs_player_csrf';

export interface PlayerCookieTokens {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
  csrfToken: string;
}

export function readCookie(request: Request, name: string): string | undefined {
  const raw = request.headers.cookie;
  if (!raw) return undefined;

  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }

  return undefined;
}

export function writePlayerCookies(
  response: Response,
  tokens: PlayerCookieTokens,
  rememberMe: boolean,
  secure: boolean,
): void {
  const shared = { secure, sameSite: 'lax' as const, path: '/' };

  response.cookie(PLAYER_ACCESS_COOKIE, tokens.accessToken, {
    ...shared,
    httpOnly: true,
    expires: tokens.accessExpiresAt,
  });
  response.cookie(PLAYER_REFRESH_COOKIE, tokens.refreshToken, {
    ...shared,
    httpOnly: true,
    ...(rememberMe ? { expires: tokens.refreshExpiresAt } : {}),
  });
  response.cookie(PLAYER_CSRF_COOKIE, tokens.csrfToken, {
    ...shared,
    httpOnly: false,
    ...(rememberMe ? { expires: tokens.refreshExpiresAt } : {}),
  });
}

export function clearPlayerCookies(response: Response, secure: boolean): void {
  const options = { secure, sameSite: 'lax' as const, path: '/' };
  response.clearCookie(PLAYER_ACCESS_COOKIE, options);
  response.clearCookie(PLAYER_REFRESH_COOKIE, options);
  response.clearCookie(PLAYER_CSRF_COOKIE, options);
}
