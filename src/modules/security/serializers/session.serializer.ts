import { joinFullName } from '../../../common/text/split-full-name.util';

export interface SessionAdminSummary {
  id: string;
  fullName: string;
  email: string;
}

/** One row of the active sessions table on the security page. */
export interface SessionListItem {
  id: string;
  admin: SessionAdminSummary;
  /** Parsed from the user agent at login; null when it could not be read. */
  device: string | null;
  browser: string | null;
  os: string | null;
  ipAddress: string | null;
  lastActivity: string;
  createdAt: string;
  expiresAt: string;
  /**
   * True for the session this request is authenticated against.
   *
   * The UI marks it "This device"; the API refuses to revoke it. Without the
   * flag the obvious way to sign a suspicious device out is also the way to
   * sign yourself out by accident.
   */
  isCurrent: boolean;
}

export interface SessionRow {
  id: string;
  device: string | null;
  browser: string | null;
  os: string | null;
  ipAddress: string | null;
  lastActivity: Date;
  createdAt: Date;
  expiresAt: Date;
  admin: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  };
}

export function toSessionListItem(
  row: SessionRow,
  currentSessionId: string,
): SessionListItem {
  return {
    id: row.id,
    admin: {
      id: row.admin.id,
      fullName: joinFullName(row.admin.firstName, row.admin.lastName),
      email: row.admin.email,
    },
    device: row.device,
    browser: row.browser,
    os: row.os,
    ipAddress: row.ipAddress,
    lastActivity: row.lastActivity.toISOString(),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    isCurrent: row.id === currentSessionId,
  };
}
