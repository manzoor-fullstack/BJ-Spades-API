import { UnprocessableEntityException } from '@nestjs/common';

/**
 * Combines the modal's separate date and time fields into one instant.
 *
 * **Both are interpreted as UTC, always.** The create modal posts
 * `startDate=2026-05-30` and `startTime=20:00` with no zone attached, and the
 * settings page's timezone field is not wired up until Phase 7. The dangerous
 * alternative is `new Date('2026-05-30T20:00')`, which JavaScript reads as
 * *server-local* time — a deployment in a different region would then shift
 * every start time by hours, silently, with no error anywhere. `Date.UTC`
 * makes the interpretation explicit and identical on every machine.
 *
 * The UI labels these fields UTC to match. See docs/phases/PHASE-4.md,
 * "Date and time combination".
 */
export function combineStartsAt(startDate: string, startTime: string): Date {
  const [year, month, day] = startDate.split('-').map(Number);
  const [hour, minute] = startTime.split(':').map(Number);

  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    [year, month, day, hour, minute].some(Number.isNaN)
  ) {
    throw new UnprocessableEntityException(
      `${startDate} ${startTime} is not a valid date and time.`,
    );
  }

  const startsAt = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));

  // `Date.UTC` rolls over rather than rejecting: 2026-02-31 silently becomes
  // 2026-03-03, and `new Date('2026-02-31T20:00:00Z')` does the same. Both
  // formats are well-formed enough to pass the DTO's regex, so the only way to
  // catch an impossible date is to read the components back.
  if (
    startsAt.getUTCFullYear() !== year ||
    startsAt.getUTCMonth() !== month - 1 ||
    startsAt.getUTCDate() !== day
  ) {
    throw new UnprocessableEntityException(
      `${startDate} is not a real calendar date.`,
    );
  }

  return startsAt;
}
