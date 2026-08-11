import {
  ClaimStatus,
  DisputeRisk,
  DisputeStatus,
  Prisma,
  PrismaClient,
  SponsorStatus,
} from '@prisma/client';

/**
 * Prize claims and anti-cheat cases.
 *
 * Ids are fixed so the seed is idempotent — neither model has a natural unique
 * key, so `upsert` needs a stable one and a re-run updates rather than
 * duplicates.
 *
 * The set is chosen to exercise every branch the two tabs render, not to look
 * tidy: a claim with terms missing (which the API refuses to approve), a
 * claim already decided, an appeal, and one case at each risk level.
 */

interface ClaimSeed {
  id: string;
  placement: number;
  prizeDescription: string;
  prizeAmount: string | null;
  termsAccepted: boolean;
  shippingProvided: boolean;
  status: ClaimStatus;
  decisionNote?: string;
  /** Days before now that the claim was submitted. */
  submittedDaysAgo: number;
}

const CLAIMS: ClaimSeed[] = [
  {
    id: '77777777-7777-4777-8777-000000000001',
    placement: 2,
    prizeDescription: '$2,500',
    prizeAmount: '2500.00',
    termsAccepted: true,
    shippingProvided: false,
    status: ClaimStatus.PENDING_REVIEW,
    submittedDaysAgo: 3,
  },
  {
    id: '77777777-7777-4777-8777-000000000002',
    placement: 3,
    prizeDescription: '$1,000 + Hoodie',
    prizeAmount: '1000.00',
    termsAccepted: true,
    shippingProvided: true,
    status: ClaimStatus.PENDING_REVIEW,
    submittedDaysAgo: 2,
  },
  {
    // Terms missing: the API refuses to approve this one, and the tab disables
    // its Approve button for the same reason.
    id: '77777777-7777-4777-8777-000000000003',
    placement: 5,
    prizeDescription: '$200',
    prizeAmount: '200.00',
    termsAccepted: false,
    shippingProvided: false,
    status: ClaimStatus.PENDING_REVIEW,
    submittedDaysAgo: 5,
  },
  {
    id: '77777777-7777-4777-8777-000000000004',
    placement: 1,
    prizeDescription: '$800 + Trophy',
    prizeAmount: '800.00',
    termsAccepted: true,
    shippingProvided: false,
    status: ClaimStatus.APPROVED,
    submittedDaysAgo: 8,
  },
  {
    id: '77777777-7777-4777-8777-000000000005',
    placement: 4,
    prizeDescription: '$200',
    prizeAmount: '200.00',
    termsAccepted: false,
    shippingProvided: false,
    status: ClaimStatus.DECLINED,
    decisionNote: 'Prize terms were never accepted at submission.',
    submittedDaysAgo: 9,
  },
];

interface DisputeSeed {
  id: string;
  caseNumber: string;
  matchReference: string;
  reason: string;
  risk: DisputeRisk;
  status: DisputeStatus;
  resolutionNote?: string;
  filedDaysAgo: number;
}

