import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DisputeStatus } from '@prisma/client';

import { buildPaginationMeta } from '../../common/dto/pagination.dto';
import type { Paginated } from '../../common/interceptors/transform.interceptor';
import type { AuthenticatedAdmin } from '../auth/interfaces/authenticated-admin.interface';
import { TournamentProgressionService } from '../tournaments/tournament-progression.service';

import { QueryDisputesDto, ResolveDisputeDto } from './dto/dispute.dto';
import { DisputesRepository } from './repositories/disputes.repository';
import type { DisputeWithRelations } from './repositories/disputes.repository';
import {
  OPEN_DISPUTE_STATUSES,
  toDisputeListItem,
} from './serializers/dispute.serializer';
import type {
  DisputeListItem,
  DisputeStats,
} from './serializers/dispute.serializer';

@Injectable()
export class DisputesService {
  constructor(
    private readonly repository: DisputesRepository,
    private readonly tournamentProgression: TournamentProgressionService,
  ) {}

  async findAll(
    query: QueryDisputesDto,
  ): Promise<Paginated<DisputeListItem[]>> {
    const filter = {
      search: query.search?.trim() ? query.search.trim() : undefined,
      status: query.status,
      risk: query.risk,
    };

    const [disputes, total] = await Promise.all([
      this.repository.findMany({ filter, skip: query.skip, take: query.take }),
      this.repository.count(filter),
    ]);

    return {
      data: disputes.map(toDisputeListItem),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  stats(): Promise<DisputeStats> {
    return this.repository.stats();
  }

  async findOne(id: string): Promise<DisputeListItem> {
    return toDisputeListItem(await this.getOrThrow(id));
  }

  clear(
    id: string,
    dto: ResolveDisputeDto,
    admin: AuthenticatedAdmin,
  ): Promise<DisputeListItem> {
    return this.resolve(id, DisputeStatus.CLEARED, dto, admin);
  }

  disqualify(
    id: string,
    dto: ResolveDisputeDto,
    admin: AuthenticatedAdmin,
  ): Promise<DisputeListItem> {
    return this.resolve(id, DisputeStatus.DISQUALIFIED, dto, admin);
  }

  private async resolve(
    id: string,
    status: DisputeStatus,
    dto: ResolveDisputeDto,
    admin: AuthenticatedAdmin,
  ): Promise<DisputeListItem> {
    const dispute = await this.getOrThrow(id);

    if (!OPEN_DISPUTE_STATUSES.includes(dispute.status)) {
      const isExactRetry =
        dispute.status === status &&
        dispute.resolvedByAdminId === admin.id &&
        dispute.resolutionNote === dto.note.trim();
      if (isExactRetry) {
        await this.reconcileTournamentResolution(dispute, status);
        return toDisputeListItem(dispute);
      }

      throw new UnprocessableEntityException(
        `Case ${dispute.caseNumber} is already ${dispute.status.toLowerCase().replace('_', ' ')} and cannot be resolved again.`,
      );
    }

    const count = await this.repository.resolve(
      id,
      status,
      admin.id,
      dto.note.trim(),
    );

    if (count === 0) {
      const resolved = await this.getOrThrow(id);
      if (resolved.status === status) {
        await this.reconcileTournamentResolution(resolved, status);
        return toDisputeListItem(resolved);
      }

      throw new UnprocessableEntityException(
        'The case was resolved while you were reviewing it. Reload and retry.',
      );
    }

    const resolved = await this.getOrThrow(id);
    await this.reconcileTournamentResolution(resolved, status);
    return toDisputeListItem(resolved);
  }

  private async reconcileTournamentResolution(
    dispute: DisputeWithRelations,
    status: DisputeStatus,
  ): Promise<void> {
    if (!dispute.tournamentId) return;

    if (status === DisputeStatus.DISQUALIFIED) {
      await this.tournamentProgression.disqualifyPlayer(
        dispute.tournamentId,
        dispute.userId,
        dispute.caseNumber,
      );
      return;
    }

    await this.tournamentProgression.releaseHeldAwards(
      dispute.tournamentId,
      dispute.userId,
    );
  }

  private async getOrThrow(id: string): Promise<DisputeWithRelations> {
    const dispute = await this.repository.findById(id);

    if (!dispute) throw new NotFoundException(`Dispute ${id} not found`);

    return dispute;
  }
}
