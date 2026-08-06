import type {
  RegistrationStatus,
  TournamentStatus,
  UserStatus,
  UserTier,
} from '@prisma/client';

import { formatMoney } from '../../../common/money/money.util';
import {
  initialsOf,
  joinFullName,
} from '../../../common/text/split-full-name.util';
import type {
  RegistrationWithUser,
  TournamentWithRelations,
} from '../repositories/tournaments.repository';

export interface TournamentImage {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
}

/**
 * The row rendered by the tournaments table and cards.
 *
 * `registeredCount` and `maxPlayers` travel together so the UI can print "3/16"
 * without a second request — the mock hardcoded "0/16" because the count was
 * simply not available. Money is a two-decimal string, never a float
 * (docs/03-API-CONTRACT.md).
 */
export interface TournamentListItem {
  id: string;
  name: string;
  description: string | null;
  image: TournamentImage | null;
  entryFee: string;
  prizePool: string;
  maxPlayers: number;
  registeredCount: number;
  startsAt: Date;
  status: TournamentStatus;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdAt: Date;
}

export interface TournamentDetail extends TournamentListItem {
  createdByAdminId: string;
  updatedAt: Date;
}

export interface RegistrationUserSummary {
  id: string;
  fullName: string;
  initials: string;
  email: string;
  status: UserStatus;
  tier: UserTier;
}

export interface TournamentRegistrationItem {
  id: string;
  tournamentId: string;
  userId: string;
  status: RegistrationStatus;
  placement: number | null;
  /** Two-decimal string, or null when no prize was recorded. */
  prizeWon: string | null;
  registeredAt: Date;
  user: RegistrationUserSummary;
}

export interface TournamentStats {
  activeTournaments: number;
  /** Two-decimal string. */
  totalPrizePool: string;
  registeredPlayers: number;
  totalTournaments: number;
}

export function toTournamentListItem(
  tournament: TournamentWithRelations,
): TournamentListItem {
  return {
    id: tournament.id,
    name: tournament.name,
    description: tournament.description,
    image: tournament.image
      ? {
          id: tournament.image.id,
          url: tournament.image.url,
          width: tournament.image.width,
          height: tournament.image.height,
        }
      : null,
    entryFee: formatMoney(tournament.entryFee),
    prizePool: formatMoney(tournament.prizePool),
    maxPlayers: tournament.maxPlayers,
    registeredCount: tournament._count.registrations,
    startsAt: tournament.startsAt,
    status: tournament.status,
    cancelledAt: tournament.cancelledAt,
    cancelReason: tournament.cancelReason,
    createdAt: tournament.createdAt,
  };
}

export function toTournamentDetail(
  tournament: TournamentWithRelations,
): TournamentDetail {
  return {
    ...toTournamentListItem(tournament),
    createdByAdminId: tournament.createdByAdminId,
    updatedAt: tournament.updatedAt,
  };
}

export function toRegistrationItem(
  registration: RegistrationWithUser,
): TournamentRegistrationItem {
  const { user } = registration;

  return {
    id: registration.id,
    tournamentId: registration.tournamentId,
    userId: registration.userId,
    status: registration.status,
    placement: registration.placement,
    prizeWon:
      registration.prizeWon === null
        ? null
        : formatMoney(registration.prizeWon),
    registeredAt: registration.registeredAt,
    user: {
      id: user.id,
      // Computed here, exactly as the users module does it, so the drawer and
      // the users table can never disagree about how a name is displayed.
      fullName: joinFullName(user.firstName, user.lastName),
      initials: initialsOf(user.firstName, user.lastName),
      email: user.email,
      status: user.status,
      tier: user.tier,
    },
  };
}
