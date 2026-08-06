import {
  ItemStatus,
  Prisma,
  PrismaClient,
  RewardCategory,
} from '@prisma/client';

/**
 * Rewards across every category, plus three products with variants.
 *
 * Ids are fixed rather than generated so the seed is idempotent: neither model
 * has a natural unique key, so `upsert` needs a stable one. Re-running the seed
 * updates these rows instead of adding a fresh set every time.
 *
 * `value` is a display STRING and mixes "$20" with "500 tokens" on purpose —
 * that is exactly the data D-17 records as accepted debt
 * (docs/05-DEFERRED-SCOPE.md). Seeding it uniformly would hide the problem the
 * deferral exists to describe.
 *
 * SKUs follow the same `MERCH-{id prefix}-{SIZE}-{COLOR}` shape the API
 * generates, so seeded and created products look alike in an export.
 */

interface RewardSeed {
  id: string;
  name: string;
  company: string;
  category: RewardCategory;
  value: string;
  description: string;
  terms: string;
  status: ItemStatus;
  /** null means unlimited — correct for a digital gift-card code. */
  stock: number | null;
}

interface VariantSeed {
  id: string;
  size: string | null;
  color: string | null;
  sku: string;
  stock: number;
}

interface MerchandiseSeed {
  id: string;
  name: string;
  description: string;
  price: string;
  status: ItemStatus;
  variants: VariantSeed[];
}

const REWARDS: RewardSeed[] = [
  {
    id: '33333333-3333-4333-8333-000000000001',
    name: 'Free Coffee',
    company: 'Starbucks',
    category: RewardCategory.FOOD,
    value: '$10 Gift Card',
    description: 'A tall drink of your choice at any participating store.',
    terms: 'One redemption per player per calendar month. No cash value.',
    status: ItemStatus.ACTIVE,
    stock: null,
  },
  {
    id: '33333333-3333-4333-8333-000000000002',
    name: 'Cinema Ticket',
    company: 'AMC Theatres',
    category: RewardCategory.ENTERTAINMENT,
    value: '$20',
    description: 'One standard admission, any showing, any day.',
    terms: 'Excludes IMAX and premium formats. Expires 12 months after issue.',
    status: ItemStatus.ACTIVE,
    // Deliberately at the low-stock threshold, so the indicator has something
    // to show without anyone editing data by hand.
    stock: 5,
  },
  {
    id: '33333333-3333-4333-8333-000000000003',
    name: 'Wireless Earbuds',
    company: 'Anker',
    category: RewardCategory.TECH,
    value: '500 tokens',
    description: 'Soundcore Life P3 earbuds, shipped within 14 days.',
    terms: 'US shipping addresses only. Colour subject to availability.',
    status: ItemStatus.ACTIVE,
    stock: 12,
  },
  {
    id: '33333333-3333-4333-8333-000000000004',
    name: '$50 Store Credit',
    company: 'Amazon',
    category: RewardCategory.SHOPPING,
    value: '$50',
    description: 'Digital gift code delivered to the account email.',
    terms: 'Non-refundable. Subject to the issuer terms.',
    status: ItemStatus.INACTIVE,
    stock: 0,
  },
  {
    id: '33333333-3333-4333-8333-000000000005',
    name: 'Weekend Getaway',
    company: 'Marriott Bonvoy',
    category: RewardCategory.TRAVEL,
    value: '25000 points',
    description: 'Two nights at a participating property.',
    terms: 'Blackout dates apply. Booking required 30 days in advance.',
    status: ItemStatus.COMING_SOON,
    stock: null,
  },
  {
    id: '33333333-3333-4333-8333-000000000006',
    name: 'Table Stakes Bonus',
    company: 'BJ Spades',
    category: RewardCategory.GENERAL,
    value: '100',
    description: 'An in-app token top-up for the next tournament entry.',
    terms: 'Credited within 24 hours of redemption.',
    status: ItemStatus.ACTIVE,
    stock: 250,
  },
];

