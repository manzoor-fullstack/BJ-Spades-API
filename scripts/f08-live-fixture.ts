import { PrismaPg } from '@prisma/adapter-pg';
import {
  PlayerFriendshipStatus,
  PrismaClient,
  UserSource,
  UserStatus,
} from '@prisma/client';
import bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.test', override: true });

function testDatabaseUrl(value: string | undefined) {
  if (!value) throw new Error('The F08 live fixture requires .env.test.');
  const url = new URL(value);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.port !== '5434' ||
    url.pathname !== '/bjspades_test'
  ) {
    throw new Error(
      'Refusing to modify a database outside the F08 test database.',
    );
  }
  return value;
}

const databaseUrl = testDatabaseUrl(process.env.DATABASE_URL);
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});
const emailPrefix = 'f08-live-';
const password = 'StrongPass123';
const players = [
  { id: '10800000-0000-4000-8000-000000000001', suffix: 'one' },
  { id: '10800000-0000-4000-8000-000000000002', suffix: 'two' },
  { id: '10800000-0000-4000-8000-000000000003', suffix: 'three' },
  { id: '10800000-0000-4000-8000-000000000004', suffix: 'four' },
] as const;

async function cleanup() {
  const ids = players.map((player) => player.id);
  await prisma.gameMatch.deleteMany({
    where: { seats: { some: { userId: { in: ids } } } },
  });
  await prisma.user.deleteMany({
    where: { email: { startsWith: emailPrefix } },
  });
}

async function seed() {
  await cleanup();
  const passwordHash = await bcrypt.hash(password, 10);
  for (const player of players) {
    await prisma.user.create({
      data: {
        id: player.id,
        firstName: 'Live',
        lastName: player.suffix,
        email: `${emailPrefix}${player.suffix}@example.com`,
        source: UserSource.PLAYER,
        status: UserStatus.ACTIVE,
        emailVerified: true,
        emailVerifiedAt: new Date(),
        credential: {
          create: {
            username: `f08_live_${player.suffix}`,
            passwordHash,
          },
        },
        playerProfile: {
          create: {
            displayName: `F08 Live ${player.suffix}`,
            avatarName: 'Ace of Spades',
            avatarBackground: '#6366f1',
          },
        },
      },
    });
  }
  await prisma.playerFriendship.createMany({
    data: [
      {
        playerOneId: players[0].id,
        playerTwoId: players[1].id,
        requestedById: players[0].id,
        status: PlayerFriendshipStatus.ACCEPTED,
        respondedAt: new Date(),
      },
      {
        playerOneId: players[2].id,
        playerTwoId: players[3].id,
        requestedById: players[2].id,
        status: PlayerFriendshipStatus.ACCEPTED,
        respondedAt: new Date(),
      },
    ],
  });
}

async function main() {
  const action = process.argv[2];
  if (action === 'seed') await seed();
  else if (action === 'cleanup') await cleanup();
  else throw new Error('Use: tsx scripts/f08-live-fixture.ts seed|cleanup');
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
