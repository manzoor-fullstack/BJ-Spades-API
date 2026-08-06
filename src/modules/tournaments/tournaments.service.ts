import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { TournamentStatus, UserStatus } from '@prisma/client';

import {
  buildPaginationMeta,
  resolveSortField,
  SortOrder,
} from '../../common/dto/pagination.dto';
import type { PaginationQueryDto } from '../../common/dto/pagination.dto';
import type { Paginated } from '../../common/interceptors/transform.interceptor';
import { formatMoney, toMoney } from '../../common/money/money.util';
import type { AuthenticatedAdmin } from '../auth/interfaces/authenticated-admin.interface';
import type { ValidatableUpload } from '../storage/image-validation';
import { MediaService } from '../storage/media.service';
import { UsersRepository } from '../users/repositories/users.repository';

import { CancelTournamentDto } from './dto/cancel-tournament.dto';
import { CreateTournamentDto } from './dto/create-tournament.dto';
import { QueryTournamentsDto } from './dto/query-tournaments.dto';
import { RegisterPlayerDto } from './dto/register-player.dto';
import { SubmitResultsDto } from './dto/submit-results.dto';
import { UpdateTournamentDto } from './dto/update-tournament.dto';
import { TournamentsRepository } from './repositories/tournaments.repository';
import type {
  CreateTournamentData,
  ListTournamentsArgs,
  ResultRow,
  TournamentWithRelations,
  UpdateTournamentData,
} from './repositories/tournaments.repository';
import {
  toRegistrationItem,
  toTournamentDetail,
  toTournamentListItem,
} from './serializers/tournament.serializer';
import type {
  TournamentDetail,
  TournamentListItem,
  TournamentRegistrationItem,
  TournamentStats,
} from './serializers/tournament.serializer';
import { combineStartsAt } from './start-time.util';
import {
  assertStatusChange,
  assertTransitionAllowed,
} from './tournament-status';

/**
 * Columns a client may sort by. `sortBy` reaches Prisma as an object key, so an
 * unfiltered value both widens the injection surface and exposes columns that
 * were never meant to be orderable.
 */
const SORTABLE_FIELDS = [
  'createdAt',
  'updatedAt',
  'name',
  'startsAt',
  'entryFee',
  'prizePool',
  'maxPlayers',
  'status',
] as const;

const DEFAULT_SORT_FIELD = 'createdAt';

/** Storage folder for tournament banners; also the URL path segment. */
export const TOURNAMENT_IMAGE_FOLDER = 'tournaments';

/** Statuses counted by the "Active Tournaments" card (docs/03-API-CONTRACT.md). */
const ACTIVE_STATUSES: readonly TournamentStatus[] = [
  TournamentStatus.REGISTERING,
  TournamentStatus.IN_PROGRESS,
];

function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

@Injectable()
export class TournamentsService {
  constructor(
    private readonly repository: TournamentsRepository,
    private readonly usersRepository: UsersRepository,
    private readonly media: MediaService,
  ) {}