const DISPUTES: DisputeSeed[] = [
  {
    id: '88888888-8888-4888-8888-000000000001',
    caseNumber: 'DSP-4471',
    matchReference: 'Match #4471',
    reason: 'Suspicious bidding pattern',
    risk: DisputeRisk.HIGH,
    status: DisputeStatus.UNDER_REVIEW,
    filedDaysAgo: 2,
  },
  {
    id: '88888888-8888-4888-8888-000000000002',
    caseNumber: 'DSP-4458',
    matchReference: 'Match #4458',
    reason: 'Account collusion flag',
    risk: DisputeRisk.MEDIUM,
    status: DisputeStatus.CLEARED,
    resolutionNote: 'Reviewed match logs; shared IP was a household, not collusion.',
    filedDaysAgo: 6,
  },
  {
    id: '88888888-8888-4888-8888-000000000003',
    caseNumber: 'DSP-4402',
    matchReference: 'Match #4402',
    reason: 'Multi-account entry',
    risk: DisputeRisk.CRITICAL,
    status: DisputeStatus.DISQUALIFIED,
    resolutionNote: 'Three accounts traced to one payment method.',
    filedDaysAgo: 10,
  },
  {
    id: '88888888-8888-4888-8888-000000000004',
    caseNumber: 'DSP-4419',
    matchReference: 'Match #4419',
    reason: 'Player-filed appeal — payout amount',
    risk: DisputeRisk.LOW,
    status: DisputeStatus.APPEAL_FILED,
    filedDaysAgo: 1,
  },
  {
    id: '88888888-8888-4888-8888-000000000005',
    caseNumber: 'DSP-4488',
    matchReference: 'Match #4488',
    reason: 'Bot detection trigger',
    risk: DisputeRisk.HIGH,
    status: DisputeStatus.UNDER_REVIEW,
    filedDaysAgo: 1,
  },
];

function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);

  return date;
}

export async function seedClaimsAndDisputes(
  prisma: PrismaClient,
): Promise<void> {
  console.log('\n🌱 Seeding Claims & Disputes...');

  const users = await prisma.user.findMany({
    where: { deletedAt: null },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: 5,
  });

  if (users.length === 0) {
    console.log('  ⏭  No users seeded yet — skipping.');
    return;
  }

  const tournament = await prisma.tournament.findFirst({
    where: { status: 'COMPLETED' },
    select: { id: true },
  });

  for (const [index, claim] of CLAIMS.entries()) {
    const user = users[index % users.length]!;
    const submittedAt = daysAgo(claim.submittedDaysAgo);

    const decided = claim.status !== ClaimStatus.PENDING_REVIEW;

    await prisma.prizeClaim.upsert({
      where: { id: claim.id },
      update: {},
      create: {
        id: claim.id,
        userId: user.id,
        tournamentId: tournament?.id ?? null,
        placement: claim.placement,
        prizeDescription: claim.prizeDescription,
        prizeAmount:
          claim.prizeAmount === null
            ? null
            : new Prisma.Decimal(claim.prizeAmount),
        termsAccepted: claim.termsAccepted,
        shippingProvided: claim.shippingProvided,
        status: claim.status,
        submittedAt,
        // A decided claim needs a review time, or the average-review-time card
        // would have nothing to average.
        reviewedAt: decided ? daysAgo(claim.submittedDaysAgo - 1) : null,
        decisionNote: claim.decisionNote ?? null,
      },
    });

    console.log(
      `  ✅ ${claim.prizeDescription} — ${claim.status}${claim.termsAccepted ? '' : ' (terms missing)'}`,
    );
  }

  for (const [index, dispute] of DISPUTES.entries()) {
    const user = users[index % users.length]!;
    const resolved =
      dispute.status === DisputeStatus.CLEARED ||
      dispute.status === DisputeStatus.DISQUALIFIED;

    await prisma.dispute.upsert({
      where: { id: dispute.id },
      update: {},
      create: {
        id: dispute.id,
        caseNumber: dispute.caseNumber,
        userId: user.id,
        tournamentId: tournament?.id ?? null,
        matchReference: dispute.matchReference,
        reason: dispute.reason,
        risk: dispute.risk,
        status: dispute.status,
        filedAt: daysAgo(dispute.filedDaysAgo),
        resolvedAt: resolved ? daysAgo(dispute.filedDaysAgo - 1) : null,
        resolutionNote: dispute.resolutionNote ?? null,
      },
    });

    console.log(
      `  ✅ ${dispute.caseNumber} — ${dispute.risk} / ${dispute.status}`,
    );
  }

  console.log(
    `\n✅ Seeded ${CLAIMS.length} claims and ${DISPUTES.length} disputes`,
  );
}