const MERCHANDISE: MerchandiseSeed[] = [
  {
    id: '44444444-4444-4444-8444-000000000001',
    name: 'Team Jersey',
    description: 'Breathable knit jersey with the club crest.',
    price: '39.95',
    status: ItemStatus.ACTIVE,
    variants: [
      {
        id: '55555555-5555-4555-8555-000000000001',
        size: 'M',
        color: 'Black',
        sku: 'MERCH-4444-M-BLACK',
        stock: 24,
      },
      {
        id: '55555555-5555-4555-8555-000000000002',
        size: 'L',
        color: 'Black',
        sku: 'MERCH-4444-L-BLACK',
        stock: 3,
      },
      {
        id: '55555555-5555-4555-8555-000000000003',
        size: 'L',
        color: 'White',
        sku: 'MERCH-4444-L-WHITE',
        stock: 0,
      },
    ],
  },
  {
    id: '44444444-4444-4444-8444-000000000002',
    name: 'Snapback Cap',
    description: 'One-size adjustable cap, embroidered logo.',
    price: '24.00',
    status: ItemStatus.ACTIVE,
    variants: [
      {
        id: '55555555-5555-4555-8555-000000000004',
        size: null,
        color: 'Navy',
        sku: 'MERCH-4444-NAVY',
        stock: 40,
      },
      {
        id: '55555555-5555-4555-8555-000000000005',
        size: null,
        color: 'Red',
        sku: 'MERCH-4444-RED',
        stock: 2,
      },
    ],
  },
  {
    id: '44444444-4444-4444-8444-000000000003',
    name: 'Limited Edition Card Deck',
    description: 'Foil-stamped deck, numbered run of 500.',
    price: '15.50',
    status: ItemStatus.COMING_SOON,
    variants: [
      {
        id: '55555555-5555-4555-8555-000000000006',
        size: null,
        color: null,
        sku: 'MERCH-4444-DECK',
        stock: 0,
      },
    ],
  },
];

export async function seedRewards(prisma: PrismaClient) {
  console.log('\n🌱 Seeding Rewards & Merchandise...');

  const admin = await prisma.admin.findUnique({
    where: { email: 'admin@bjspades.com' },
    select: { id: true },
  });

  if (!admin) {
    console.log('  ⚠️  Super admin not found — skipping rewards.');
    return;
  }

  for (const seed of REWARDS) {
    const data = {
      name: seed.name,
      company: seed.company,
      category: seed.category,
      value: seed.value,
      description: seed.description,
      terms: seed.terms,
      status: seed.status,
      stock: seed.stock,
      deletedAt: null,
      createdByAdminId: admin.id,
    };

    await prisma.reward.upsert({
      where: { id: seed.id },
      update: data,
      create: { id: seed.id, ...data },
    });

    console.log(
      `  ✅ ${seed.name} (${seed.category}) — ${seed.stock === null ? 'unlimited' : `${seed.stock} in stock`}`,
    );
  }

  for (const seed of MERCHANDISE) {
    const data = {
      name: seed.name,
      description: seed.description,
      price: new Prisma.Decimal(seed.price),
      status: seed.status,
      deletedAt: null,
      createdByAdminId: admin.id,
    };

    await prisma.merchandise.upsert({
      where: { id: seed.id },
      update: data,
      create: { id: seed.id, ...data },
    });

    for (const variant of seed.variants) {
      const variantData = {
        merchandiseId: seed.id,
        size: variant.size,
        color: variant.color,
        sku: variant.sku,
        stock: variant.stock,
      };

      await prisma.merchandiseVariant.upsert({
        where: { id: variant.id },
        update: variantData,
        create: { id: variant.id, ...variantData },
      });
    }

    const totalStock = seed.variants.reduce(
      (sum, variant) => sum + variant.stock,
      0,
    );

    console.log(
      `  ✅ ${seed.name} — ${seed.variants.length} variant(s), ${totalStock} in stock`,
    );
  }

  console.log(
    `\n✅ Seeded ${REWARDS.length} rewards and ${MERCHANDISE.length} products`,
  );
}
