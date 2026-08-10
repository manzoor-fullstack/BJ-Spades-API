import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ClaimStatus } from '@prisma/client';

import { buildPaginationMeta } from '../../common/dto/pagination.dto';
import type { Paginated } from '../../common/interceptors/transform.interceptor';
import type { AuthenticatedAdmin } from '../auth/interfaces/authenticated-admin.interface';

import {
  ApproveClaimDto,
  DeclineClaimDto,
  QueryClaimsDto,
} from './dto/claim.dto';
import { ClaimsRepository } from './repositories/claims.repository';
import type { ClaimWithRelations } from './repositories/claims.repository';
import { toClaimListItem } from './serializers/claim.serializer';
import type { ClaimListItem, ClaimStats } from './serializers/claim.serializer';

@Injectable()
export class ClaimsService {
  constructor(private readonly repository: ClaimsRepository) {}

  async findAll(query: QueryClaimsDto): Promise<Paginated<ClaimListItem[]>> {
    const filter = {
      search: query.search?.trim() ? query.search.trim() : undefined,
      status: query.status,
    };

    const [claims, total] = await Promise.all([
      this.repository.findMany({ filter, skip: query.skip, take: query.take }),
      this.repository.count(filter),
    ]);

    return {
      data: claims.map(toClaimListItem),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  stats(): Promise<ClaimStats> {
    return this.repository.stats(new Date());
  }

  async findOne(id: string): Promise<ClaimListItem> {
    return toClaimListItem(await this.getOrThrow(id));
  }

  /**
   * Approves a claim.
   *
   * A claim whose terms were never accepted cannot be approved: the acceptance
   * is the player's side of the agreement, and approving without it would
   * record consent that was never given.
   */
  async approve(
    id: string,
    dto: ApproveClaimDto,
    admin: AuthenticatedAdmin,
  ): Promise<ClaimListItem> {
    const claim = await this.getOrThrow(id);

    this.assertReviewable(claim);

    if (!claim.termsAccepted) {
      throw new UnprocessableEntityException(
        'This claim cannot be approved: the player has not accepted the prize terms.',
      );
    }

    return this.decide(
      id,
      ClaimStatus.APPROVED,
      admin,
      dto.note?.trim() ?? null,
    );
  }

  async decline(
    id: string,
    dto: DeclineClaimDto,
    admin: AuthenticatedAdmin,
  ): Promise<ClaimListItem> {
    const claim = await this.getOrThrow(id);

    this.assertReviewable(claim);

    return this.decide(id, ClaimStatus.DECLINED, admin, dto.reason.trim());
  }

  private async decide(
    id: string,
    status: ClaimStatus,
    admin: AuthenticatedAdmin,
    note: string | null,
  ): Promise<ClaimListItem> {
    const count = await this.repository.decide(id, status, admin.id, note);

    if (count === 0) {
      // Somebody else decided it between the read and the write.
      throw new UnprocessableEntityException(
        'The claim was decided while you were reviewing it. Reload and retry.',
      );
    }

    return toClaimListItem(await this.getOrThrow(id));
  }

  private assertReviewable(claim: ClaimWithRelations): void {
    if (claim.status !== ClaimStatus.PENDING_REVIEW) {
      throw new UnprocessableEntityException(
        `This claim is already ${claim.status.toLowerCase()} and cannot be decided again.`,
      );
    }
  }

  private async getOrThrow(id: string): Promise<ClaimWithRelations> {
    const claim = await this.repository.findById(id);

    if (!claim) throw new NotFoundException(`Claim ${id} not found`);

    return claim;
  }
}
