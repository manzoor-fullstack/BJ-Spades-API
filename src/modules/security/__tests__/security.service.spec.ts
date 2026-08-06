import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ActivityCategory } from '@prisma/client';
import { plainToInstance } from 'class-transformer';

import type { AuthRepository } from '../../auth/repositories/auth.repository';
import type { AuthenticatedAdmin } from '../../auth/interfaces/authenticated-admin.interface';
import { QuerySecurityAlertsDto } from '../dto/query-security-alerts.dto';
import type {
  ListAlertsArgs,
  SecurityRepository,
} from '../repositories/security.repository';
import { SecurityService } from '../security.service';

type Mocked<T> = { [K in keyof T]: jest.Mock };

const NOW = new Date('2026-08-06T12:00:00.000Z');

const CALLER: AuthenticatedAdmin = {
  id: 'admin-1',
  email: 'admin@bjspades.com',
  role: 'SUPER_ADMIN',
  roleId: 'role-1',
  sessionId: 'session-mine',
};

function sessionRow(id: string, adminId = 'admin-1') {
  return {
    id,
    adminId,
    device: 'Desktop',
    browser: 'Chrome 140',
    os: 'Windows 11',
    ipAddress: '203.0.113.7',
    userAgent: 'jest',
    isActive: true,
    revokedAt: null,
    revokedBy: null,
    lastActivity: new Date('2026-08-06T11:00:00.000Z'),
    createdAt: new Date('2026-08-01T09:00:00.000Z'),
    expiresAt: new Date('2026-08-13T09:00:00.000Z'),
    admin: {
      id: adminId,
      firstName: 'Super',
      lastName: 'Admin',
      email: 'admin@bjspades.com',
    },
  };
}

const ALERT_ROW = {
  id: 'log-1',
  category: ActivityCategory.AUTH,
  action: 'auth.login_failed',
  title: 'Failed sign-in attempt',
  description: 'Failed sign-in attempt for admin@bjspades.com',
  adminId: null,
  admin: null,
  entityType: 'Admin',
  entityId: null,
  metadata: null,
  ipAddress: '203.0.113.9',
  userAgent: 'jest',
  isHighPriority: true,
  createdAt: new Date('2026-08-06T10:00:00.000Z'),
};

function query(raw: Record<string, unknown> = {}): QuerySecurityAlertsDto {
  return plainToInstance(QuerySecurityAlertsDto, raw, {
    enableImplicitConversion: true,
  });
}

