import { Request } from 'express';
import { UAParser } from 'ua-parser-js';

export interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
  browser?: string;
  os?: string;
  device?: string;
}

/**
 * Extracts the client IP.
 *
 * `X-Forwarded-For` is a comma-separated chain; the left-most entry is the
 * original client. Only trust it behind a proxy that overwrites it — otherwise
 * a client can forge the header. Express does this correctly when `trust proxy`
 * is configured, which is a deployment concern (see PHASE-8 runbook).
 */
export function extractIpAddress(request: Request): string | undefined {
  const forwarded = request.headers['x-forwarded-for'];

  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }

  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0]?.split(',')[0]?.trim();
  }

  return request.ip ?? request.socket.remoteAddress ?? undefined;
}

/**
 * Builds the session metadata shown on the security page.
 *
 * Previously `createSession` was called with no arguments at all, so device,
 * browser, and IP were always null.
 */
export function extractRequestContext(request: Request): RequestContext {
  const userAgent = request.headers['user-agent'];
  const ipAddress = extractIpAddress(request);

  if (!userAgent) {
    return { ipAddress };
  }

  const parsed = UAParser(userAgent);

  const browser = parsed.browser.name
    ? [parsed.browser.name, parsed.browser.version?.split('.')[0]]
        .filter(Boolean)
        .join(' ')
    : undefined;

  const os = parsed.os.name
    ? [parsed.os.name, parsed.os.version].filter(Boolean).join(' ')
    : undefined;

  // ua-parser reports device.type only for non-desktop clients, so an absent
  // type means desktop rather than unknown.
  const device = parsed.device.type
    ? [parsed.device.vendor, parsed.device.model].filter(Boolean).join(' ') ||
      parsed.device.type
    : 'Desktop';

  return {
    ipAddress,
    userAgent: userAgent.slice(0, 512),
    browser,
    os,
    device,
  };
}
