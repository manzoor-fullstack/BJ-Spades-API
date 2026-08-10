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