interface SponsorSeed {
  id: string;
  name: string;
  prizeDescription: string;
  value: string;
  splitType: string;
  contactEmail: string;
  status: SponsorStatus;
}

/** One sponsor per split type, so the tab shows each arrangement it supports. */
const SPONSORS: SponsorSeed[] = [
  {
    id: '99999999-9999-4999-8999-000000000001',
    name: 'RedBull Esports',
    prizeDescription: '$2,000 bonus + branded swag',
    value: '2000.00',
    splitType: '10% affiliate',
    contactEmail: 'partners@redbull.com',
    status: SponsorStatus.ACTIVE,
  },
  {
    id: '99999999-9999-4999-8999-000000000002',
    name: 'Logitech G',
    prizeDescription: 'Pro mouse + keyboard set',
    value: '350.00',
    splitType: 'Promo codes',
    contactEmail: 'esports@logitech.com',
    status: SponsorStatus.ACTIVE,
  },
  {
    id: '99999999-9999-4999-8999-000000000003',
    name: 'DraftKings',
    prizeDescription: '$500 free play credit',
    value: '500.00',
    splitType: 'Sponsored payout',
    contactEmail: 'biz@draftkings.com',
    status: SponsorStatus.PENDING,
  },
];

export async function seedSponsors(prisma: PrismaClient): Promise<void> {
  console.log('\n🌱 Seeding Sponsors...');

  for (const sponsor of SPONSORS) {
    await prisma.sponsor.upsert({
      where: { id: sponsor.id },
      update: {},
      create: {
        id: sponsor.id,
        name: sponsor.name,
        prizeDescription: sponsor.prizeDescription,
        value: new Prisma.Decimal(sponsor.value),
        splitType: sponsor.splitType,
        contactEmail: sponsor.contactEmail,
        status: sponsor.status,
      },
    });

    console.log(`  ✅ ${sponsor.name} — ${sponsor.splitType} (${sponsor.status})`);
  }

  console.log(`
✅ Seeded ${SPONSORS.length} sponsors`);
}

/**
 * Verification, treasury, tax and shipment fixtures.
 *
 * Chosen to exercise the branches each tab renders: a fully verified player, a
 * failed check, a NOT_REQUIRED check (which must NOT count against the
 * progress denominator), a player over the tax threshold with no document, and
 * a shipment to an incomplete address.
 */
