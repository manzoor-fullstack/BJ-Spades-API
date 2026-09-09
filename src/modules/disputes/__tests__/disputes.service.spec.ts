import { UnprocessableEntityException } from '@nestjs/common';
import { DisputeRisk, DisputeStatus } from '@prisma/client';

import type { AuthenticatedAdmin } from '../../auth/interfaces/authenticated-admin.interface';
import { TournamentProgressionService } from '../../tournaments/tournament-progression.service';
import { DisputesService } from '../disputes.service';
import { DisputesRepository } from '../repositories/disputes.repository';
import type { DisputeWithRelations } from '../repositories/disputes.repository';

const admin: AuthenticatedAdmin = {
  id: 'admin-1',
  email: 'admin@example.com',
  role: 'SUPER_ADMIN',
  roleId: 'role-1',
  sessionId: 'session-1',
};

function disputeFixture(
  status: DisputeStatus = DisputeStatus.UNDER_REVIEW,
): DisputeWithRelations {
  return {
    id: 'dispute-1',
    caseNumber: 'DSP-1001',
    userId: 'user-1',
    tournamentId: 'tournament-1',
    matchReference: 'match-1',
    reason: 'Suspicious result',
    risk: DisputeRisk.HIGH,
    status,
    filedAt: new Date('2026-09-09T00:00:00.000Z'),
    resolvedAt:
      status === DisputeStatus.UNDER_REVIEW
        ? null
        : new Date('2026-09-09T01:00:00.000Z'),
    resolvedByAdminId: status === DisputeStatus.UNDER_REVIEW ? null : admin.id,
    resolutionNote:
      status === DisputeStatus.UNDER_REVIEW ? null : 'Reviewed evidence',
    createdAt: new Date('2026-09-09T00:00:00.000Z'),
    updatedAt: new Date('2026-09-09T01:00:00.000Z'),
    user: {
      id: 'user-1',
      firstName: 'Test',
      lastName: 'Player',
      email: 'player@example.com',
    },
    tournament: { id: 'tournament-1', name: 'F09 Cup' },
  };
}

describe('DisputesService tournament reconciliation', () => {
  const repository = {
    findById: jest.fn(),
    resolve: jest.fn(),
  };
  const progression = {
    disqualifyPlayer: jest.fn(),
    releaseHeldAwards: jest.fn(),
  };
  const service = new DisputesService(
    repository as unknown as DisputesRepository,
    progression as unknown as TournamentProgressionService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('keeps dispute reads side-effect free', async () => {
    repository.findById.mockResolvedValue(disputeFixture());

    await expect(service.findOne('dispute-1')).resolves.toMatchObject({
      id: 'dispute-1',
      status: DisputeStatus.UNDER_REVIEW,
    });
    expect(progression.disqualifyPlayer).not.toHaveBeenCalled();
    expect(progression.releaseHeldAwards).not.toHaveBeenCalled();
  });

  it('applies the tournament disqualification after resolving the dispute', async () => {
    repository.findById
      .mockResolvedValueOnce(disputeFixture())
      .mockResolvedValueOnce(disputeFixture(DisputeStatus.DISQUALIFIED));
    repository.resolve.mockResolvedValue(1);

    await expect(
      service.disqualify('dispute-1', { note: 'Reviewed evidence' }, admin),
    ).resolves.toMatchObject({ status: DisputeStatus.DISQUALIFIED });
    expect(progression.disqualifyPlayer).toHaveBeenCalledWith(
      'tournament-1',
      'user-1',
      'DSP-1001',
    );
  });

  it('retries the idempotent tournament action for the same saved verdict', async () => {
    repository.findById.mockResolvedValue(
      disputeFixture(DisputeStatus.DISQUALIFIED),
    );

    await expect(
      service.disqualify('dispute-1', { note: 'Reviewed evidence' }, admin),
    ).resolves.toMatchObject({ status: DisputeStatus.DISQUALIFIED });
    expect(repository.resolve).not.toHaveBeenCalled();
    expect(progression.disqualifyPlayer).toHaveBeenCalledTimes(1);
  });

  it('rejects a different verdict after the dispute is resolved', async () => {
    repository.findById.mockResolvedValue(
      disputeFixture(DisputeStatus.DISQUALIFIED),
    );

    await expect(
      service.clear('dispute-1', { note: 'Changed verdict' }, admin),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(progression.releaseHeldAwards).not.toHaveBeenCalled();
  });
});