describe('SecurityService', () => {
  let securityRepository: Mocked<SecurityRepository>;
  let authRepository: Mocked<AuthRepository>;
  let service: SecurityService;

  beforeEach(() => {
    securityRepository = {
      findAlerts: jest.fn().mockResolvedValue([ALERT_ROW]),
      countAlerts: jest.fn().mockResolvedValue(1),
      countFailedLoginsSince: jest.fn().mockResolvedValue(4),
      countHighPriorityAlertsSince: jest.fn().mockResolvedValue(9),
    };

    authRepository = {
      findAllActiveSessions: jest
        .fn()
        .mockResolvedValue([
          sessionRow('session-mine'),
          sessionRow('session-other', 'admin-2'),
        ]),
      countActiveSessions: jest.fn().mockResolvedValue(2),
      findSessionById: jest
        .fn()
        .mockResolvedValue(sessionRow('session-other', 'admin-2')),
      revokeSession: jest.fn().mockResolvedValue(undefined),
      revokeAllSessionsExcept: jest.fn().mockResolvedValue(5),
    } as unknown as Mocked<AuthRepository>;

    service = new SecurityService(
      securityRepository as unknown as SecurityRepository,
      authRepository as unknown as AuthRepository,
    );
  });

  describe('findSessions', () => {
    it("flags the caller's own session and no other", async () => {
      const sessions = await service.findSessions(CALLER);

      expect(sessions.map((s) => [s.id, s.isCurrent])).toEqual([
        ['session-mine', true],
        ['session-other', false],
      ]);
    });

    it('returns the device data recorded at sign-in, with ISO timestamps', async () => {
      const [session] = await service.findSessions(CALLER);

      expect(session).toMatchObject({
        admin: {
          id: 'admin-1',
          fullName: 'Super Admin',
          email: 'admin@bjspades.com',
        },
        device: 'Desktop',
        browser: 'Chrome 140',
        os: 'Windows 11',
        ipAddress: '203.0.113.7',
        lastActivity: '2026-08-06T11:00:00.000Z',
        expiresAt: '2026-08-13T09:00:00.000Z',
      });
    });
  });

  describe('revokeSession', () => {
    it('revokes the session and attributes it to the caller', async () => {
      await service.revokeSession('session-other', CALLER);

      expect(authRepository.revokeSession).toHaveBeenCalledWith(
        'session-other',
        'admin-1',
      );
    });

    it("refuses to revoke the caller's own session", async () => {
      // The obvious gesture on the security page — revoke the row that looks
      // wrong — must not be the gesture that signs the operator out.
      await expect(
        service.revokeSession('session-mine', CALLER),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(authRepository.revokeSession).not.toHaveBeenCalled();
    });

    it('404s for a session that does not exist', async () => {
      authRepository.findSessionById.mockResolvedValue(null);

      await expect(
        service.revokeSession('session-gone', CALLER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s for a session that is already revoked', async () => {
      authRepository.findSessionById.mockResolvedValue({
        ...sessionRow('session-other', 'admin-2'),
        isActive: false,
        revokedAt: new Date(),
      });

      await expect(
        service.revokeSession('session-other', CALLER),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(authRepository.revokeSession).not.toHaveBeenCalled();
    });

    it('returns enough of the session to describe it in the audit entry', async () => {
      await expect(
        service.revokeSession('session-other', CALLER),
      ).resolves.toEqual({
        sessionId: 'session-other',
        adminId: 'admin-2',
        device: 'Desktop',
        ipAddress: '203.0.113.7',
      });
    });
  });

  describe('revokeAllOtherSessions', () => {
    it("spares the caller's own session", async () => {
      await service.revokeAllOtherSessions(CALLER);

      expect(authRepository.revokeAllSessionsExcept).toHaveBeenCalledWith(
        'session-mine',
        'admin-1',
      );
    });

    it('reports how many went', async () => {
      await expect(service.revokeAllOtherSessions(CALLER)).resolves.toEqual({
        revoked: 5,
      });
    });
  });

  describe('stats', () => {
    it('returns exactly the three figures that have a data source', async () => {
      const stats = await service.stats(NOW);

      expect(stats).toEqual({
        activeSessions: 2,
        failedLoginsLast24h: 4,
        highPriorityAlertsLast7d: 9,
      });
    });

    it('does not invent a security score, blocked IPs or verified sessions', () => {
      // D-04, D-05, D-07. None has an input to measure; a number would be
      // arbitrary, and the client makes decisions on these.
      return service.stats(NOW).then((stats) => {
        expect(Object.keys(stats).sort()).toEqual([
          'activeSessions',
          'failedLoginsLast24h',
          'highPriorityAlertsLast7d',
        ]);
      });
    });

    it('counts failed sign-ins over the last 24 hours', async () => {
      await service.stats(NOW);

      expect(securityRepository.countFailedLoginsSince).toHaveBeenCalledWith(
        new Date('2026-08-05T12:00:00.000Z'),
      );
    });

    it('counts high-priority events over the last 7 days', async () => {
      await service.stats(NOW);

      expect(
        securityRepository.countHighPriorityAlertsSince,
      ).toHaveBeenCalledWith(new Date('2026-07-30T12:00:00.000Z'));
    });
  });

  describe('findAlerts', () => {
    const args = (): ListAlertsArgs =>
      (securityRepository.findAlerts.mock.calls as [ListAlertsArgs][])[0]![0];

    it('serialises rows with the same shape the activity page uses', async () => {
      const result = await service.findAlerts(query());

      expect(result.data).toEqual([
        {
          id: 'log-1',
          category: ActivityCategory.AUTH,
          action: 'auth.login_failed',
          title: 'Failed sign-in attempt',
          description: 'Failed sign-in attempt for admin@bjspades.com',
          admin: null,
          entityType: 'Admin',
          entityId: null,
          isHighPriority: true,
          createdAt: '2026-08-06T10:00:00.000Z',
        },
      ]);
      expect(result.meta).toEqual({
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
      });
    });

    it('covers everything security-relevant by default', async () => {
      await service.findAlerts(query());

      expect(args().highPriorityOnly).toBe(false);
    });

    it('reads ?highPriorityOnly=false as false, not true', async () => {
      // Implicit conversion would turn the string "false" into `true`.
      await service.findAlerts(query({ highPriorityOnly: 'false' }));

      expect(args().highPriorityOnly).toBe(false);
    });

    it('narrows the feed when asked', async () => {
      await service.findAlerts(query({ highPriorityOnly: 'true' }));

      expect(args().highPriorityOnly).toBe(true);
    });

    it('refuses a sort field that is not allowlisted', async () => {
      await service.findAlerts(query({ sortBy: 'metadata; DROP TABLE' }));

      expect(args().sortBy).toBe('createdAt');
    });

    it('defaults to newest first', async () => {
      await service.findAlerts(query());

      expect(args().sortOrder).toBe('desc');
    });

    it('passes pagination through', async () => {
      await service.findAlerts(query({ page: 3, limit: 10 }));

      expect(args()).toMatchObject({ skip: 20, take: 10 });
    });
  });
});