export async function seedFulfilment(prisma: PrismaClient): Promise<void> {
  console.log('\n🌱 Seeding Verification, Treasury & Shipments...');

  const users = await prisma.user.findMany({
    where: { deletedAt: null },
    select: { id: true, addressLine1: true },
    orderBy: { createdAt: 'asc' },
    take: 4,
  });

  if (users.length === 0) {
    console.log('  ⏭  No users seeded yet — skipping.');
    return;
  }

  const states = [
    // Fully verified, US.
    { kyc: 'PASSED', age: 'PASSED', country: 'PASSED', tax: 'PASSED', wallet: 'PASSED', fraud: 'PASSED', iso: 'US', addr: '0x4f3a8b21' },
    // Non-US: no W9 to file, so the tax check is NOT_REQUIRED and must not
    // drag the progress badge down.
    { kyc: 'PASSED', age: 'PASSED', country: 'PASSED', tax: 'NOT_REQUIRED', wallet: 'PASSED', fraud: 'PASSED', iso: 'CA', addr: '0x91bc77ee' },
    // Action required.
    { kyc: 'PASSED', age: 'PASSED', country: 'PASSED', tax: 'FAILED', wallet: 'FAILED', fraud: 'PASSED', iso: 'US', addr: null },
    { kyc: 'PENDING', age: 'PENDING', country: 'PENDING', tax: 'PENDING', wallet: 'PENDING', fraud: 'PENDING', iso: 'US', addr: null },
  ] as const;

  for (const [index, user] of users.entries()) {
    const state = states[index % states.length]!;

    await prisma.playerVerification.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        country: state.iso,
        walletAddress: state.addr,
        kycCheck: state.kyc,
        ageCheck: state.age,
        countryCheck: state.country,
        taxCheck: state.tax,
        walletCheck: state.wallet,
        fraudCheck: state.fraud,
      },
    });
  }

  console.log(`  ✅ ${users.length} verification records`);

  await prisma.treasuryWallet.upsert({
    where: { address: '0xBJ5p4d35A1b2C3d4' },
    update: {},
    create: {
      label: 'Prize treasury',
      address: '0xBJ5p4d35A1b2C3d4',
      network: 'polygon',
      currency: 'USDC',
      balance: new Prisma.Decimal('142890.00000000'),
      balanceRecordedAt: new Date(),
    },
  });

  console.log('  ✅ Treasury wallet');

  // A player with no address on file, so the "cannot ship to an incomplete
  // address" guard has something to actually guard. Without this the e2e test
  // skips and the rule goes unproven.
  const addressless = await prisma.user.upsert({
    where: { email: 'no-address@example.com' },
    update: {},
    create: {
      firstName: 'Noah',
      lastName: 'Address',
      email: 'no-address@example.com',
      status: 'ACTIVE',
      tier: 'PLAYER',
      source: 'ADMIN',
      balance: new Prisma.Decimal(0),
    },
    select: { id: true },
  });

  const merch = await prisma.merchandise.findFirst({
    where: { deletedAt: null },
    include: { variants: { take: 1 } },
  });

  if (merch) {
    // First two go to players with addresses; the third deliberately does not.
    const recipients = [...users.slice(0, 2), addressless];

    for (const [index, user] of recipients.entries()) {
      await prisma.shipment.upsert({
        where: { id: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${index + 1}` },
        update: {},
        create: {
          id: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${index + 1}`,
          userId: user.id,
          merchandiseId: merch.id,
          variantId: merch.variants[0]?.id ?? null,
          customisation: index === 0 ? 'Engrave: champion name' : null,
          status: index === 0 ? 'IN_TRANSIT' : 'PENDING',
          carrier: index === 0 ? 'UPS' : null,
          trackingNumber: index === 0 ? '1Z999AA10123456784' : null,
          shippedAt: index === 0 ? new Date() : null,
        },
      });
    }

    console.log('  ✅ 3 shipments (one to an incomplete address)');
  }

  // Prize earnings, so the History and Tax tabs render against real rows.
  // Without these both show an empty state and their tests can only assert
  // that the cards exist — which proves nothing about the data path.
  //
  // Amounts straddle the $600 reportable threshold deliberately: one player
  // over it, one under, plus a refund so History has a negative row.
  const LEDGER_SEEDS = [
    { amount: '5000.00', type: 'PRIZE', description: 'Prize — Spring Championship' },
    { amount: '250.00', type: 'PRIZE', description: 'Prize — Weekly Showdown' },
    { amount: '800.00', type: 'PRIZE', description: 'Prize — Pro League' },
    { amount: '-150.00', type: 'REFUND', description: 'Refund — cancelled tournament' },
  ] as const;

  for (const [index, entry] of LEDGER_SEEDS.entries()) {
    const user = users[index % users.length]!;

    await prisma.transaction.upsert({
      where: { reference: `seed:ledger:${index}` },
      update: {},
      create: {
        userId: user.id,
        type: entry.type,
        status: 'COMPLETED',
        amount: new Prisma.Decimal(entry.amount),
        balanceBefore: new Prisma.Decimal('0.00'),
        balanceAfter: new Prisma.Decimal(entry.amount),
        description: entry.description,
        reference: `seed:ledger:${index}`,
      },
    });
  }

  console.log(`  ✅ ${LEDGER_SEEDS.length} prize/refund transactions`);

  console.log('\n✅ Seeded fulfilment fixtures');
}
