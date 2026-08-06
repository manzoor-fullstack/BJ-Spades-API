import {
  Prisma,
  PrismaClient,
  RegistrationStatus,
  TournamentStatus,
} from '@prisma/client';

/**
 * Five tournaments, one per status, some with registrations.
 *
 * Ids are fixed rather than generated so the seed is idempotent: `Tournament`
 * has no natural unique key, so `upsert` needs a stable one. Re-running the
 * seed updates these rows instead of adding five more every time.
 *
 * Start times are written as explicit `Z` instants for the same reason the API
 * combines `startDate` + `startTime` in UTC — a bare `2026-06-01T20:00` would be
 * read as whatever timezone the seeding machine happens to be in.
 */

interface TournamentSeed {
  id: string;
  name: string;
  description: string;
  entryFee: string;
  prizePool: string;
  maxPlayers: number;
  startsAt: string;
  status: TournamentStatus;
  cancelledAt?: string;
  cancelReason?: string;
  /** How many of the seeded users to sign up, taken in a stable order. */
  registrations: number;
  /** Placements for the completed bracket, applied to the first N players. */
  placements?: { placement: number; prizeWon: string }[];
}

const TOURNAMENTS: TournamentSeed[] = [
  {
    id: '11111111-1111-4111-8111-000000000001',
    name: 'Summer Kickoff Classic',
    description: 'Opening event of the summer circuit.',
    entryFee: '25.00',
    prizePool: '2000.00',
    maxPlayers: 32,
    startsAt: '2026-06-01T20:00:00.000Z',
    status: TournamentStatus.SCHEDULED,
    registrations: 0,
  },
  {
    id: '11111111-1111-4111-8111-000000000002',
    name: 'Friday Night Spades',
    description: 'Weekly open bracket. Registration closes at start time.',
    entryFee: '10.00',
    prizePool: '500.00',
    maxPlayers: 16,
    startsAt: '2026-06-05T23:00:00.000Z',
    status: TournamentStatus.REGISTERING,
    registrations: 6,
  },
  {
    id: '11111111-1111-4111-8111-000000000003',
    name: 'Midweek Masters',
    description: 'Invitational bracket, currently in play.',
    entryFee: '50.00',
    prizePool: '5000.00',
    maxPlayers: 8,
    startsAt: '2026-05-20T18:30:00.000Z',
    status: TournamentStatus.IN_PROGRESS,
    registrations: 8,
  },
  {
    id: '11111111-1111-4111-8111-000000000004',
    name: 'Spring Championship',
    description: 'Season finale. Results final.',
    entryFee: '100.00',
    prizePool: '10000.00',
    maxPlayers: 16,
    startsAt: '2026-04-11T19:00:00.000Z',
    status: TournamentStatus.COMPLETED,
    registrations: 12,
    // Prize amounts only. No Transaction or Payout rows exist until Phase 6,
    // which backfills them.
    placements: [
      { placement: 1, prizeWon: '5000.00' },
      { placement: 2, prizeWon: '3000.00' },
      { placement: 3, prizeWon: '2000.00' },
    ],
  },
  {
    id: '11111111-1111-4111-8111-000000000005',
    name: 'Charity Invitational',
    description: 'Cancelled ahead of the rescheduled date.',
    entryFee: '20.00',
    prizePool: '1500.00',
    maxPlayers: 24,
    startsAt: '2026-05-02T17:00:00.000Z',
    status: TournamentStatus.CANCELLED,
    cancelledAt: '2026-04-25T09:00:00.000Z',
    cancelReason: 'Venue withdrew; rescheduling for the autumn circuit.',
    registrations: 4,
  },
];

export async function seedTournaments(prisma: PrismaClient) {
  console.log('\n🌱 Seeding Tournaments...');

  const admin = await prisma.admin.findUnique({
    where: { email: 'admin@bjspades.com' },
    select: { id: true },
  });

  if (!admin) {
    console.log('  ⚠️  Super admin not found — skipping tournaments.');
    return;
  }

  // Only users who could actually take part. Ordering by email keeps the same
  // people in the same brackets across re-seeds.
  const users = await prisma.user.findMany({
    where: { deletedAt: null, status: { in: ['ACTIVE', 'INACTIVE'] } },
    orderBy: { email: 'asc' },
    select: { id: true },
  });

  for (const seed of TOURNAMENTS) {
    const data = {
      name: seed.name,
      description: seed.description,
      entryFee: new Prisma.Decimal(seed.entryFee),
      prizePool: new Prisma.Decimal(seed.prizePool),
      maxPlayers: seed.maxPlayers,
      startsAt: new Date(seed.startsAt),
      status: seed.status,
      cancelledAt: seed.cancelledAt ? new Date(seed.cancelledAt) : null,
      cancelReason: seed.cancelReason ?? null,
      createdByAdminId: admin.id,
    };

    await prisma.tournament.upsert({
      where: { id: seed.id },
      update: data,
      create: { id: seed.id, ...data },
    });

    const participants = users.slice(
      0,
      Math.min(seed.registrations, seed.maxPlayers),
    );

    for (const [index, user] of participants.entries()) {
      const placement = seed.placements?.[index];

      await prisma.tournamentRegistration.upsert({
        where: {
          tournamentId_userId: { tournamentId: seed.id, userId: user.id },
        },
        update: {
          placement: placement?.placement ?? null,
          prizeWon: placement ? new Prisma.Decimal(placement.prizeWon) : null,
        },
        create: {
          tournamentId: seed.id,
          userId: user.id,
          status: RegistrationStatus.REGISTERED,
          placement: placement?.placement ?? null,
          prizeWon: placement ? new Prisma.Decimal(placement.prizeWon) : null,
        },
      });
    }

    console.log(
      `  ✅ ${seed.name} (${seed.status}) — ${participants.length}/${seed.maxPlayers}`,
    );
  }

  console.log(`\n✅ Seeded ${TOURNAMENTS.length} tournaments`);
}
