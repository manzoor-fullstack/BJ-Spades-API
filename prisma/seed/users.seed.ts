import { PrismaClient, UserSource, UserStatus, UserTier } from '@prisma/client';

/**
 * 50 users spanning every status, tier, and source.
 *
 * Volume matters: pagination bugs, slow queries, and broken sorting are
 * invisible with five rows and obvious with fifty. Deterministic on purpose —
 * no randomness — so a failing test reproduces exactly.
 */

const FIRST_NAMES = [
  'John', 'Sarah', 'Marcus', 'Emily', 'David', 'Lisa', 'James', 'Amanda',
  'Michael', 'Jessica', 'Robert', 'Ashley', 'William', 'Brittany', 'Daniel',
  'Samantha', 'Joseph', 'Megan', 'Thomas', 'Rachel', 'Christopher', 'Nicole',
  'Charles', 'Danielle', 'Anthony',
];

const LAST_NAMES = [
  'Mitchell', 'Chen', 'Williams', 'Rodriguez', 'Kim', 'Thompson', 'Brown',
  'Foster', 'Johnson', 'Martinez', 'Davis', 'Garcia', 'Miller', 'Wilson',
  'Moore', 'Taylor', 'Anderson', 'Thomas', 'Jackson', 'White', 'Harris',
  'Martin', 'Lee', 'Walker', 'Hall',
];

const CITIES: [string, string, string, string][] = [
  ['New York', 'NY', '10001', 'United States'],
  ['Los Angeles', 'CA', '90001', 'United States'],
  ['Chicago', 'IL', '60601', 'United States'],
  ['Houston', 'TX', '77001', 'United States'],
  ['Toronto', 'ON', 'M5H 2N2', 'Canada'],
  ['London', 'England', 'SW1A 1AA', 'United Kingdom'],
];

// Weighted so ACTIVE dominates, as it would in a real system.
const STATUS_CYCLE: UserStatus[] = [
  UserStatus.ACTIVE, UserStatus.ACTIVE, UserStatus.ACTIVE, UserStatus.ACTIVE,
  UserStatus.ACTIVE, UserStatus.ACTIVE, UserStatus.INACTIVE,
  UserStatus.PENDING, UserStatus.SUSPENDED, UserStatus.ACTIVE,
];

const TIER_CYCLE: UserTier[] = [
  UserTier.PLAYER, UserTier.PLAYER, UserTier.PLAYER, UserTier.PLAYER,
  UserTier.PREMIUM, UserTier.PLAYER, UserTier.PREMIUM, UserTier.VIP,
  UserTier.PLAYER, UserTier.PREMIUM,
];

const TOTAL = 50;

function pick<T>(list: readonly T[], index: number): T {
  // Non-null assertion is safe: the modulo keeps the index inside the array,
  // and noUncheckedIndexedAccess would otherwise widen every lookup.
  return list[index % list.length]!;
}

export async function seedUsers(prisma: PrismaClient) {
  console.log('\n🌱 Seeding Users...');

  const admin = await prisma.admin.findUnique({
    where: { email: 'admin@bjspades.com' },
    select: { id: true },
  });

  const now = Date.now();
  const counts: Record<string, number> = {};

  for (let i = 0; i < TOTAL; i++) {
    const firstName = pick(FIRST_NAMES, i);
    const lastName = pick(LAST_NAMES, i * 7);
    const status = pick(STATUS_CYCLE, i);
    const tier = pick(TIER_CYCLE, i);

    // Every third user arrived through the registration webhook.
    const source = i % 3 === 0 ? UserSource.WEBHOOK : UserSource.ADMIN;

    const [city, state, postalCode, country] = pick(CITIES, i);
    const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${i}@example.com`;

    // Spread creation dates over roughly four months so date filters and
    // month-over-month stats have something to work with.
    const createdAt = new Date(now - i * 3 * 24 * 60 * 60 * 1000);

    const balance = status === UserStatus.SUSPENDED ? 0 : (i * 137) % 25_000;

    await prisma.user.upsert({
      where: { email },
      update: {},
      create: {
        firstName,
        lastName,
        email,
        phone: `+1555${String(1_000_000 + i).slice(-7)}`,
        addressLine1: `${100 + i} Main St`,
        addressLine2: i % 4 === 0 ? `Apt ${i}` : null,
        city,
        state,
        postalCode,
        country,
        balance,
        status,
        tier,
        source,
        emailVerified: status === UserStatus.ACTIVE,
        emailVerifiedAt: status === UserStatus.ACTIVE ? createdAt : null,
        lastActiveAt: createdAt,
        createdAt,
        // Webhook users have no creating admin, by definition.
        createdByAdminId: source === UserSource.ADMIN ? (admin?.id ?? null) : null,
      },
    });

    counts[status] = (counts[status] ?? 0) + 1;
  }

  console.log(`✅ ${TOTAL} users seeded`);
  console.log(
    `   ${Object.entries(counts)
      .map(([status, count]) => `${status}: ${count}`)
      .join(', ')}`,
  );
  console.log('🎉 Users Seeded Successfully');
}
