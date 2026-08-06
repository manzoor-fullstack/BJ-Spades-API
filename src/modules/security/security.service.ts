import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  buildPaginationMeta,
  resolveSortField,
  SortOrder,
} from '../../common/dto/pagination.dto';
import type { Paginated } from '../../common/interceptors/transform.interceptor';
import {
  toActivityListItem,
  type ActivityListItem,
} from '../activity/serializers/activity.serializer';
import { AuthRepository } from '../auth/repositories/auth.repository';
import type { AuthenticatedAdmin } from '../auth/interfaces/authenticated-admin.interface';

import { QuerySecurityAlertsDto } from './dto/query-security-alerts.dto';
import {
  SecurityRepository,
  type ListAlertsArgs,
} from './repositories/security.repository';
import {
  toSessionListItem,
  type SessionListItem,
} from './serializers/session.serializer';

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

const SORTABLE_ALERT_FIELDS = ['createdAt', 'isHighPriority'] as const;

const DEFAULT_ALERT_SORT = 'createdAt';

/**
 * The three figures the security page can actually back with data.
 *
 * There is no `securityScore` (D-04), no `blockedIps` (D-05) and no
 * `verifiedSessions` (D-07). A security score is a weighted composite of
 * inputs — 2FA adoption, password age, patch level — none of which is measured
 * here, so any number would be arbitrary; "verified" implies device attestation
 * that does not exist; blocked IPs need a blocking subsystem that was never
 * built. Each was removed rather than invented, because the client makes
 * decisions on these numbers.
 */
export interface SecurityStats {
  activeSessions: number;
  failedLoginsLast24h: number;
  highPriorityAlertsLast7d: number;
}

export interface RevokeAllResult {
  revoked: number;
}

/** Just enough of a revoked session to describe it in the audit entry. */
export interface RevokedSessionSummary {
  sessionId: string;
  adminId: string;
  device: string | null;
  ipAddress: string | null;
}

@Injectable()
export class SecurityService {
  constructor(
    private readonly securityRepository: SecurityRepository,
    // Session revocation lives in AuthRepository and stays there: revoking a
    // session must also revoke its refresh-token chain, and one transaction in
    // one place is what guarantees that.
    private readonly authRepository: AuthRepository,
  ) {}

  async findSessions(admin: AuthenticatedAdmin): Promise<SessionListItem[]> {
    const sessions = await this.authRepository.findAllActiveSessions();

    return sessions.map((session) =>
      toSessionListItem(session, admin.sessionId),
    );
  }

  /**
   * Revokes one session. Takes effect on the very next request: Phase 1.1 made
   * `JwtStrategy` resolve the session per request, so a revoked session's
   * still-unexpired access token is rejected immediately rather than when it
   * would have expired anyway.
   */
  async revokeSession(
    sessionId: string,
    admin: AuthenticatedAdmin,
  ): Promise<RevokedSessionSummary> {
    if (sessionId === admin.sessionId) {
      // Refused rather than allowed, because the security page's obvious
      // gesture — revoke the row that looks wrong — must not be the gesture
      // that signs the operator out mid-investigation. Signing yourself out is
      // POST /auth/logout, where it is unambiguous.
      throw new BadRequestException(
        'You cannot revoke the session you are signed in with. Use /auth/logout to sign out.',
      );
    }

    const session = await this.authRepository.findSessionById(sessionId);

    if (!session || !session.isActive || session.revokedAt) {
      throw new NotFoundException('Active session not found.');
    }

    await this.authRepository.revokeSession(sessionId, admin.id);

    // Returned for the audit entry rather than for the client: the route
    // answers 204, so this never reaches the wire.
    return {
      sessionId,
      adminId: session.adminId,
      device: session.device,
      ipAddress: session.ipAddress,
    };
  }

  /** Ends every other live session on the platform, sparing the caller's own. */
  async revokeAllOtherSessions(
    admin: AuthenticatedAdmin,
  ): Promise<RevokeAllResult> {
    const revoked = await this.authRepository.revokeAllSessionsExcept(
      admin.sessionId,
      admin.id,
    );

    return { revoked };
  }

  async stats(now: Date = new Date()): Promise<SecurityStats> {
    const [activeSessions, failedLoginsLast24h, highPriorityAlertsLast7d] =
      await Promise.all([
        this.authRepository.countActiveSessions(now),
        this.securityRepository.countFailedLoginsSince(
          new Date(now.getTime() - 24 * MS_PER_HOUR),
        ),
        this.securityRepository.countHighPriorityAlertsSince(
          new Date(now.getTime() - 7 * MS_PER_DAY),
        ),
      ]);

    return { activeSessions, failedLoginsLast24h, highPriorityAlertsLast7d };
  }

  /**
   * The alerts feed, read from `ActivityLog` (D-06).
   *
   * Rows are serialised with the same helper the activity page uses, so an
   * entry reads identically in both places. The HIGH/MEDIUM/LOW severity chips
   * from the mock collapse to `isHighPriority`, and the
   * Unresolved/Investigating/Resolved workflow is gone: there is no triage
   * model to back it.
   */
  async findAlerts(
    query: QuerySecurityAlertsDto,
  ): Promise<Paginated<ActivityListItem[]>> {
    const args: ListAlertsArgs = {
      highPriorityOnly: query.highPriorityOnly,
      sortBy: resolveSortField(
        query.sortBy,
        SORTABLE_ALERT_FIELDS,
        DEFAULT_ALERT_SORT,
      ),
      sortOrder: query.sortOrder === SortOrder.ASC ? 'asc' : 'desc',
      skip: query.skip,
      take: query.take,
    };

    const [rows, total] = await Promise.all([
      this.securityRepository.findAlerts(args),
      this.securityRepository.countAlerts(args.highPriorityOnly),
    ]);

    return {
      data: rows.map(toActivityListItem),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }
}
