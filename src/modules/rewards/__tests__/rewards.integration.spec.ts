import { existsSync, mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { INestApplication } from '@nestjs/common';
import { ItemStatus, Prisma, RewardCategory } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import sharp from 'sharp';
import request from 'supertest';

import { createTestApp, SEEDED_ADMIN } from '../../../../test/create-test-app';
import { testPrisma } from '../../../../test/setup';

const SUPPORT_ADMIN = {
  email: 'support.rewards@bjspades.com',
  password: 'Support123!',
};

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

interface LoginBody {
  data: { accessToken: string };
}

interface RewardRow {
  id: string;
  name: string;
  company: string;
  category: RewardCategory;
  value: string;
  description: string | null;
  terms: string | null;
  image: { id: string; url: string; width: number; height: number } | null;
  status: ItemStatus;
  stock: number | null;
  isLowStock: boolean;
  redeemedCount: number;
  deletedAt: string | null;
}

interface ItemBody {
  success: true;
  data: RewardRow;
}

interface ListBody {
  success: true;
  data: RewardRow[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

/**
 * Uploads are written to a throwaway directory rather than to `./uploads-test`,
 * so a run cannot leave files behind or pick up files an earlier run left. Set
 * before createTestApp(): both LocalDiskStorageService and the static-asset
 * middleware read UPLOAD_DIR once, at construction.
 */
const uploadDir = mkdtempSync(join(tmpdir(), 'bjs-rewards-'));
const previousUploadDir = process.env.UPLOAD_DIR;

process.env.UPLOAD_DIR = uploadDir;

let fixtureCounter = 0;

async function seedReward(
  adminId: string,
  overrides: Partial<Prisma.RewardUncheckedCreateInput> = {},
) {
  fixtureCounter += 1;

  const data: Prisma.RewardUncheckedCreateInput = {
    name: `Reward ${fixtureCounter}`,
    company: `Company ${fixtureCounter}`,
    category: RewardCategory.GENERAL,
    value: '$10',
    status: ItemStatus.ACTIVE,
    createdByAdminId: adminId,
    ...overrides,
  };

  return testPrisma.reward.create({ data });
}

/** A real PNG, so sharp has something it can actually decode. */
function pngFixture(width = 800, height = 800): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 9, g: 72, b: 54 } },
  })
    .png()
    .toBuffer();
}

