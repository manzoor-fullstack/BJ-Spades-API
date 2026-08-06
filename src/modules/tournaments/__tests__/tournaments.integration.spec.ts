import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { INestApplication } from '@nestjs/common';
import {
  Prisma,
  TournamentStatus,
  UserSource,
  UserStatus,
  UserTier,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import sharp from 'sharp';
import request from 'supertest';

import { createTestApp, SEEDED_ADMIN } from '../../../../test/create-test-app';
import { testPrisma } from '../../../../test/setup';

const SUPPORT_ADMIN = {
  email: 'support.tournaments@bjspades.com',
  password: 'Support123!',
};

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

interface LoginBody {
  data: { accessToken: string };
}

interface TournamentRow {
  id: string;
  name: string;
  description: string | null;
  image: { id: string; url: string; width: number; height: number } | null;
  entryFee: string;
  prizePool: string;
  maxPlayers: number;
  registeredCount: number;
  startsAt: string;
  status: TournamentStatus;
  cancelledAt: string | null;
  cancelReason: string | null;
}

interface ItemBody {
  success: true;
  data: TournamentRow;
}

interface ListBody {
  success: true;
  data: TournamentRow[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

interface RegistrationRow {
  id: string;
  userId: string;
  placement: number | null;
  prizeWon: string | null;
  user: { id: string; fullName: string; initials: string; email: string };
}

interface RegistrationListBody {
  success: true;
  data: RegistrationRow[];
  meta: { total: number };
}

interface StatsBody {
  success: true;
  data: {
    activeTournaments: number;
    totalPrizePool: string;
    registeredPlayers: number;
    totalTournaments: number;
  };
}

/**
 * Uploads are written to a throwaway directory rather than to `./uploads-test`,
 * so a run cannot leave files behind or pick up files an earlier run left. Set
 * before createTestApp(): both LocalDiskStorageService and the static-asset
 * middleware read UPLOAD_DIR once, at construction.
 */
const uploadDir = mkdtempSync(join(tmpdir(), 'bjs-uploads-'));
const previousUploadDir = process.env.UPLOAD_DIR;

process.env.UPLOAD_DIR = uploadDir;

let fixtureCounter = 0;

async function seedUser(
  overrides: Partial<Prisma.UserUncheckedCreateInput> = {},
) {
  fixtureCounter += 1;

  const data: Prisma.UserUncheckedCreateInput = {
    firstName: `Player${fixtureCounter}`,
    lastName: `Test${fixtureCounter}`,
    email: `player${fixtureCounter}@example.com`,
    status: UserStatus.ACTIVE,
    tier: UserTier.PLAYER,
    source: UserSource.WEBHOOK,
    balance: new Prisma.Decimal(0),
    ...overrides,
  };

  return testPrisma.user.create({ data });
}

async function seedTournament(
  adminId: string,
  overrides: Partial<Prisma.TournamentUncheckedCreateInput> = {},
) {
  fixtureCounter += 1;

  const data: Prisma.TournamentUncheckedCreateInput = {
    name: `Tournament ${fixtureCounter}`,
    entryFee: new Prisma.Decimal('10.00'),
    prizePool: new Prisma.Decimal('500.00'),
    maxPlayers: 16,
    startsAt: new Date('2026-06-05T23:00:00.000Z'),
    status: TournamentStatus.SCHEDULED,
    createdByAdminId: adminId,
    ...overrides,
  };

  return testPrisma.tournament.create({ data });
}

/** A real PNG, so sharp has something it can actually decode. */
function pngFixture(width = 1600, height = 900): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 12, g: 92, b: 64 },
    },
  })
    .png()
    .toBuffer();
}

