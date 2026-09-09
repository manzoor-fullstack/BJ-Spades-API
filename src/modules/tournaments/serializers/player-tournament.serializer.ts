import { Prisma, RegistrationStatus, TournamentStatus } from '@prisma/client';

import { formatMoney } from '../../../common/money/money.util';
import type { PlayerTournamentWithState } from '../repositories/tournaments.repository';

const ACTIVE_REGISTRATIONS = new Set<RegistrationStatus>([
  RegistrationStatus.REGISTERED,
  RegistrationStatus.CHECKED_IN,
]);

const OPEN_STATUSES = new Set<TournamentStatus>([
  TournamentStatus.SCHEDULED,
  TournamentStatus.REGISTERING,
]);

const PAST_STATUSES = new Set<TournamentStatus>([
  TournamentStatus.COMPLETED,
  TournamentStatus.CANCELLED,
]);

export function toPlayerTournament(
  tournament: PlayerTournamentWithState,
  userId: string,
  now = new Date(),
) {
  const registration = tournament.registrations[0] ?? null;
  const isRegistered = Boolean(
    registration && ACTIVE_REGISTRATIONS.has(registration.status),
  );
  const isHostedByMe = tournament.createdByPlayerId === userId;
  const isFuture = tournament.startsAt.getTime() > now.getTime();
  const isOpen = OPEN_STATUSES.has(tournament.status) && isFuture;

  return {
    id: tournament.id,
    name: tournament.name,
    description: tournament.description,
    imageUrl: tournament.image?.url ?? null,
    entryFee: formatMoney(tournament.entryFee),
    prizePool: formatMoney(tournament.prizePool),
    maxPlayers: tournament.maxPlayers,
    registeredCount: tournament._count.registrations,
    startsAt: tournament.startsAt,
    status: tournament.status,
    visibility: tournament.visibility,
    isFeatured: tournament.isFeatured,
    featuredSubtitle: tournament.featuredSubtitle,
    xpMultiplier: formatMoney(tournament.xpMultiplier),
    featuredRewards: tournament.featuredRewards,
    registrationStatus: registration?.status ?? null,
    isRegistered,
    isHostedByMe,
    canJoin:
      tournament.visibility === 'PUBLIC' &&
      tournament.status === TournamentStatus.REGISTERING &&
      isFuture &&
      !isRegistered &&
      tournament._count.registrations < tournament.maxPlayers,
    canCancelRegistration: isRegistered && isOpen && !isHostedByMe,
    canCancelTournament: isHostedByMe && isOpen,
    activeMatchId: tournament.gameMatches[0]?.id ?? null,
    canEnterMatch: tournament.gameMatches.length > 0,
    placement: registration?.placement ?? null,
    prizeWon:
      registration?.prizeWon === null || registration?.prizeWon === undefined
        ? null
        : formatMoney(registration.prizeWon),
    cancelledAt: tournament.cancelledAt,
    cancelReason: tournament.cancelReason,
  };
}

export function playerTournamentDashboard(
  tournaments: PlayerTournamentWithState[],
  userId: string,
  now = new Date(),
) {
  const items = tournaments.map((item) =>
    toPlayerTournament(item, userId, now),
  );
  const featured =
    items.find(
      (item) =>
        item.isFeatured &&
        item.visibility === 'PUBLIC' &&
        OPEN_STATUSES.has(item.status) &&
        new Date(item.startsAt).getTime() > now.getTime(),
    ) ?? null;
  const upcoming = items.filter(
    (item) =>
      item.id !== featured?.id &&
      item.visibility === 'PUBLIC' &&
      OPEN_STATUSES.has(item.status) &&
      new Date(item.startsAt).getTime() > now.getTime(),
  );
  const scheduled = items.filter(
    (item) =>
      ((OPEN_STATUSES.has(item.status) &&
        new Date(item.startsAt).getTime() > now.getTime()) ||
        item.status === TournamentStatus.IN_PROGRESS) &&
      (item.isRegistered || item.isHostedByMe),
  );
  const past = items.filter(
    (item) =>
      Boolean(item.registrationStatus) && PAST_STATUSES.has(item.status),
  );
  const totalWinnings = past.reduce(
    (sum, item) => (item.prizeWon ? sum.plus(item.prizeWon) : sum),
    new Prisma.Decimal(0),
  );

  return {
    featured,
    upcoming,
    scheduled,
    past,
    stats: {
      tournamentsPlayed: past.filter(
        (item) => item.status === TournamentStatus.COMPLETED,
      ).length,
      totalWinnings: formatMoney(totalWinnings),
      upcoming: upcoming.length + (featured ? 1 : 0),
      scheduled: scheduled.length,
    },
  };
}