describe('Rewards API (integration)', () => {
  let app: INestApplication;
  let seededAdminId: string;
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    app = await createTestApp();

    const supportRole = await testPrisma.role.findUniqueOrThrow({
      where: { name: 'SUPPORT' },
    });

    const password = await bcrypt.hash(SUPPORT_ADMIN.password, 10);

    // SUPPORT deliberately lacks rewards.manage — that split is what the 403
    // cases below assert.
    await testPrisma.admin.upsert({
      where: { email: SUPPORT_ADMIN.email },
      update: { password, roleId: supportRole.id, isActive: true },
      create: {
        firstName: 'Rewards',
        lastName: 'Support',
        email: SUPPORT_ADMIN.email,
        password,
        roleId: supportRole.id,
        isActive: true,
      },
    });

    const admin = await testPrisma.admin.findUniqueOrThrow({
      where: { email: SEEDED_ADMIN.email },
      select: { id: true },
    });

    seededAdminId = admin.id;
  });

  afterAll(async () => {
    await testPrisma.admin.deleteMany({
      where: { email: SUPPORT_ADMIN.email },
    });
    await app?.close();
    await rm(uploadDir, { recursive: true, force: true });

    if (previousUploadDir === undefined) {
      delete process.env.UPLOAD_DIR;
    } else {
      process.env.UPLOAD_DIR = previousUploadDir;
    }
  });

  /**
   * Logged in inside each test: setup.ts truncates Session before every test
   * and JwtStrategy rejects a token whose session no longer exists.
   */
  const tokenFor = async (credentials: {
    email: string;
    password: string;
  }): Promise<string> => {
    const response = await request(server())
      .post('/api/auth/login')
      .send(credentials);

    if (response.status !== 200) {
      throw new Error(
        `login expected 200, got ${response.status}: ${JSON.stringify(response.body)}`,
      );
    }

    return (response.body as LoginBody).data.accessToken;
  };

  const adminToken = () => tokenFor(SEEDED_ADMIN);
  const supportToken = () => tokenFor(SUPPORT_ADMIN);

  describe('authorisation', () => {
    it('returns 401 without a token', async () => {
      await request(server()).get('/api/rewards').expect(401);
      await request(server()).get(`/api/rewards/${UNKNOWN_ID}`).expect(401);
      await request(server()).post('/api/rewards').expect(401);
      await request(server()).patch(`/api/rewards/${UNKNOWN_ID}`).expect(401);
      await request(server()).delete(`/api/rewards/${UNKNOWN_ID}`).expect(401);
    });

    it('returns 403 for an admin without rewards.manage', async () => {
      const token = await supportToken();
      const auth = { Authorization: `Bearer ${token}` };

      await request(server()).get('/api/rewards').set(auth).expect(403);
      await request(server())
        .get(`/api/rewards/${UNKNOWN_ID}`)
        .set(auth)
        .expect(403);
      await request(server())
        .post('/api/rewards')
        .set(auth)
        .field('rewardName', 'Nope')
        .field('company', 'Nope')
        .field('value', '$1')
        .expect(403);
      await request(server())
        .patch(`/api/rewards/${UNKNOWN_ID}`)
        .set(auth)
        .expect(403);
      await request(server())
        .delete(`/api/rewards/${UNKNOWN_ID}`)
        .set(auth)
        .expect(403);
    });
  });

  describe('POST /api/rewards', () => {
    it('creates a reward from the modal field names', async () => {
      const token = await adminToken();

      const response = await request(server())
        .post('/api/rewards')
        .set('Authorization', `Bearer ${token}`)
        .field('rewardName', 'Free Coffee')
        .field('company', 'Starbucks')
        .field('category', 'food')
        .field('value', '$10 Gift Card')
        .field('description', 'A tall drink of your choice.')
        .field('termsConditions', 'One per player per month.')
        .field('status', 'coming-soon')
        .field('stock', '4')
        .expect(201);

      const body = response.body as ItemBody;

      expect(body.data).toEqual(
        expect.objectContaining({
          name: 'Free Coffee',
          company: 'Starbucks',
          // The modal submits lowercase and hyphens; the columns are enums.
          category: RewardCategory.FOOD,
          status: ItemStatus.COMING_SOON,
          terms: 'One per player per month.',
          // A display string, untouched by formatMoney — D-17.
          value: '$10 Gift Card',
          stock: 4,
          isLowStock: true,
          redeemedCount: 0,
          image: null,
          deletedAt: null,
        }),
      );
    });

    it('treats an omitted stock as unlimited', async () => {
      const token = await adminToken();

      const response = await request(server())
        .post('/api/rewards')
        .set('Authorization', `Bearer ${token}`)
        .field('rewardName', 'Gift Code')
        .field('company', 'BJ Spades')
        .field('value', '100')
        .expect(201);

      const body = response.body as ItemBody;

      expect(body.data.stock).toBeNull();
      expect(body.data.isLowStock).toBe(false);
      expect(body.data.category).toBe(RewardCategory.GENERAL);
    });

    it('writes a MediaAsset, stores WebP on disk and serves it over /uploads', async () => {
      const token = await adminToken();
      const source = await pngFixture(1600, 900);

      const response = await request(server())
        .post('/api/rewards')
        .set('Authorization', `Bearer ${token}`)
        .field('rewardName', 'With Icon')
        .field('company', 'Anker')
        .field('value', '500 tokens')
        .attach('image', source, {
          filename: '../../etc/passwd.png',
          contentType: 'image/png',
        })
        .expect(201);

      const body = response.body as ItemBody;
      expect(body.data.image).not.toBeNull();

      const asset = await testPrisma.mediaAsset.findUniqueOrThrow({
        where: { id: body.data.image!.id },
      });

      // The client-supplied traversal filename never reaches the key.
      expect(asset.key).toMatch(/^rewards\/[0-9a-f-]{36}\.webp$/);
      expect(asset.mimeType).toBe('image/webp');
      expect(asset.width).toBe(1200);
      expect(asset.uploadedByAdminId).toBe(seededAdminId);

      const onDisk = join(uploadDir, ...asset.key.split('/'));
      expect(existsSync(onDisk)).toBe(true);

      const stored = await readFile(onDisk);

      const served = await request(server())
        .get(`/uploads/${asset.key}`)
        .expect(200);

      expect(served.headers['content-type']).toContain('image/webp');
      expect(Buffer.from(served.body as Buffer)).toEqual(stored);
    });

    it('rejects an invalid category with 400', async () => {
      const token = await adminToken();

      await request(server())
        .post('/api/rewards')
        .set('Authorization', `Bearer ${token}`)
        .field('rewardName', 'Bad category')
        .field('company', 'Nobody')
        .field('value', '$1')
        .field('category', 'SNACKS')
        .expect(400);
    });

    it('rejects a negative stock with 400', async () => {
      const token = await adminToken();

      await request(server())
        .post('/api/rewards')
        .set('Authorization', `Bearer ${token}`)
        .field('rewardName', 'Bad stock')
        .field('company', 'Nobody')
        .field('value', '$1')
        .field('stock', '-3')
        .expect(400);
    });
  });

  describe('GET /api/rewards', () => {
    it('filters on category and status together', async () => {
      const token = await adminToken();

      await seedReward(seededAdminId, {
        name: 'Coffee',
        category: RewardCategory.FOOD,
        status: ItemStatus.ACTIVE,
      });
      await seedReward(seededAdminId, {
        name: 'Cold Brew',
        category: RewardCategory.FOOD,
        status: ItemStatus.INACTIVE,
      });
      await seedReward(seededAdminId, {
        name: 'Headphones',
        category: RewardCategory.TECH,
        status: ItemStatus.ACTIVE,
      });

      const response = await request(server())
        .get('/api/rewards')
        .query({ category: RewardCategory.FOOD, status: ItemStatus.ACTIVE })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as ListBody;

      expect(body.meta.total).toBe(1);
      expect(body.data.map((row) => row.name)).toEqual(['Coffee']);
    });

    it('searches on the name and the company', async () => {
      const token = await adminToken();

      await seedReward(seededAdminId, {
        name: 'Latte',
        company: 'Starbucks',
      });
      await seedReward(seededAdminId, {
        name: 'Starbucks Tumbler',
        company: 'Retail Co',
      });
      await seedReward(seededAdminId, { name: 'Cinema', company: 'AMC' });

      const response = await request(server())
        .get('/api/rewards')
        .query({ search: 'starbucks' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as ListBody;

      expect(body.meta.total).toBe(2);
      expect(body.data.map((row) => row.name).sort()).toEqual([
        'Latte',
        'Starbucks Tumbler',
      ]);
    });

    it('rejects an unknown category filter with 400', async () => {
      const token = await adminToken();

      await request(server())
        .get('/api/rewards')
        .query({ category: 'SNACKS' })
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });
  });

  describe('PATCH /api/rewards/:id', () => {
    it('replaces the icon and deletes the previous file', async () => {
      const token = await adminToken();

      const created = await request(server())
        .post('/api/rewards')
        .set('Authorization', `Bearer ${token}`)
        .field('rewardName', 'Rebrand')
        .field('company', 'Acme')
        .field('value', '$5')
        .attach('image', await pngFixture(400, 400), {
          filename: 'first.png',
          contentType: 'image/png',
        })
        .expect(201);

      const firstAssetId = (created.body as ItemBody).data.image!.id;
      const firstAsset = await testPrisma.mediaAsset.findUniqueOrThrow({
        where: { id: firstAssetId },
      });
      const firstPath = join(uploadDir, ...firstAsset.key.split('/'));

      const updated = await request(server())
        .patch(`/api/rewards/${(created.body as ItemBody).data.id}`)
        .set('Authorization', `Bearer ${token}`)
        .field('rewardName', 'Rebranded')
        .field('stock', '2')
        .attach('image', await pngFixture(500, 500), {
          filename: 'second.png',
          contentType: 'image/png',
        })
        .expect(200);

      const body = updated.body as ItemBody;

      expect(body.data.name).toBe('Rebranded');
      expect(body.data.stock).toBe(2);
      expect(body.data.isLowStock).toBe(true);
      expect(body.data.image!.id).not.toBe(firstAssetId);
      expect(existsSync(firstPath)).toBe(false);
      await expect(
        testPrisma.mediaAsset.findUnique({ where: { id: firstAssetId } }),
      ).resolves.toBeNull();
    });
  });

  describe('DELETE /api/rewards/:id', () => {
    it('soft-deletes, keeps the image, and hides the row from later reads', async () => {
      const token = await adminToken();

      const created = await request(server())
        .post('/api/rewards')
        .set('Authorization', `Bearer ${token}`)
        .field('rewardName', 'Doomed')
        .field('company', 'Acme')
        .field('value', '$5')
        .attach('image', await pngFixture(300, 300), {
          filename: 'icon.png',
          contentType: 'image/png',
        })
        .expect(201);

      const reward = (created.body as ItemBody).data;
      const asset = await testPrisma.mediaAsset.findUniqueOrThrow({
        where: { id: reward.image!.id },
      });
      const onDisk = join(uploadDir, ...asset.key.split('/'));

      await request(server())
        .delete(`/api/rewards/${reward.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      const stored = await testPrisma.reward.findUniqueOrThrow({
        where: { id: reward.id },
      });

      // The row survives so a Milestone 2 redemption can still name it.
      expect(stored.deletedAt).toBeInstanceOf(Date);
      // And the image survives with it — findOrphans counts a soft-deleted
      // reward as a reference.
      expect(existsSync(onDisk)).toBe(true);

      await request(server())
        .get(`/api/rewards/${reward.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);

      const list = await request(server())
        .get('/api/rewards')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((list.body as ListBody).meta.total).toBe(0);
    });

    it('returns the soft-deleted row only when explicitly asked', async () => {
      const token = await adminToken();

      const reward = await seedReward(seededAdminId, {
        name: 'Retired',
        deletedAt: new Date('2026-07-30T00:00:00.000Z'),
      });
      await seedReward(seededAdminId, { name: 'Live' });

      const defaulted = await request(server())
        .get('/api/rewards')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((defaulted.body as ListBody).data.map((row) => row.name)).toEqual([
        'Live',
      ]);

      const included = await request(server())
        .get('/api/rewards')
        .query({ includeDeleted: 'true' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((included.body as ListBody).meta.total).toBe(2);
      expect(
        (included.body as ListBody).data.find((row) => row.id === reward.id)
          ?.deletedAt,
      ).not.toBeNull();
    });

    it('writes a high-priority audit entry naming the reward', async () => {
      const token = await adminToken();

      const reward = await seedReward(seededAdminId, { name: 'Audited' });

      await request(server())
        .delete(`/api/rewards/${reward.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      const log = await testPrisma.activityLog.findFirstOrThrow({
        where: { action: 'reward.deleted' },
      });

      expect(log.title).toBe('Reward Audited deleted');
      expect(log.entityId).toBe(reward.id);
      expect(log.isHighPriority).toBe(true);
    });
  });

  describe('404s', () => {
    it('answers 404 for an unknown reward', async () => {
      const token = await adminToken();

      await request(server())
        .get(`/api/rewards/${UNKNOWN_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });
  });
});
