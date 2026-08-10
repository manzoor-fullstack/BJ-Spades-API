import type { DisputeRisk, DisputeStatus } from '@prisma/client';

import {
  initialsOf,
  joinFullName,
} from '../../../common/text/split-full-name.util';
import type { DisputeWithRelations } from '../repositories/disputes.repository';

export interface DisputeSubject {
  id: string;
  fullName: string;
  initials: string;
  email: string;
}

/** One row of the Disputes tab. */
export interface DisputeListItem {
  id: string;
  caseNumber: string;
  user: DisputeSubject;
  tournamentName: string | null;
  matchReference: string | null;
  reason: string;
  risk: DisputeRisk;
  status: DisputeStatus;
  filedAt: Date;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  /**
   * Whether Clear/Disqualify should be offered. Computed here so the buttons
   * and the API's 422 cannot disagree.
   */
  isOpen: boolean;
}

export interface DisputeStats {
  openCases: number;
  highRisk: number;
  cleared: number;
  disqualified: number;
}

/** Cases still needing a decision. An appeal is open: somebody must answer it. */
export const OPEN_DISPUTE_STATUSES: readonly DisputeStatus[] = [
  'UNDER_REVIEW',
  'APPEAL_FILED',
];

export function toDisputeListItem(
  dispute: DisputeWithRelations,
): DisputeListItem {
  return {
    id: dispute.id,
    caseNumber: dispute.caseNumber,
    user: {
      id: dispute.user.id,
      fullName: joinFullName(dispute.user.firstName, dispute.user.lastName),
      initials: initialsOf(dispute.user.firstName, dispute.user.lastName),
      email: dispute.user.email,
    },
    tournamentName: dispute.tournament?.name ?? null,
    matchReference: dispute.matchReference,
    reason: dispute.reason,
    risk: dispute.risk,
    status: dispute.status,
    filedAt: dispute.filedAt,
    resolvedAt: dispute.resolvedAt,
    resolutionNote: dispute.resolutionNote,
    isOpen: OPEN_DISPUTE_STATUSES.includes(dispute.status),
  };
}