  async findAll(
    query: QueryTournamentsDto,
  ): Promise<Paginated<TournamentListItem[]>> {
    const args = this.buildListArgs(query);

    const [tournaments, total] = await Promise.all([
      this.repository.findMany(args),
      this.repository.count(args.filter),
    ]);

    return {
      data: tournaments.map(toTournamentListItem),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  async stats(): Promise<TournamentStats> {
    const [byStatus, prizePool, registeredPlayers, totalTournaments] =
      await Promise.all([
        this.repository.countByStatus(),
        this.repository.sumPrizePool(),
        this.repository.countAllRegistrations(),
        this.repository.countAll(),
      ]);

    const activeTournaments = byStatus
      .filter((group) => ACTIVE_STATUSES.includes(group.status))
      .reduce((sum, group) => sum + group.count, 0);

    return {
      activeTournaments,
      totalPrizePool: formatMoney(prizePool ?? 0),
      registeredPlayers,
      totalTournaments,
    };
  }

  async findOne(id: string): Promise<TournamentDetail> {
    return toTournamentDetail(await this.getOrThrow(id));
  }

  async create(
    dto: CreateTournamentDto,
    image: ValidatableUpload | undefined,
    admin: AuthenticatedAdmin,
  ): Promise<TournamentDetail> {
    const startsAt = combineStartsAt(dto.startDate, dto.startTime);

    const asset = image
      ? await this.media.uploadImage(image, TOURNAMENT_IMAGE_FOLDER, admin.id)
      : null;

    const data: CreateTournamentData = {
      name: dto.name.trim(),
      description: emptyToNull(dto.description),
      imageId: asset?.id ?? null,
      entryFee: toMoney(dto.entryFee ?? 0),
      prizePool: toMoney(dto.prizePool ?? 0),
      maxPlayers: dto.maxPlayers,
      startsAt,
      status: dto.status ?? TournamentStatus.SCHEDULED,
      createdByAdminId: admin.id,
    };

    try {
      return toTournamentDetail(await this.repository.create(data));
    } catch (error) {
      // The asset was written before the row that references it, so a failed
      // insert would leave a file nothing points at. The orphan sweep would
      // eventually collect it; removing it now is cheaper and immediate.
      await this.media.deleteAsset(asset?.id);
      throw error;
    }
  }

  async update(
    id: string,
    dto: UpdateTournamentDto,
    image: ValidatableUpload | undefined,
    admin: AuthenticatedAdmin,
  ): Promise<TournamentDetail> {
    const existing = await this.getOrThrow(id);

    const data: UpdateTournamentData = {};

    if (dto.name !== undefined) {
      data.name = dto.name.trim();
    }

    if (dto.description !== undefined) {
      data.description = emptyToNull(dto.description);
    }

    if (dto.entryFee !== undefined) {
      data.entryFee = toMoney(dto.entryFee);
    }

    if (dto.prizePool !== undefined) {
      data.prizePool = toMoney(dto.prizePool);
    }

    if (dto.maxPlayers !== undefined) {
      // Shrinking below the number of players already signed up would leave the
      // tournament permanently over capacity and the card reading "18/16".
      if (dto.maxPlayers < existing._count.registrations) {
        throw new UnprocessableEntityException(
          `maxPlayers cannot be lower than the ${existing._count.registrations} player(s) already registered.`,
        );
      }

      data.maxPlayers = dto.maxPlayers;
    }

    if (dto.startDate !== undefined || dto.startTime !== undefined) {
      if (dto.startDate === undefined || dto.startTime === undefined) {
        throw new UnprocessableEntityException(
          'startDate and startTime must be supplied together.',
        );
      }

      data.startsAt = combineStartsAt(dto.startDate, dto.startTime);
    }

    if (dto.status !== undefined) {
      assertTransitionAllowed(existing.status, dto.status);
      data.status = dto.status;
    }

    // Uploaded before the update so a rejected image never half-applies the
    // rest of the form.
    const asset = image
      ? await this.media.uploadImage(image, TOURNAMENT_IMAGE_FOLDER, admin.id)
      : null;

    if (asset) {
      data.imageId = asset.id;
    }

    let updated: TournamentWithRelations;

    try {
      updated = await this.repository.update(id, data);
    } catch (error) {
      await this.media.deleteAsset(asset?.id);
      throw error;
    }

    if (asset && existing.imageId) {
      // Only once the row points at the replacement: deleting first would leave
      // a broken image if the update failed.
      await this.media.deleteAsset(existing.imageId);
    }

    return toTournamentDetail(updated);
  }

  async cancel(
    id: string,
    dto: CancelTournamentDto,
  ): Promise<TournamentDetail> {
    const existing = await this.getOrThrow(id);

    assertStatusChange(existing.status, TournamentStatus.CANCELLED);

    // Phase 6: every ENTRY_FEE transaction recorded against this tournament
    // gets a matching REFUND, written in the same database transaction as the
    // status change. A cancellation that took people's money and kept it is the
    // failure this closes.
    return toTournamentDetail(
      await this.repository.cancelWithRefunds(id, {
        status: TournamentStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelReason: dto.reason.trim(),
      }),
    );
  }

  /**
   * Returns the deleted tournament even though the route answers 204 — Nest
   * discards the body but the value still reaches AuditInterceptor, which is
   * what lets the audit entry name the tournament instead of a bare UUID.
   */
  async remove(id: string): Promise<TournamentDetail> {
    const existing = await this.getOrThrow(id);

    await this.repository.delete(id);

    // After the row is gone: a file deleted first, followed by a failed delete,
    // leaves a tournament with a broken banner.
    await this.media.deleteAsset(existing.imageId);

    return toTournamentDetail(existing);
  }

  async findRegistrations(
    id: string,
    query: PaginationQueryDto,
  ): Promise<Paginated<TournamentRegistrationItem[]>> {
    await this.getOrThrow(id);

    const [registrations, total] = await Promise.all([
      this.repository.findRegistrations(id, query.skip, query.take),
      this.repository.countRegistrations(id),
    ]);

    return {
      data: registrations.map(toRegistrationItem),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  async registerPlayer(
    id: string,
    dto: RegisterPlayerDto,
  ): Promise<TournamentRegistrationItem> {
    await this.getOrThrow(id);

    const user = await this.usersRepository.findById(dto.userId);

    if (!user) {
      throw new NotFoundException(`User ${dto.userId} not found`);
    }

    if (user.deletedAt || user.status === UserStatus.DELETED) {
      throw new UnprocessableEntityException(
        'A deleted user cannot be registered for a tournament.',
      );
    }

    if (user.status === UserStatus.SUSPENDED) {
      throw new UnprocessableEntityException(
        'A suspended user cannot be registered for a tournament.',
      );
    }

    // Phase 6: the entry fee is debited inside the same transaction that
    // creates the registration, through the ledger. A player who cannot cover
    // the fee is not registered at all.
    const result = await this.repository.createRegistration(id, dto.userId);

    switch (result.outcome) {
      case 'CREATED':
        return toRegistrationItem(result.registration);

      case 'NOT_FOUND':
        throw new NotFoundException(`Tournament ${id} not found`);

      case 'INSUFFICIENT_BALANCE':
        throw new UnprocessableEntityException(
          `Insufficient balance for the ${formatMoney(result.entryFee)} entry fee: ` +
            `${formatMoney(result.balance)} available.`,
        );

      case 'NOT_REGISTERING':
        throw new UnprocessableEntityException(
          `Registration is only open while a tournament is ${TournamentStatus.REGISTERING}; this one is ${result.status}.`,
        );

      case 'FULL':
        throw new UnprocessableEntityException(
          `Tournament is full: ${result.registeredCount} of ${result.maxPlayers} places taken.`,
        );

      case 'ALREADY_REGISTERED':
        throw new ConflictException(
          'This user is already registered for the tournament.',
        );
    }
  }

  async removePlayer(
    id: string,
    userId: string,
  ): Promise<TournamentRegistrationItem> {
    const tournament = await this.getOrThrow(id);

    const registration = await this.repository.findRegistration(id, userId);

    if (!registration) {
      throw new NotFoundException(
        `User ${userId} is not registered for tournament ${id}`,
      );
    }

    if (tournament.status === TournamentStatus.COMPLETED) {
      // The registration now carries a placement and a prize. Deleting it would
      // erase a recorded result rather than withdraw a player.
      throw new UnprocessableEntityException(
        'Players cannot be removed from a completed tournament.',
      );
    }

    await this.repository.deleteRegistration(id, userId);

    return toRegistrationItem(registration);
  }

  async submitResults(
    id: string,
    dto: SubmitResultsDto,
  ): Promise<TournamentDetail> {
    const tournament = await this.getOrThrow(id);

    assertStatusChange(tournament.status, TournamentStatus.COMPLETED);

    const userIds = dto.results.map((result) => result.userId);

    if (new Set(userIds).size !== userIds.length) {
      throw new UnprocessableEntityException(
        'Each user may appear only once in the results.',
      );
    }

    const placements = dto.results.map((result) => result.placement);

    if (new Set(placements).size !== placements.length) {
      throw new UnprocessableEntityException(
        'Each placement may be awarded only once.',
      );
    }

    const registrations = await this.repository.findRegistrations(
      id,
      0,
      tournament._count.registrations,
    );
    const registeredIds = new Set(
      registrations.map((registration) => registration.userId),
    );

    const unregistered = userIds.filter((userId) => !registeredIds.has(userId));

    if (unregistered.length > 0) {
      throw new UnprocessableEntityException(
        `Results reference users who are not registered: ${unregistered.join(', ')}.`,
      );
    }

    const rows: ResultRow[] = dto.results.map((result) => ({
      userId: result.userId,
      placement: result.placement,
      prizeWon: result.prizeWon === undefined ? null : toMoney(result.prizeWon),
    }));

    // Phase 6: every positive prize also creates a PENDING `Payout` linked to
    // the registration. Balances are still untouched — submitting results
    // records what is *owed*; the money moves in `POST /payouts/:id/process`,
    // after an admin approves it and Stripe accepts the transfer.
    return toTournamentDetail(await this.repository.submitResults(id, rows));
  }

  private buildListArgs(query: QueryTournamentsDto): ListTournamentsArgs {
    return {
      filter: {
        search: query.search?.trim() ? query.search.trim() : undefined,
        status: query.status,
      },
      sortBy: resolveSortField(
        query.sortBy,
        SORTABLE_FIELDS,
        DEFAULT_SORT_FIELD,
      ),
      sortOrder: query.sortOrder === SortOrder.ASC ? 'asc' : 'desc',
      skip: query.skip,
      take: query.take,
    };
  }

  private async getOrThrow(id: string): Promise<TournamentWithRelations> {
    const tournament = await this.repository.findById(id);

    if (!tournament) {
      throw new NotFoundException(`Tournament ${id} not found`);
    }

    return tournament;
  }
}
