import {
  ItemStatus,
  LessonDifficulty,
  Prisma,
  UserTier,
  type PrismaClient,
} from '@prisma/client';

const lessons = [
  {
    id: 'b1000000-0000-4000-8000-000000000001',
    slug: 'spades-basics',
    title: 'Spades Basics',
    description: 'Learn partnership seating, bidding, trick play and scoring.',
    durationMinutes: 15,
    difficulty: LessonDifficulty.BEGINNER,
    moduleCount: 4,
    requiredTier: UserTier.PLAYER,
    content: [
      {
        title: 'The table',
        body: 'Four players sit as two partnerships. Partners face each other and combine their tricks toward one team bid.',
      },
      {
        title: 'The deal',
        body: 'Each player receives 13 cards. Rank runs from two through ace, and spades are always trump.',
      },
      {
        title: 'Bidding',
        body: 'Each player predicts how many tricks they will take. Team bids are added before play begins.',
      },
      {
        title: 'Play and score',
        body: 'Follow the led suit when possible. A spade wins against a non-spade; the highest card of the winning suit takes the trick.',
      },
    ],
  },
  {
    id: 'b1000000-0000-4000-8000-000000000002',
    slug: 'bidding-strategies',
    title: 'Bidding Strategies',
    description:
      'Build accurate bids from winners, trump length and partner context.',
    durationMinutes: 25,
    difficulty: LessonDifficulty.INTERMEDIATE,
    moduleCount: 3,
    requiredTier: UserTier.PLAYER,
    content: [
      {
        title: 'Count sure tricks',
        body: 'Begin with aces and protected high cards before estimating ruffs.',
      },
      {
        title: 'Value spade length',
        body: 'Long trump holdings create control after side suits are exhausted.',
      },
      {
        title: 'Leave partnership room',
        body: 'Bid the hand you hold; do not assume your partner can cover an optimistic estimate.',
      },
    ],
  },
  {
    id: 'b1000000-0000-4000-8000-000000000003',
    slug: 'nil-and-blind-nil',
    title: 'Nil & Blind Nil',
    description: 'Advanced risk management for zero-trick contracts.',
    durationMinutes: 30,
    difficulty: LessonDifficulty.ADVANCED,
    moduleCount: 3,
    requiredTier: UserTier.PREMIUM,
    content: [
      {
        title: 'Read the danger cards',
        body: 'Unsupported middle cards and short suits decide whether a nil can survive.',
      },
      {
        title: 'Cover your partner',
        body: 'Keep flexible high cards so you can overtake a partner who is forced upward.',
      },
      {
        title: 'Know the score',
        body: 'Choose nil only when the bonus is worth the board position and failure risk.',
      },
    ],
  },
] as const;

export async function seedLessons(prisma: PrismaClient) {
  for (const lesson of lessons) {
    const data = {
      slug: lesson.slug,
      title: lesson.title,
      description: lesson.description,
      durationMinutes: lesson.durationMinutes,
      difficulty: lesson.difficulty,
      moduleCount: lesson.moduleCount,
      mediaUrl: '/lessons/spades-basics.png',
      content: lesson.content as unknown as Prisma.InputJsonValue,
      contentVersion: 1,
      requiredTier: lesson.requiredTier,
      status: ItemStatus.ACTIVE,
    };
    await prisma.lesson.upsert({
      where: { id: lesson.id },
      update: data,
      create: { id: lesson.id, ...data },
    });
  }
}
