import {
  AnimationCategory,
  ItemStatus,
  Prisma,
  type PrismaClient,
} from '@prisma/client';

const ASSET = '/animations/crown-spade-burst.png';

const ANIMATIONS = [
  [
    'a1000000-0000-4000-8000-000000000001',
    'Crown Drop',
    'A crown-and-spade burst on victory.',
    AnimationCategory.WIN_VICTORY,
    '120.00',
    'crown-burst',
    true,
    false,
  ],
  [
    'a1000000-0000-4000-8000-000000000002',
    'Spade Slice',
    'A fast violet slice when a spade lands.',
    AnimationCategory.CARD_PLAY,
    '75.00',
    'spade-slice',
    true,
    false,
  ],
  [
    'a1000000-0000-4000-8000-000000000003',
    'Nil Shield Aura',
    'A protective pulse around a successful nil.',
    AnimationCategory.NIL,
    '80.00',
    'nil-shield',
    false,
    false,
  ],
  [
    'a1000000-0000-4000-8000-000000000004',
    'Royal Side-Eye',
    'A restrained royal reaction for the table.',
    AnimationCategory.TRASH_TALK,
    '35.00',
    'royal-glance',
    false,
    false,
  ],
  [
    'a1000000-0000-4000-8000-000000000005',
    'Respect Nod',
    'A gold pulse shared with the opposing team.',
    AnimationCategory.EMOTES,
    '30.00',
    'respect-pulse',
    false,
    false,
  ],
  [
    'a1000000-0000-4000-8000-000000000006',
    'Hot Hand Crown',
    'A brighter crown for an active win streak.',
    AnimationCategory.STREAK,
    '100.00',
    'hot-hand',
    true,
    true,
  ],
  [
    'a1000000-0000-4000-8000-000000000007',
    'Penalty Crack',
    'A short fractured-spade penalty effect.',
    AnimationCategory.PENALTY,
    '55.00',
    'penalty-crack',
    false,
    false,
  ],
] as const;

export async function seedAnimations(prisma: PrismaClient) {
  for (const [
    id,
    name,
    description,
    category,
    price,
    effectKey,
    featured,
    vipOnly,
  ] of ANIMATIONS) {
    await prisma.animation.upsert({
      where: { id },
      update: {
        name,
        description,
        category,
        price: new Prisma.Decimal(price),
        assetUrl: ASSET,
        effectKey,
        featured,
        vipOnly,
        status: ItemStatus.ACTIVE,
      },
      create: {
        id,
        name,
        description,
        category,
        price: new Prisma.Decimal(price),
        assetUrl: ASSET,
        effectKey,
        featured,
        vipOnly,
        status: ItemStatus.ACTIVE,
      },
    });
  }
}