describe('Tournaments API (integration)', () => {
  let app: INestApplication;
  let seededAdminId: string;
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    app = await createTestApp();

    const supportRole = await testPrisma.role.findUniqueOrThrow({
      where: { name: 'SUPPORT' },
    });

    const password = await bcrypt.hash(SUPPORT_ADMIN.password, 10);

    // SUPPORT deliberately lacks tournaments.manage — that split is what the
    // 403 cases below assert.
    await testPrisma.admin.upsert({
      where: { email: SUPPORT_ADMIN.email },
      update: { password, roleId: supportRole.id, isActive: true },
      create: {
        firstName: 'Tournaments',
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
      await request(server()).get('/api/tournaments').expect(401);
      await request(server()).get('/api/tournaments/stats').expect(401);
      await request(server()).post('/api/tournaments').expect(401);
    });

    it('returns 403 for an admin without tournaments.manage', async () => {
      const token = await supportToken();
      const auth = { Authorization: `Bearer ${token}` };

      await request(server()).get('/api/tournaments').set(auth).expect(403);
      await request(server())
        .get('/api/tournaments/stats')
        .set(auth)
        .expect(403);
      await request(server())
        .get(`/api/tournaments/${UNKNOWN_ID}`)
        .set(auth)
        .expect(403);
      await request(server())
        .post('/api/tournaments')
        .set(auth)
        .field('name', 'Nope')
        .field('maxPlayers', '8')
        .field('startDate', '2026-06-01')
        .field('startTime', '20:00')
        .expect(403);
      await request(server())
        .patch(`/api/tournaments/${UNKNOWN_ID}`)
        .set(auth)
        .expect(403);
      await request(server())
        .patch(`/api/tournaments/${UNKNOWN_ID}/cancel`)
        .set(auth)
        .send({ reason: 'no' })
        .expect(403);
      await request(server())
        .delete(`/api/tournaments/${UNKNOWN_ID}`)
        .set(auth)
        .expect(403);
      await request(server())
        .get(`/api/tournaments/${UNKNOWN_ID}/registrations`)
        .set(auth)
        .expect(403);
      await request(server())
        .post(`/api/tournaments/${UNKNOWN_ID}/registrations`)
        .set(auth)
        .send({ userId: UNKNOWN_ID })
        .expect(403);
      await request(server())
        .delete(`/api/tournaments/${UNKNOWN_ID}/registrations/${UNKNOWN_ID}`)
        .set(auth)
        .expect(403);
      await request(server())
        .post(`/api/tournaments/${UNKNOWN_ID}/results`)
        .set(auth)
        .send({ results: [{ userId: UNKNOWN_ID, placement: 1 }] })
        .expect(403);
    });
  });

  describe('POST /api/tournaments', () => {
    it('creates a tournament from multipart fields, combining date and time as UTC', async () => {
      const token = await adminToken();

      const response = await request(server())
        .post('/api/tournaments')
        .set('Authorization', `Bearer ${token}`)
        .field('name', 'Spring Championship')
        .field('description', 'Season finale')
        .field('entryFee', '25.50')
        .field('prizePool', '10000.00')
        .field('maxPlayers', '16')
        .field('startDate', '2026-05-30')
        .field('startTime', '20:00')
        .field('status', TournamentStatus.REGISTERING)
        .expect(201);

      const body = response.body as ItemBody;

      expect(body.data).toEqual(
        expect.objectContaining({
          name: 'Spring Championship',
          // Strings, not floats: 25.5 would round-trip badly as JSON.
          entryFee: '25.50',
          prizePool: '10000.00',
          maxPlayers: 16,
          registeredCount: 0,
          status: TournamentStatus.REGISTERING,
          image: null,
        }),
      );
      expect(body.data.startsAt).toBe('2026-05-30T20:00:00.000Z');
    });

    it('writes a MediaAsset, stores WebP on disk and serves it over HTTP', async () => {
      const token = await adminToken();
      const source = await pngFixture(1600, 900);

      const response = await request(server())
        .post('/api/tournaments')
        .set('Authorization', `Bearer ${token}`)
        .field('name', 'With Banner')
        .field('maxPlayers', '8')
        .field('startDate', '2026-07-01')
        .field('startTime', '18:30')
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
      expect(asset.key).toMatch(/^tournaments\/[0-9a-f-]{36}\.webp$/);
      expect(asset.mimeType).toBe('image/webp');
      // Resized to the 1200px bound, aspect ratio kept.
      expect(asset.width).toBe(1200);
      expect(asset.height).toBe(675);
      expect(asset.uploadedByAdminId).toBe(seededAdminId);

      const onDisk = join(uploadDir, ...asset.key.split('/'));
      expect(existsSync(onDisk)).toBe(true);

      const stored = await readFile(onDisk);
      expect(stored.length).toBe(asset.sizeBytes);
      expect((await sharp(stored).metadata()).format).toBe('webp');
      expect(stored.length).toBeLessThan(source.length);

      // Served by the static middleware at /uploads, outside the /api prefix.
      const served = await request(server())
        .get(`/uploads/${asset.key}`)
        .expect(200);

      expect(served.headers['content-type']).toContain('image/webp');
      expect(Buffer.from(served.body as Buffer)).toEqual(stored);
      expect(asset.url).toBe(`${process.env.PUBLIC_URL}/uploads/${asset.key}`);
    });

    it('rejects a PHP payload renamed .jpg with 400', async () => {
      const token = await adminToken();

      const response = await request(server())
        .post('/api/tournaments')
        .set('Authorization', `Bearer ${token}`)
        .field('name', 'Polyglot')
        .field('maxPlayers', '8')
        .field('startDate', '2026-07-01')
        .field('startTime', '18:30')
        .attach(
          'image',
          Buffer.from('<?php system($_GET["cmd"]); ?>          ', 'utf8'),
          { filename: 'shell.jpg', contentType: 'image/jpeg' },
        )
        .expect(400);

      expect(JSON.stringify(response.body)).toMatch(/not a recognised/i);
      await expect(testPrisma.mediaAsset.count()).resolves.toBe(0);
      await expect(
        testPrisma.tournament.count({ where: { name: 'Polyglot' } }),
      ).resolves.toBe(0);
    });

    it('rejects an image type outside the allowlist with 400', async () => {
      const token = await adminToken();

      await request(server())
        .post('/api/tournaments')
        .set('Authorization', `Bearer ${token}`)
        .field('name', 'Gif')
        .field('maxPlayers', '8')
        .field('startDate', '2026-07-01')
        .field('startTime', '18:30')
        .attach('image', Buffer.from('GIF89a', 'ascii'), {
          filename: 'anim.gif',
          contentType: 'image/gif',
        })
        .expect(400);
    });

    it.each([
      TournamentStatus.IN_PROGRESS,
      TournamentStatus.COMPLETED,
      TournamentStatus.CANCELLED,
    ])('refuses to create a tournament already %s', async (status) => {
      const token = await adminToken();

      await request(server())
        .post('/api/tournaments')
        .set('Authorization', `Bearer ${token}`)
        .field('name', 'Bad status')
        .field('maxPlayers', '8')
        .field('startDate', '2026-07-01')
        .field('startTime', '18:30')
        .field('status', status)
        .expect(400);
    });
  });

  describe('GET /api/tournaments', () => {
    it('filters by status and reports the real registered count', async () => {
      const token = await adminToken();

      const open = await seedTournament(seededAdminId, {
        name: 'Open Bracket',
        status: TournamentStatus.REGISTERING,
        maxPlayers: 16,
      });
      await seedTournament(seededAdminId, {
        name: 'Later',
        status: TournamentStatus.SCHEDULED,
      });

      const users = await Promise.all([seedUser(), seedUser(), seedUser()]);

      await testPrisma.tournamentRegistration.createMany({
        data: users.map((user) => ({
          tournamentId: open.id,
          userId: user.id,
        })),
      });

      const response = await request(server())
        .get('/api/tournaments')
        .query({ status: TournamentStatus.REGISTERING })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as ListBody;

      expect(body.meta.total).toBe(1);
      expect(body.data).toHaveLength(1);
      // "3/16" on the card, not the mock's hardcoded "0/16".
      expect(body.data[0]).toEqual(
        expect.objectContaining({
          name: 'Open Bracket',
          registeredCount: 3,
          maxPlayers: 16,
        }),
      );
    });

    it('searches on the name', async () => {
      const token = await adminToken();

      await seedTournament(seededAdminId, { name: 'Midweek Masters' });
      await seedTournament(seededAdminId, { name: 'Friday Night Spades' });

      const response = await request(server())
        .get('/api/tournaments')
        .query({ search: 'midweek' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as ListBody;

      expect(body.data.map((row) => row.name)).toEqual(['Midweek Masters']);
    });
  });

  describe('GET /api/tournaments/stats', () => {
    it('aggregates active tournaments, prize pool and registered players', async () => {
      const token = await adminToken();

      const open = await seedTournament(seededAdminId, {
        status: TournamentStatus.REGISTERING,
        prizePool: new Prisma.Decimal('1000.00'),
      });
      await seedTournament(seededAdminId, {
        status: TournamentStatus.IN_PROGRESS,
        prizePool: new Prisma.Decimal('250.50'),
      });
      await seedTournament(seededAdminId, {
        status: TournamentStatus.CANCELLED,
        prizePool: new Prisma.Decimal('9999.00'),
      });

      const user = await seedUser();
      await testPrisma.tournamentRegistration.create({
        data: { tournamentId: open.id, userId: user.id },
      });

      const response = await request(server())
        .get('/api/tournaments/stats')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((response.body as StatsBody).data).toEqual({
        activeTournaments: 2,
        // The cancelled tournament's prize money is not on offer.
        totalPrizePool: '1250.50',
        registeredPlayers: 1,
        totalTournaments: 3,
      });
    });
  });

  describe('PATCH /api/tournaments/:id', () => {
    it('replaces the banner and deletes the previous file', async () => {
      const token = await adminToken();

      const created = await request(server())
        .post('/api/tournaments')
        .set('Authorization', `Bearer ${token}`)
        .field('name', 'Rebrand')
        .field('maxPlayers', '8')
        .field('startDate', '2026-07-01')
        .field('startTime', '18:30')
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
        .patch(`/api/tournaments/${(created.body as ItemBody).data.id}`)
        .set('Authorization', `Bearer ${token}`)
        .field('name', 'Rebranded')
        .attach('image', await pngFixture(500, 500), {
          filename: 'second.png',
          contentType: 'image/png',
        })
        .expect(200);

      const secondAssetId = (updated.body as ItemBody).data.image!.id;

      expect(secondAssetId).not.toBe(firstAssetId);
      expect((updated.body as ItemBody).data.name).toBe('Rebranded');
      expect(existsSync(firstPath)).toBe(false);
      await expect(
        testPrisma.mediaAsset.findUnique({ where: { id: firstAssetId } }),
      ).resolves.toBeNull();
    });

    it('rejects an illegal status transition with 422 naming the allowed set', async () => {
      const token = await adminToken();

      const tournament = await seedTournament(seededAdminId, {
        status: TournamentStatus.SCHEDULED,
      });

      const response = await request(server())
        .patch(`/api/tournaments/${tournament.id}`)
        .set('Authorization', `Bearer ${token}`)
        .field('status', TournamentStatus.COMPLETED)
        .expect(422);

      expect(JSON.stringify(response.body)).toContain('REGISTERING');
    });
  });

  describe('PATCH /api/tournaments/:id/cancel', () => {
    it('sets status, cancelledAt and cancelReason', async () => {
      const token = await adminToken();

      const tournament = await seedTournament(seededAdminId, {
        status: TournamentStatus.REGISTERING,
      });

      const response = await request(server())
        .patch(`/api/tournaments/${tournament.id}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Venue withdrew' })
        .expect(200);

      const body = response.body as ItemBody;

      expect(body.data.status).toBe(TournamentStatus.CANCELLED);
      expect(body.data.cancelledAt).not.toBeNull();
      expect(body.data.cancelReason).toBe('Venue withdrew');

      const stored = await testPrisma.tournament.findUniqueOrThrow({
        where: { id: tournament.id },
      });

      expect(stored.status).toBe(TournamentStatus.CANCELLED);
      expect(stored.cancelledAt).toBeInstanceOf(Date);
      expect(stored.cancelReason).toBe('Venue withdrew');
    });

    it('requires a reason', async () => {
      const token = await adminToken();

      const tournament = await seedTournament(seededAdminId);

      await request(server())
        .patch(`/api/tournaments/${tournament.id}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(400);
    });
  });

  describe('DELETE /api/tournaments/:id', () => {
    it('deletes the tournament, its registrations and its banner file', async () => {
      const token = await adminToken();

      const created = await request(server())
        .post('/api/tournaments')
        .set('Authorization', `Bearer ${token}`)
        .field('name', 'Doomed')
        .field('maxPlayers', '8')
        .field('startDate', '2026-07-01')
        .field('startTime', '18:30')
        .attach('image', await pngFixture(300, 300), {
          filename: 'banner.png',
          contentType: 'image/png',
        })
        .expect(201);

      const tournament = (created.body as ItemBody).data;
      const asset = await testPrisma.mediaAsset.findUniqueOrThrow({
        where: { id: tournament.image!.id },
      });
      const onDisk = join(uploadDir, ...asset.key.split('/'));

      expect(existsSync(onDisk)).toBe(true);

      await request(server())
        .delete(`/api/tournaments/${tournament.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      expect(existsSync(onDisk)).toBe(false);
      await expect(
        testPrisma.tournament.findUnique({ where: { id: tournament.id } }),
      ).resolves.toBeNull();
      await expect(
        testPrisma.mediaAsset.findUnique({ where: { id: asset.id } }),
      ).resolves.toBeNull();
    });
  });

  describe('registrations', () => {
    it('registers a user, then answers 409 on a second attempt', async () => {
      const token = await adminToken();

      const tournament = await seedTournament(seededAdminId, {
        status: TournamentStatus.REGISTERING,
      });
      // Funded: since Phase 6 the fixture's 10.00 entry fee is debited on
      // registration, and a player who cannot cover it is refused with 422.
      const user = await seedUser({ balance: new Prisma.Decimal('100.00') });

      await request(server())
        .post(`/api/tournaments/${tournament.id}/registrations`)
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: user.id })
        .expect(201);

      await request(server())
        .post(`/api/tournaments/${tournament.id}/registrations`)
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: user.id })
        .expect(409);

      await expect(
        testPrisma.tournamentRegistration.count({
          where: { tournamentId: tournament.id },
        }),
      ).resolves.toBe(1);
    });

    it('lists registrations with a user summary', async () => {
      const token = await adminToken();

      const tournament = await seedTournament(seededAdminId, {
        status: TournamentStatus.REGISTERING,
      });
      const user = await seedUser({
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada.integration@example.com',
      });

      await testPrisma.tournamentRegistration.create({
        data: { tournamentId: tournament.id, userId: user.id },
      });

      const response = await request(server())
        .get(`/api/tournaments/${tournament.id}/registrations`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as RegistrationListBody;

      expect(body.meta.total).toBe(1);
      expect(body.data[0]?.user).toEqual(
        expect.objectContaining({
          fullName: 'Ada Lovelace',
          initials: 'AL',
          email: 'ada.integration@example.com',
        }),
      );
    });

    it('removes a registered player', async () => {
      const token = await adminToken();

      const tournament = await seedTournament(seededAdminId, {
        status: TournamentStatus.REGISTERING,
      });
      const user = await seedUser();

      await testPrisma.tournamentRegistration.create({
        data: { tournamentId: tournament.id, userId: user.id },
      });

      await request(server())
        .delete(`/api/tournaments/${tournament.id}/registrations/${user.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      await expect(
        testPrisma.tournamentRegistration.count({
          where: { tournamentId: tournament.id },
        }),
      ).resolves.toBe(0);
    });

    it('returns 422 when the tournament is not REGISTERING', async () => {
      const token = await adminToken();

      const tournament = await seedTournament(seededAdminId, {
        status: TournamentStatus.SCHEDULED,
      });
      const user = await seedUser();

      await request(server())
        .post(`/api/tournaments/${tournament.id}/registrations`)
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: user.id })
        .expect(422);
    });

    it('returns 422 for a suspended user', async () => {
      const token = await adminToken();

      const tournament = await seedTournament(seededAdminId, {
        status: TournamentStatus.REGISTERING,
      });
      const user = await seedUser({ status: UserStatus.SUSPENDED });

      await request(server())
        .post(`/api/tournaments/${tournament.id}/registrations`)
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: user.id })
        .expect(422);
    });

    it('returns 422 when the tournament is already full', async () => {
      const token = await adminToken();

      const tournament = await seedTournament(seededAdminId, {
        status: TournamentStatus.REGISTERING,
        maxPlayers: 2,
      });

      const [first, second, third] = await Promise.all([
        seedUser(),
        seedUser(),
        // Funded, so the 422 is the tournament being full rather than the
        // Phase 6 entry-fee debit failing first.
        seedUser({ balance: new Prisma.Decimal('100.00') }),
      ]);

      await testPrisma.tournamentRegistration.createMany({
        data: [
          { tournamentId: tournament.id, userId: first.id },
          { tournamentId: tournament.id, userId: second.id },
        ],
      });

      await request(server())
        .post(`/api/tournaments/${tournament.id}/registrations`)
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: third.id })
        .expect(422);
    });

    it('lets exactly one of two concurrent requests take the final slot', async () => {
      const token = await adminToken();

      const tournament = await seedTournament(seededAdminId, {
        status: TournamentStatus.REGISTERING,
        maxPlayers: 1,
      });

      // Both funded, so the 422 below can only come from the capacity check
      // and not from the Phase 6 entry-fee debit.
      const [first, second] = await Promise.all([
        seedUser({ balance: new Prisma.Decimal('100.00') }),
        seedUser({ balance: new Prisma.Decimal('100.00') }),
      ]);

      // Two different users, so the unique constraint cannot settle it — only
      // the row lock inside the transaction can.
      const responses = await Promise.all([
        request(server())
          .post(`/api/tournaments/${tournament.id}/registrations`)
          .set('Authorization', `Bearer ${token}`)
          .send({ userId: first.id }),
        request(server())
          .post(`/api/tournaments/${tournament.id}/registrations`)
          .set('Authorization', `Bearer ${token}`)
          .send({ userId: second.id }),
      ]);

      const statuses = responses.map((response) => response.status).sort();

      expect(statuses).toEqual([201, 422]);
      await expect(
        testPrisma.tournamentRegistration.count({
          where: { tournamentId: tournament.id },
        }),
      ).resolves.toBe(1);
    });
  });

  describe('POST /api/tournaments/:id/results', () => {
    it('records placements and prizes and completes the tournament', async () => {
      const token = await adminToken();

      const tournament = await seedTournament(seededAdminId, {
        status: TournamentStatus.IN_PROGRESS,
      });
      const [winner, runnerUp] = await Promise.all([seedUser(), seedUser()]);

      await testPrisma.tournamentRegistration.createMany({
        data: [
          { tournamentId: tournament.id, userId: winner.id },
          { tournamentId: tournament.id, userId: runnerUp.id },
        ],
      });

      const response = await request(server())
        .post(`/api/tournaments/${tournament.id}/results`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          results: [
            { userId: winner.id, placement: 1, prizeWon: '750.25' },
            { userId: runnerUp.id, placement: 2 },
          ],
        })
        .expect(200);

      expect((response.body as ItemBody).data.status).toBe(
        TournamentStatus.COMPLETED,
      );

      const rows = await testPrisma.tournamentRegistration.findMany({
        where: { tournamentId: tournament.id },
        orderBy: { placement: 'asc' },
      });

      expect(rows[0]?.placement).toBe(1);
      expect(rows[0]?.prizeWon?.toFixed(2)).toBe('750.25');
      expect(rows[1]?.placement).toBe(2);
      // Still no money moved. Phase 6 creates a PENDING `Payout` for the prize
      // instead — the obligation is recorded here; the balance moves only when
      // `POST /payouts/:id/process` completes the Stripe transfer.
      const balances = await testPrisma.user.findMany({
        where: { id: { in: [winner.id, runnerUp.id] } },
        select: { balance: true },
      });
      expect(balances.every((row) => row.balance.toFixed(2) === '0.00')).toBe(
        true,
      );
    });
  });

  describe('404s', () => {
    it('answers 404 for an unknown tournament', async () => {
      const token = await adminToken();

      await request(server())
        .get(`/api/tournaments/${UNKNOWN_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });
  });
});
