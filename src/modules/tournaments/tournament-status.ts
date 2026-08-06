import { UnprocessableEntityException } from '@nestjs/common';
import { TournamentStatus } from '@prisma/client';

/**
 * The tournament lifecycle (docs/phases/PHASE-4.md, 4.19).
 *
 *   SCHEDULED ──▶ REGISTERING ──▶ IN_PROGRESS ──▶ COMPLETED
 *        │              │               │
 *        └──────────────┴───────────────┴──────▶ CANCELLED
 *
 * COMPLETED and CANCELLED are terminal — a finished tournament with prizes
 * recorded must not be reopened, and an announced cancellation must not be
 * quietly undone.
 *
 * Encoded as data rather than as a chain of `if`s so the table itself is what a
 * unit test asserts against, and so the 422 can name the allowed set.
 */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<TournamentStatus, readonly TournamentStatus[]>
> = {
  [TournamentStatus.SCHEDULED]: [
    TournamentStatus.REGISTERING,
    TournamentStatus.CANCELLED,
  ],
  [TournamentStatus.REGISTERING]: [
    TournamentStatus.IN_PROGRESS,
    TournamentStatus.CANCELLED,
  ],
  [TournamentStatus.IN_PROGRESS]: [
    TournamentStatus.COMPLETED,
    TournamentStatus.CANCELLED,
  ],
  [TournamentStatus.COMPLETED]: [],
  [TournamentStatus.CANCELLED]: [],
};

/** The statuses a tournament may be created in (PHASE-4.md, "Status transitions"). */
export const CREATABLE_STATUSES: readonly TournamentStatus[] = [
  TournamentStatus.SCHEDULED,
  TournamentStatus.REGISTERING,
];

export const TERMINAL_STATUSES: readonly TournamentStatus[] = [
  TournamentStatus.COMPLETED,
  TournamentStatus.CANCELLED,
];

export function isTerminalStatus(status: TournamentStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(
  from: TournamentStatus,
  to: TournamentStatus,
): boolean {
  // Re-submitting the current status is a no-op, not a transition. The edit
  // modal always posts the whole form back, including a status the admin never
  // touched; rejecting that would make every unrelated edit fail.
  if (from === to) {
    return true;
  }

  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Throws 422 naming the allowed set, which is the difference between an error a
 * client can act on and one that just says "no".
 *
 * Used by `PATCH /tournaments/:id`, where re-submitting the unchanged current
 * status must succeed. Endpoints that *are* the transition — cancel, results —
 * use `assertStatusChange` instead.
 */
export function assertTransitionAllowed(
  from: TournamentStatus,
  to: TournamentStatus,
): void {
  if (canTransition(from, to)) {
    return;
  }

  const allowed = ALLOWED_TRANSITIONS[from];

  throw new UnprocessableEntityException(
    allowed.length === 0
      ? `A ${from} tournament is final and cannot change status.`
      : `Cannot move a tournament from ${from} to ${to}. Allowed from ${from}: ${allowed.join(', ')}.`,
  );
}

/**
 * Like `assertTransitionAllowed`, but a no-op is also an error.
 *
 * `PATCH /:id/cancel` and `POST /:id/results` exist to *move* a tournament, so
 * "it is already CANCELLED" is a failure the caller needs to hear — silently
 * succeeding would overwrite the original `cancelledAt` and reason with a
 * second cancellation's.
 */
export function assertStatusChange(
  from: TournamentStatus,
  to: TournamentStatus,
): void {
  if (from === to) {
    throw new UnprocessableEntityException(`This tournament is already ${to}.`);
  }

  assertTransitionAllowed(from, to);
}
