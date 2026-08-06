import { mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { INestApplication } from '@nestjs/common';
import { ItemStatus, Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import sharp from 'sharp';
import request from 'supertest';

import { createTestApp, SEEDED_ADMIN } from '../../../../test/create-test-app';
import { testPrisma } from '../../../../test/setup';

const SUPPORT_ADMIN = {
  email: 'support.merchandise@bjspades.com',
  password: 'Support123!',
};

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

interface LoginBody {
  data: { accessToken: string };
}

interface VariantRow {
  id: string;
  merchandiseId: string;
  size: string | null;
  color: string | null;
  sku: string | null;
  stock: number;
  isLowStock: boolean;
}

interface MerchandiseRow {
  id: string;
  name: string;
  description: string | null;
  price: string;
  image: { id: string; url: string; width: number; height: number } | null;
  status: ItemStatus;
  variantCount: number;
  totalStock: number;
  isLowStock: boolean;
  variants: VariantRow[];
  deletedAt: string | null;
}

interface ItemBody {
  success: true;
  data: MerchandiseRow;
}

interface VariantBody {
  success: true;
  data: VariantRow;
}

interface ListBody {
  success: true;
  data: MerchandiseRow[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

/** See the tournaments spec: UPLOAD_DIR is read once, at construction. */
const uploadDir = mkdtempSync(join(tmpdir(), 'bjs-merch-'));
const previousUploadDir = process.env.UPLOAD_DIR;

process.env.UPLOAD_DIR = uploadDir;

let fixtureCounter = 0;

async function seedMerchandise(
  adminId: string,
  overrides: Partial<Prisma.MerchandiseUncheckedCreateInput> = {},
) {
  fixtureCounter += 1;

  const data: Prisma.MerchandiseUncheckedCreateInput = {
    name: `Product ${fixtureCounter}`,
    price: new Prisma.Decimal('19.99'),
    status: ItemStatus.ACTIVE,
    createdByAdminId: adminId,
    ...overrides,
  };

  return testPrisma.merchandise.create({ data });
}

function pngFixture(width = 800, height = 800): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 30, b: 30 } },
  })
    .png()
    .toBuffer();
}

