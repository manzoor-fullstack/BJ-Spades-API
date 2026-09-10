import { PrismaPg } from '@prisma/adapter-pg';
import {
  PayoutMethod,
  PayoutStatus,
  Prisma,
  PrismaClient,
  RegistrationStatus,
  TournamentStatus,
} from '@prisma/client';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.test', override: true });

const TOURNAMENT_ID = 'e6000000-0000-4000-8000-000000000001';
const REGISTRATION_ID = 'e6000000-0000-4000-8000-000000000002';
const PAYOUT_ID = 'e6000000-0000-4000-8000-000000000003';
const TOURNAMENT_NAME = 'E2E Payout Fixture';

function testDatabaseUrl(value: string | undefined): string {
  if (!value) throw new Error('The admin payout fixture requires .env.test.');
  const url = new URL(value);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.port !== '5434' ||
    url.pathname !== '/bjspades_test'
  ) {
    throw new Error(
      'Refusing to modify a database outside the isolated admin E2E database.',
    );
  }
  return value;
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: testDatabaseUrl(process.env.DATABASE_URL),
  }),
});

async function cleanup(): Promise<void> {
  await prisma.tournamentRegistration.deleteMany({
    where: { tournamentId: TOURNAMENT_ID },
  });
  await prisma.payout.deleteMany({ where: { id: PAYOUT_ID } });
  await prisma.tournament.deleteMany({ where: { id: TOURNAMENT_ID } });
}

async function seed(): Promise<void> {
  await cleanup();
  const player = await prisma.user.findFirst({
    where: {
      status: 'ACTIVE',
      emailVerified: true,
      deletedAt: null,
    },
    orderBy: { createdAt: 'asc' },
  });
  if (!player)
    throw new Error('The test database has no eligible payout user.');

  await prisma.$transaction(async (tx) => {
    await tx.tournament.create({
      data: {
        id: TOURNAMENT_ID,
        name: TOURNAMENT_NAME,
        maxPlayers: 4,
        startsAt: new Date('2099-05-30T20:00:00.000Z'),
        prizePool: new Prisma.Decimal('100.00'),
        status: TournamentStatus.COMPLETED,
        settledAt: new Date(),
        createdByPlayerId: player.id,
      },
    });
    await tx.tournamentRegistration.create({
      data: {
        id: REGISTRATION_ID,
        tournamentId: TOURNAMENT_ID,
        userId: player.id,
        status: RegistrationStatus.REGISTERED,
        placement: 1,
        prizeWon: new Prisma.Decimal('100.00'),
      },
    });
    await tx.payout.create({
      data: {
        id: PAYOUT_ID,
        userId: player.id,
        amount: new Prisma.Decimal('100.00'),
        method: PayoutMethod.STRIPE_CONNECT,
        status: PayoutStatus.PENDING,
        tournamentId: TOURNAMENT_ID,
        placement: 1,
        tournamentResultKey: `admin-e2e:${TOURNAMENT_ID}:${player.id}`,
      },
    });
    await tx.tournamentRegistration.update({
      where: { id: REGISTRATION_ID },
      data: { payoutId: PAYOUT_ID },
    });
  });

  console.log(
    JSON.stringify({
      tournamentId: TOURNAMENT_ID,
      tournamentName: TOURNAMENT_NAME,
      payoutId: PAYOUT_ID,
      playerName: `${player.firstName} ${player.lastName}`.trim(),
      playerEmail: player.email,
      amount: '100.00',
    }),
  );
}

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action === 'seed') await seed();
  else if (action === 'cleanup') await cleanup();
  else {
    throw new Error(
      'Use: tsx scripts/admin-payout-e2e-fixture.ts seed|cleanup',
    );
  }
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
