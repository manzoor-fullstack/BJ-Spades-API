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
 * Express resolves `request.ip` from the socket and its configured trusted
 * proxy boundary. Reading X-Forwarded-For here would bypass that boundary and
 * allow a direct client to forge the address used for throttling and auditing.
 */
export function extractIpAddress(request: Request): string | undefined {
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
