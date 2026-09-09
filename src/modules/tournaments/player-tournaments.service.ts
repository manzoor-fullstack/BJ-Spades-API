import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { RegistrationStatus, TournamentStatus } from '@prisma/client';

import { combineStartsAt } from './start-time.util';
import { CreatePlayerTournamentDto } from './dto/create-player-tournament.dto';
import { TournamentsRepository } from './repositories/tournaments.repository';
import {
  playerTournamentDashboard,
  toPlayerTournament,
} from './serializers/player-tournament.serializer';
import { TournamentsService } from './tournaments.service';

const ACTIVE_REGISTRATIONS = new Set<RegistrationStatus>([
  RegistrationStatus.REGISTERED,
  RegistrationStatus.CHECKED_IN,
]);

const PLAYER_CANCELLABLE_STATUSES = new Set<TournamentStatus>([
  TournamentStatus.SCHEDULED,
  TournamentStatus.REGISTERING,
]);

@Injectable()
export class PlayerTournamentsService {
  constructor(
    private readonly repository: TournamentsRepository,
    private readonly tournaments: TournamentsService,
  ) {}

  async dashboard(userId: string) {
    return playerTournamentDashboard(
      await this.repository.findPlayerVisible(userId),
      userId,
    );
  }

  async findOne(userId: string, id: string) {
    const tournament = await this.repository.findPlayerVisibleById(userId, id);
    if (!tournament) throw new NotFoundException('Tournament not found.');
    return toPlayerTournament(tournament, userId);
  }

  async mine(userId: string) {
    return (await this.repository.findPlayerVisible(userId))
      .filter((tournament) => tournament.registrations.length > 0)
      .map((tournament) => toPlayerTournament(tournament, userId));
  }

  async hosted(userId: string) {
    return (await this.repository.findHostedByPlayer(userId)).map(
      (tournament) => toPlayerTournament(tournament, userId),
    );
  }

  async create(userId: string, input: CreatePlayerTournamentDto) {
    const startsAt = combineStartsAt(input.startDate, input.startTime);
    if (startsAt.getTime() <= Date.now()) {
      throw new UnprocessableEntityException(
        'A private tournament must start in the future.',
      );
    }
    const tournament = await this.repository.createPlayerHosted({
      name: input.name.trim(),
      description: input.description?.trim() || null,
      maxPlayers: input.maxPlayers,
      startsAt,
      createdByPlayerId: userId,
    });
    return toPlayerTournament(tournament, userId);
  }

  async join(userId: string, id: string) {
    const tournament = await this.repository.findPlayerVisibleById(userId, id);
    if (!tournament) throw new NotFoundException('Tournament not found.');
    if (tournament.visibility === 'PRIVATE') {
      throw new ForbiddenException(
        'Private tournaments require an invitation before registration.',
      );
    }
    if (tournament.startsAt.getTime() <= Date.now()) {
      throw new UnprocessableEntityException(
        'Tournament registration is closed.',
      );
    }
    await this.tournaments.registerPlayer(id, { userId });
    return this.findOne(userId, id);
  }

  async cancelRegistration(userId: string, id: string) {
    const tournament = await this.repository.findPlayerVisibleById(userId, id);
    if (!tournament) throw new NotFoundException('Tournament not found.');
    const registration = tournament.registrations[0];
    if (!registration || !ACTIVE_REGISTRATIONS.has(registration.status)) {
      if (registration?.status === RegistrationStatus.WITHDRAWN) {
        return toPlayerTournament(tournament, userId);
      }
      throw new ConflictException(
        'The player is not registered for this tournament.',
      );
    }
    if (
      !PLAYER_CANCELLABLE_STATUSES.has(tournament.status) ||
      tournament.startsAt.getTime() <= Date.now()
    ) {
      throw new UnprocessableEntityException(
        'Registration can no longer be cancelled.',
      );
    }
    if (tournament.createdByPlayerId === userId) {
      throw new UnprocessableEntityException(
        'The host must cancel the private tournament instead.',
      );
    }
    await this.tournaments.removePlayer(id, userId);
    return this.findOne(userId, id);
  }

  async cancelHosted(userId: string, id: string) {
    const tournament = await this.repository.findPlayerVisibleById(userId, id);
    if (!tournament || tournament.createdByPlayerId !== userId) {
      throw new NotFoundException('Hosted tournament not found.');
    }
    if (
      !PLAYER_CANCELLABLE_STATUSES.has(tournament.status) ||
      tournament.startsAt.getTime() <= Date.now()
    ) {
      throw new UnprocessableEntityException(
        'This hosted tournament can no longer be cancelled.',
      );
    }
    await this.tournaments.cancel(id, {
      reason: 'Cancelled by the tournament host.',
    });
    return this.findOne(userId, id);
  }
}