describe('Merchandise API (integration)', () => {
  let app: INestApplication;
  let seededAdminId: string;
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    app = await createTestApp();

    const supportRole = await testPrisma.role.findUniqueOrThrow({
      where: { name: 'SUPPORT' },
    });

    const password = await bcrypt.hash(SUPPORT_ADMIN.password, 10);

    // SUPPORT deliberately lacks rewards.manage, which guards both modules.
    await testPrisma.admin.upsert({
      where: { email: SUPPORT_ADMIN.email },
      update: { password, roleId: supportRole.id, isActive: true },
      create: {
        firstName: 'Merch',
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
      await request(server()).get('/api/merchandise').expect(401);
      await request(server()).post('/api/merchandise').expect(401);
      await request(server())
        .post(`/api/merchandise/${UNKNOWN_ID}/variants`)
        .expect(401);
    });

    it('returns 403 for an admin without rewards.manage', async () => {
      const token = await supportToken();
      const auth = { Authorization: `Bearer ${token}` };

      await request(server()).get('/api/merchandise').set(auth).expect(403);
      await request(server())
        .get(`/api/merchandise/${UNKNOWN_ID}`)
        .set(auth)
        .expect(403);
      await request(server())
        .post('/api/merchandise')
        .set(auth)
        .field('productName', 'Nope')
        .field('price', '1.00')
        .expect(403);
      await request(server())
        .patch(`/api/merchandise/${UNKNOWN_ID}`)
        .set(auth)
        .expect(403);
      await request(server())
        .delete(`/api/merchandise/${UNKNOWN_ID}`)
        .set(auth)
        .expect(403);
      await request(server())
        .post(`/api/merchandise/${UNKNOWN_ID}/variants`)
        .set(auth)
        .send({ size: 'L' })
        .expect(403);
      await request(server())
        .patch(`/api/merchandise/${UNKNOWN_ID}/variants/${UNKNOWN_ID}`)
        .set(auth)
        .send({ stock: 1 })
        .expect(403);
      await request(server())
        .delete(`/api/merchandise/${UNKNOWN_ID}/variants/${UNKNOWN_ID}`)
        .set(auth)
        .expect(403);
    });
  });

  describe('POST /api/merchandise', () => {
    it('creates one product and three variants from a multipart JSON array', async () => {
      const token = await adminToken();

      const response = await request(server())
        .post('/api/merchandise')
        .set('Authorization', `Bearer ${token}`)
        .field('productName', 'Team Jersey')
        .field('price', '39.95')
        .field('description', 'Breathable knit jersey.')
        .field('status', 'active')
        .field(
          'variants',
          JSON.stringify([
            { size: 'S', color: 'Black', stock: 10 },
            { size: 'M', color: 'Black', stock: 4 },
            { size: 'L', color: 'White', stock: 0 },
          ]),
        )
        .expect(201);

      const body = response.body as ItemBody;

      expect(body.data).toEqual(
        expect.objectContaining({
          name: 'Team Jersey',
          // Two-decimal string, never a float.
          price: '39.95',
          status: ItemStatus.ACTIVE,
          variantCount: 3,
          totalStock: 14,
          // The M variant is at 4, under the threshold of 5.
          isLowStock: true,
        }),
      );

      expect(body.data.variants.map((variant) => variant.size)).toEqual([
        'S',
        'M',
        'L',
      ]);
      expect(body.data.variants.map((variant) => variant.isLowStock)).toEqual([
        false,
        true,
        // 0 is out of stock, not low stock.
        false,
      ]);

      await expect(
        testPrisma.merchandiseVariant.count({
          where: { merchandiseId: body.data.id },
        }),
      ).resolves.toBe(3);
    });

    it('generates a deterministic SKU per variant', async () => {
      const token = await adminToken();

      const response = await request(server())
        .post('/api/merchandise')
        .set('Authorization', `Bearer ${token}`)
        .field('productName', 'Cap')
        .field('price', '24.00')
        .field(
          'variants',
          JSON.stringify([{ color: 'Navy' }, { color: 'Red' }]),
        )
        .expect(201);

      const body = response.body as ItemBody;
      const prefix = body.data.id.slice(0, 4).toUpperCase();

      expect(body.data.variants.map((variant) => variant.sku)).toEqual([
        `MERCH-${prefix}-NAVY`,
        `MERCH-${prefix}-RED`,
      ]);
    });

    it('rolls the product back when the third variant fails', async () => {
      const token = await adminToken();

      // A SKU that already belongs to something else. The clash is only
      // discovered by the unique index, inside the transaction, after the
      // product and two variants have been written.
      const other = await seedMerchandise(seededAdminId, { name: 'Incumbent' });
      await testPrisma.merchandiseVariant.create({
        data: { merchandiseId: other.id, sku: 'TAKEN-SKU-01', stock: 1 },
      });

      await request(server())
        .post('/api/merchandise')
        .set('Authorization', `Bearer ${token}`)
        .field('productName', 'Rollback Product')
        .field('price', '10.00')
        .field(
          'variants',
          JSON.stringify([
            { size: 'S', sku: 'ROLLBACK-01' },
            { size: 'M', sku: 'ROLLBACK-02' },
            { size: 'L', sku: 'TAKEN-SKU-01' },
          ]),
        )
        .expect(409);

      // The product must not exist. A partially written variant set has no
      // user-visible symptom — the product looks fine and only a customer who
      // cannot find their size ever notices.
      await expect(
        testPrisma.merchandise.count({ where: { name: 'Rollback Product' } }),
      ).resolves.toBe(0);

      // And neither must the two variants written before the clash.
      await expect(
        testPrisma.merchandiseVariant.count({
          where: { sku: { in: ['ROLLBACK-01', 'ROLLBACK-02'] } },
        }),
      ).resolves.toBe(0);

      // The incumbent is untouched.
      await expect(
        testPrisma.merchandiseVariant.count({
          where: { sku: 'TAKEN-SKU-01' },
        }),
      ).resolves.toBe(1);
    });

    it('rejects two submitted variants sharing a SKU with 409', async () => {
      const token = await adminToken();

      await request(server())
        .post('/api/merchandise')
        .set('Authorization', `Bearer ${token}`)
        .field('productName', 'Duplicate Batch')
        .field('price', '10.00')
        .field(
          'variants',
          JSON.stringify([{ sku: 'DUP-01' }, { sku: 'DUP-01' }]),
        )
        .expect(409);

      await expect(
        testPrisma.merchandise.count({ where: { name: 'Duplicate Batch' } }),
      ).resolves.toBe(0);
    });

    it.each(['-1.00', '19.999', 'free'])(
      'rejects the price %s with 400',
      async (price) => {
        const token = await adminToken();

        await request(server())
          .post('/api/merchandise')
          .set('Authorization', `Bearer ${token}`)
          .field('productName', 'Bad price')
          .field('price', price)
          .expect(400);
      },
    );

    it('rejects a negative variant stock with 400', async () => {
      const token = await adminToken();

      await request(server())
        .post('/api/merchandise')
        .set('Authorization', `Bearer ${token}`)
        .field('productName', 'Bad stock')
        .field('price', '10.00')
        .field('variants', JSON.stringify([{ size: 'L', stock: -1 }]))
        .expect(400);
    });

    it('rejects a malformed variants payload with 400', async () => {
      const token = await adminToken();

      await request(server())
        .post('/api/merchandise')
        .set('Authorization', `Bearer ${token}`)
        .field('productName', 'Bad variants')
        .field('price', '10.00')
        .field('variants', 'not json')
        .expect(400);
    });

    it('stores the product photo and serves it over /uploads', async () => {
      const token = await adminToken();

      const response = await request(server())
        .post('/api/merchandise')
        .set('Authorization', `Bearer ${token}`)
        .field('productName', 'With Photo')
        .field('price', '15.00')
        .attach('image', await pngFixture(1600, 900), {
          filename: 'product.png',
          contentType: 'image/png',
        })
        .expect(201);

      const body = response.body as ItemBody;
      expect(body.data.image).not.toBeNull();

      const asset = await testPrisma.mediaAsset.findUniqueOrThrow({
        where: { id: body.data.image!.id },
      });

      expect(asset.key).toMatch(/^merchandise\/[0-9a-f-]{36}\.webp$/);

      const onDisk = join(uploadDir, ...asset.key.split('/'));
      const stored = await readFile(onDisk);

      const served = await request(server())
        .get(`/uploads/${asset.key}`)
        .expect(200);

      expect(served.headers['content-type']).toContain('image/webp');
      expect(Buffer.from(served.body as Buffer)).toEqual(stored);
    });
  });

  describe('GET /api/merchandise', () => {
    it('filters by status and searches the name', async () => {
      const token = await adminToken();

      await seedMerchandise(seededAdminId, {
        name: 'Jersey Home',
        status: ItemStatus.ACTIVE,
      });
      await seedMerchandise(seededAdminId, {
        name: 'Jersey Away',
        status: ItemStatus.INACTIVE,
      });
      await seedMerchandise(seededAdminId, {
        name: 'Sticker Pack',
        status: ItemStatus.ACTIVE,
      });

      const filtered = await request(server())
        .get('/api/merchandise')
        .query({ status: ItemStatus.ACTIVE, search: 'jersey' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((filtered.body as ListBody).data.map((row) => row.name)).toEqual([
        'Jersey Home',
      ]);
    });

    it('reports variantCount and totalStock on every row', async () => {
      const token = await adminToken();

      const product = await seedMerchandise(seededAdminId, { name: 'Counted' });
      await testPrisma.merchandiseVariant.createMany({
        data: [
          { merchandiseId: product.id, size: 'S', stock: 7, sku: 'CNT-S' },
          { merchandiseId: product.id, size: 'M', stock: 3, sku: 'CNT-M' },
        ],
      });

      const response = await request(server())
        .get('/api/merchandise')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((response.body as ListBody).data[0]).toEqual(
        expect.objectContaining({
          variantCount: 2,
          totalStock: 10,
          isLowStock: true,
        }),
      );
    });
  });

  describe('variant endpoints', () => {
    it('adds, updates and removes a variant', async () => {
      const token = await adminToken();
      const auth = { Authorization: `Bearer ${token}` };

      const product = await seedMerchandise(seededAdminId, {
        name: 'Editable',
      });

      const added = await request(server())
        .post(`/api/merchandise/${product.id}/variants`)
        .set(auth)
        .send({ size: 'XL', color: 'Green', stock: 9 })
        .expect(201);

      const variant = (added.body as VariantBody).data;

      expect(variant.sku).toBe(
        `MERCH-${product.id.slice(0, 4).toUpperCase()}-XL-GREEN`,
      );
      expect(variant.stock).toBe(9);
      expect(variant.isLowStock).toBe(false);

      const updated = await request(server())
        .patch(`/api/merchandise/${product.id}/variants/${variant.id}`)
        .set(auth)
        .send({ stock: 2, color: 'Emerald' })
        .expect(200);

      expect((updated.body as VariantBody).data).toEqual(
        expect.objectContaining({
          stock: 2,
          color: 'Emerald',
          isLowStock: true,
        }),
      );

      await request(server())
        .delete(`/api/merchandise/${product.id}/variants/${variant.id}`)
        .set(auth)
        .expect(204);

      await expect(
        testPrisma.merchandiseVariant.count({
          where: { merchandiseId: product.id },
        }),
      ).resolves.toBe(0);
    });

    it('returns 409 for a SKU another variant already has', async () => {
      const token = await adminToken();

      const product = await seedMerchandise(seededAdminId);
      await testPrisma.merchandiseVariant.create({
        data: { merchandiseId: product.id, sku: 'CLASH-01', stock: 1 },
      });

      await request(server())
        .post(`/api/merchandise/${product.id}/variants`)
        .set('Authorization', `Bearer ${token}`)
        .send({ size: 'L', sku: 'CLASH-01' })
        .expect(409);
    });

    it('returns 404 for a variant belonging to another product', async () => {
      const token = await adminToken();

      const [mine, theirs] = await Promise.all([
        seedMerchandise(seededAdminId),
        seedMerchandise(seededAdminId),
      ]);

      const foreign = await testPrisma.merchandiseVariant.create({
        data: { merchandiseId: theirs.id, sku: 'FOREIGN-01', stock: 1 },
      });

      await request(server())
        .patch(`/api/merchandise/${mine.id}/variants/${foreign.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ stock: 5 })
        .expect(404);
    });
  });

  describe('DELETE /api/merchandise/:id', () => {
    it('soft-deletes the product and keeps its variants', async () => {
      const token = await adminToken();

      const product = await seedMerchandise(seededAdminId, { name: 'Retired' });
      await testPrisma.merchandiseVariant.create({
        data: { merchandiseId: product.id, sku: 'RETIRED-01', stock: 3 },
      });

      await request(server())
        .delete(`/api/merchandise/${product.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      const stored = await testPrisma.merchandise.findUniqueOrThrow({
        where: { id: product.id },
      });

      expect(stored.deletedAt).toBeInstanceOf(Date);
      // A soft delete is not a cascade: an order placed in Milestone 2 still
      // needs to name the variant that was bought.
      await expect(
        testPrisma.merchandiseVariant.count({
          where: { merchandiseId: product.id },
        }),
      ).resolves.toBe(1);

      await request(server())
        .get(`/api/merchandise/${product.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);

      const list = await request(server())
        .get('/api/merchandise')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((list.body as ListBody).meta.total).toBe(0);
    });

    it('cascades to the variants on a hard delete', async () => {
      const product = await seedMerchandise(seededAdminId);
      await testPrisma.merchandiseVariant.createMany({
        data: [
          { merchandiseId: product.id, sku: 'CASCADE-01', stock: 1 },
          { merchandiseId: product.id, sku: 'CASCADE-02', stock: 1 },
        ],
      });

      // The API never hard-deletes; this asserts the schema's onDelete: Cascade
      // so a purge or a data migration cannot leave orphaned variants behind.
      await testPrisma.merchandise.delete({ where: { id: product.id } });

      await expect(
        testPrisma.merchandiseVariant.count({
          where: { merchandiseId: product.id },
        }),
      ).resolves.toBe(0);
    });
  });

  describe('PATCH /api/merchandise/:id', () => {
    it('updates the product fields and leaves the variants alone', async () => {
      const token = await adminToken();

      const product = await seedMerchandise(seededAdminId, { name: 'Before' });
      await testPrisma.merchandiseVariant.create({
        data: { merchandiseId: product.id, sku: 'KEEP-01', stock: 6 },
      });

      const response = await request(server())
        .patch(`/api/merchandise/${product.id}`)
        .set('Authorization', `Bearer ${token}`)
        .field('productName', 'After')
        .field('price', '99.50')
        .field('status', 'inactive')
        .expect(200);

      expect((response.body as ItemBody).data).toEqual(
        expect.objectContaining({
          name: 'After',
          price: '99.50',
          status: ItemStatus.INACTIVE,
          variantCount: 1,
          totalStock: 6,
        }),
      );
    });
  });
});
