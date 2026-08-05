import type { Server } from 'node:http';

import { INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import request from 'supertest';

import { PERMISSION_CODES } from '../../../common/constants/permissions';
import { SUPER_ADMIN_ROLE } from '../../../common/constants/roles';
import { createTestApp, SEEDED_ADMIN } from '../../../../test/create-test-app';
import { testPrisma } from '../../../../test/setup';

/**
 * setup.ts PRESERVES Role, Permission, RolePermission and Admin between tests —
 * they are reference data. Anything this suite writes to them therefore has to
 * be undone in afterEach, or every later suite inherits the damage.
 *
 * The two conventions that make that reliable:
 *  - every admin created by a test uses TEST_EMAIL_DOMAIN
 *  - every role created by a test is named TEST_ROLE_PREFIX*
 *
 * and the full RolePermission table is snapshotted once and restored after each
 * test, because `PUT /roles/:id/permissions` rewrites it wholesale.
 */
const TEST_EMAIL_DOMAIN = '@phase3.test';
const TEST_ROLE_PREFIX = 'PHASE3_';

/** Kept for the whole suite, so it needs an email outside the swept domain. */
const SUPPORT_ADMIN = {
  email: 'support.phase3@bjspades.com',
  password: 'Support123!',
};

const FIXTURE_PASSWORD = 'Phase3Pass!';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

interface LoginBody {
  data: { accessToken: string };
}

interface AdminRow {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  initials: string;
  email: string;
  isActive: boolean;
  lastLogin: string | null;
  role: { id: string; name: string; displayName: string };
  permissions: string[];
  createdAt: string;
  updatedAt: string;
}

interface AdminListBody {
  success: true;
  data: AdminRow[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

interface AdminItemBody {
  success: true;
  data: AdminRow;
}

interface RoleRow {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  isSystem: boolean;
  adminCount: number;
  permissions: string[];
}

interface RoleListBody {
  success: true;
  data: RoleRow[];
}

interface RoleItemBody {
  success: true;
  data: RoleRow;
}

interface PermissionListBody {
  success: true;
  data: { code: string; name: string; description: string | null }[];
}

interface ErrorBody {
  message?: string;
  error?: { message?: string };
}

let fixtureCounter = 0;

function testEmail(label: string): string {
  fixtureCounter += 1;

  return `${label}.${fixtureCounter}${TEST_EMAIL_DOMAIN}`;
}

function messageOf(body: unknown): string {
  const parsed = body as ErrorBody;

  return parsed.error?.message ?? parsed.message ?? JSON.stringify(body);
}

describe('Admins & Roles API (integration)', () => {
  let app: INestApplication;
  const server = (): Server => app.getHttpServer() as Server;

  let rolePermissionSnapshot: { roleId: string; permissionId: string }[];
  let superAdminRoleId: string;
  let seededSuperAdminId: string;

  beforeAll(async () => {
    app = await createTestApp();

    rolePermissionSnapshot = await testPrisma.rolePermission.findMany({
      select: { roleId: true, permissionId: true },
    });

    const superAdminRole = await testPrisma.role.findUniqueOrThrow({
      where: { name: SUPER_ADMIN_ROLE },
    });
    superAdminRoleId = superAdminRole.id;

    const seeded = await testPrisma.admin.findUniqueOrThrow({
      where: { email: SEEDED_ADMIN.email },
    });
    seededSuperAdminId = seeded.id;

    const supportRole = await testPrisma.role.findUniqueOrThrow({
      where: { name: 'SUPPORT' },
    });

    // SUPPORT holds neither admins.manage nor roles.manage — the exact split
    // the 403 cases below depend on.
    const password = await bcrypt.hash(SUPPORT_ADMIN.password, 10);

    await testPrisma.admin.upsert({
      where: { email: SUPPORT_ADMIN.email },
      update: { password, roleId: supportRole.id, isActive: true },
      create: {
        firstName: 'Phase3',
        lastName: 'Support',
        email: SUPPORT_ADMIN.email,
        password,
        roleId: supportRole.id,
        isActive: true,
      },
    });
  });

  afterEach(async () => {
    // Admins first: Admin.roleId is a required foreign key, so the test roles
    // cannot go until nobody holds them.
    await testPrisma.admin.deleteMany({
      where: { email: { endsWith: TEST_EMAIL_DOMAIN } },
    });
    await testPrisma.role.deleteMany({
      where: { name: { startsWith: TEST_ROLE_PREFIX } },
    });

    await testPrisma.rolePermission.deleteMany({});
    await testPrisma.rolePermission.createMany({
      data: rolePermissionSnapshot,
    });
  });

  afterAll(async () => {
    await testPrisma.admin.deleteMany({
      where: { email: SUPPORT_ADMIN.email },
    });
    await app?.close();
  });

  /**
   * Logged in inside each test rather than once: setup.ts truncates Session
   * before every test and JwtStrategy rejects a token whose session is gone.
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

  /** Fixtures go in through Prisma; the API is what is under test. */
  const seedRole = async (suffix: string, codes: string[]) => {
    const role = await testPrisma.role.create({
      data: {
        name: `${TEST_ROLE_PREFIX}${suffix}`,
        displayName: `Phase 3 ${suffix}`,
        isSystem: false,
      },
    });

    if (codes.length > 0) {
      const permissions = await testPrisma.permission.findMany({
        where: { code: { in: codes } },
        select: { id: true },
      });

      await testPrisma.rolePermission.createMany({
        data: permissions.map((permission) => ({
          roleId: role.id,
          permissionId: permission.id,
        })),
      });
    }

    return role;
  };

  const seedAdmin = async (
    roleId: string,
    overrides: { email?: string; isActive?: boolean } = {},
  ) => {
    return testPrisma.admin.create({
      data: {
        firstName: 'Test',
        lastName: 'Admin',
        email: overrides.email ?? testEmail('fixture'),
        password: await bcrypt.hash(FIXTURE_PASSWORD, 10),
        isActive: overrides.isActive ?? true,
        roleId,
      },
    });
  };

  /** An actor holding admins.manage and roles.manage but not SUPER_ADMIN. */
  const seedManager = async () => {
    const role = await seedRole('MANAGER', [
      PERMISSION_CODES.ADMINS_MANAGE,
      PERMISSION_CODES.ROLES_MANAGE,
      PERMISSION_CODES.USERS_VIEW,
    ]);

    const email = testEmail('manager');
    await seedAdmin(role.id, { email });

    return {
      role,
      credentials: { email, password: FIXTURE_PASSWORD },
    };
  };

  const expectNoPassword = (body: unknown): void => {
    const serialised = JSON.stringify(body);

    expect(serialised).not.toContain('password');
    // The hash itself, in case a future field name hides it.
    expect(serialised).not.toContain('$2b$');
  };

  describe('POST /api/admins', () => {
    it('creates an admin who can then log in', async () => {
      const token = await adminToken();
      const role = await seedRole('VIEWER', [PERMISSION_CODES.USERS_VIEW]);
      const email = testEmail('created');

      const created = await request(server())
        .post('/api/admins')
        .set('Authorization', `Bearer ${token}`)
        .send({
          firstName: 'Sarah',
          lastName: 'Johnson',
          email,
          password: 'Str0ngPassword!',
          roleId: role.id,
        })
        .expect(201);

      const body = created.body as AdminItemBody;

      expect(body.data).toEqual(
        expect.objectContaining({
          email,
          fullName: 'Sarah Johnson',
          initials: 'SJ',
          isActive: true,
          role: expect.objectContaining({ id: role.id }) as unknown,
          permissions: [PERMISSION_CODES.USERS_VIEW],
        }),
      );
      expectNoPassword(created.body);

      const login = await request(server())
        .post('/api/auth/login')
        .send({ email, password: 'Str0ngPassword!' })
        .expect(200);

      expect((login.body as LoginBody).data.accessToken).toEqual(
        expect.any(String),
      );
    });

    it('gives the new admin exactly their role permissions, no more', async () => {
      const token = await adminToken();
      const codes = [
        PERMISSION_CODES.USERS_VIEW,
        PERMISSION_CODES.ACTIVITY_VIEW,
      ];
      const role = await seedRole('EXACT', codes);
      const email = testEmail('exact');

      await request(server())
        .post('/api/admins')
        .set('Authorization', `Bearer ${token}`)
        .send({
          firstName: 'Exact',
          lastName: 'Match',
          email,
          password: FIXTURE_PASSWORD,
          roleId: role.id,
        })
        .expect(201);

      const newToken = await tokenFor({ email, password: FIXTURE_PASSWORD });

      const me = await request(server())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${newToken}`)
        .expect(200);

      const permissions = (me.body as { data: { permissions: string[] } }).data
        .permissions;

      expect([...permissions].sort()).toEqual([...codes].sort());

      // And what they can reach matches: users.view yes, admins.manage no.
      await request(server())
        .get('/api/users')
        .set('Authorization', `Bearer ${newToken}`)
        .expect(200);

      await request(server())
        .get('/api/admins')
        .set('Authorization', `Bearer ${newToken}`)
        .expect(403);
    });

    it('rejects a duplicate email with 409', async () => {
      const token = await adminToken();
      const role = await seedRole('DUPE', []);
      const email = testEmail('duplicate');
      await seedAdmin(role.id, { email });

      await request(server())
        .post('/api/admins')
        .set('Authorization', `Bearer ${token}`)
        .send({
          firstName: 'Dup',
          lastName: 'Licate',
          email,
          password: FIXTURE_PASSWORD,
          roleId: role.id,
        })
        .expect(409);
    });

    it('rejects an unknown roleId with 404', async () => {
      const token = await adminToken();

      await request(server())
        .post('/api/admins')
        .set('Authorization', `Bearer ${token}`)
        .send({
          firstName: 'No',
          lastName: 'Role',
          email: testEmail('norole'),
          password: FIXTURE_PASSWORD,
          roleId: UNKNOWN_ID,
        })
        .expect(404);
    });
  });

  describe('GET /api/admins', () => {
    it('paginates and returns computed name fields, the role and its codes', async () => {
      const token = await adminToken();
      const role = await seedRole('LIST', [PERMISSION_CODES.ACTIVITY_VIEW]);
      await seedAdmin(role.id, { email: testEmail('list') });

      const response = await request(server())
        .get('/api/admins')
        .query({ page: 1, limit: 50 })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as AdminListBody;

      expect(body.meta).toEqual(
        expect.objectContaining({ page: 1, limit: 50 }),
      );

      const row = body.data.find((item) => item.role.id === role.id);

      expect(row).toBeDefined();
      expect(row).toEqual(
        expect.objectContaining({
          fullName: 'Test Admin',
          initials: 'TA',
          permissions: [PERMISSION_CODES.ACTIVITY_VIEW],
        }),
      );
      expect(row?.role).toEqual({
        id: role.id,
        name: `${TEST_ROLE_PREFIX}LIST`,
        displayName: 'Phase 3 LIST',
      });
    });

    it('searches firstName, lastName and email case-insensitively', async () => {
      const token = await adminToken();
      const role = await seedRole('SEARCH', []);

      await testPrisma.admin.create({
        data: {
          firstName: 'Marcus',
          lastName: 'Rodriguez',
          email: testEmail('marcus'),
          password: await bcrypt.hash(FIXTURE_PASSWORD, 10),
          roleId: role.id,
        },
      });

      const byLastName = await request(server())
        .get('/api/admins')
        .query({ search: 'RODRIG' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = byLastName.body as AdminListBody;

      expect(body.data).toHaveLength(1);
      expect(body.data[0]?.fullName).toBe('Marcus Rodriguez');
      expect(body.meta.total).toBe(1);
    });

    it('filters by roleId and by role name', async () => {
      const token = await adminToken();
      const role = await seedRole('FILTER', []);
      await seedAdmin(role.id, { email: testEmail('filtered') });

      const byId = await request(server())
        .get('/api/admins')
        .query({ roleId: role.id })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((byId.body as AdminListBody).data).toHaveLength(1);

      const byName = await request(server())
        .get('/api/admins')
        .query({ role: SUPER_ADMIN_ROLE })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const superAdmins = (byName.body as AdminListBody).data;

      expect(superAdmins.length).toBeGreaterThan(0);
      expect(
        superAdmins.every((row) => row.role.name === SUPER_ADMIN_ROLE),
      ).toBe(true);
    });

    it('never leaks a password hash, on any admin path', async () => {
      const token = await adminToken();
      const role = await seedRole('LEAK', [PERMISSION_CODES.USERS_VIEW]);
      const target = await seedAdmin(role.id, { email: testEmail('leak') });
      const otherRole = await seedRole('LEAK2', []);

      const responses = await Promise.all([
        request(server())
          .get('/api/admins')
          .set('Authorization', `Bearer ${token}`)
          .expect(200),
        request(server())
          .get(`/api/admins/${target.id}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200),
      ]);

      const sequential = [
        await request(server())
          .patch(`/api/admins/${target.id}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ firstName: 'Renamed', password: 'An0therPassword!' })
          .expect(200),
        await request(server())
          .patch(`/api/admins/${target.id}/deactivate`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200),
        await request(server())
          .patch(`/api/admins/${target.id}/activate`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200),
        await request(server())
          .patch(`/api/admins/${target.id}/role`)
          .set('Authorization', `Bearer ${token}`)
          .send({ roleId: otherRole.id })
          .expect(200),
        await request(server())
          .delete(`/api/admins/${target.id}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200),
      ];

      for (const response of [...responses, ...sequential]) {
        expectNoPassword(response.body);
      }
    });
  });

  describe('PATCH /api/admins/:id', () => {
    it('refuses a roleId on the general update route with 400', async () => {
      const token = await adminToken();
      const role = await seedRole('NOROLEEDIT', []);
      const target = await seedAdmin(role.id, { email: testEmail('noedit') });

      // admins.manage must not be a path to promoting someone: the role moves
      // through PATCH /:id/role, which requires roles.manage.
      await request(server())
        .patch(`/api/admins/${target.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ roleId: superAdminRoleId })
        .expect(400);
    });

    it('stores a new password as a hash that the admin can log in with', async () => {
      const token = await adminToken();
      const role = await seedRole('REPASS', []);
      const email = testEmail('repass');
      const target = await seedAdmin(role.id, { email });

      await request(server())
        .patch(`/api/admins/${target.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ password: 'Rotat3dPassword!' })
        .expect(200);

      const stored = await testPrisma.admin.findUniqueOrThrow({
        where: { id: target.id },
      });

      expect(stored.password).not.toBe('Rotat3dPassword!');

      await request(server())
        .post('/api/auth/login')
        .send({ email, password: 'Rotat3dPassword!' })
        .expect(200);
    });
  });

  describe('PATCH /api/admins/:id/role', () => {
    it('changes what the admin can reach on the very next request', async () => {
      const viewerRole = await seedRole('BEFORE', [
        PERMISSION_CODES.ACTIVITY_VIEW,
      ]);
      const upgradedRole = await seedRole('AFTER', [
        PERMISSION_CODES.ACTIVITY_VIEW,
        PERMISSION_CODES.USERS_VIEW,
      ]);

      const email = testEmail('moved');
      const target = await seedAdmin(viewerRole.id, { email });
      const targetToken = await tokenFor({ email, password: FIXTURE_PASSWORD });

      // Populates the guard's per-admin cache with the pre-change set.
      await request(server())
        .get('/api/users')
        .set('Authorization', `Bearer ${targetToken}`)
        .expect(403);

      const token = await adminToken();
      const changed = await request(server())
        .patch(`/api/admins/${target.id}/role`)
        .set('Authorization', `Bearer ${token}`)
        .send({ roleId: upgradedRole.id })
        .expect(200);

      expect((changed.body as AdminItemBody).data.role.id).toBe(
        upgradedRole.id,
      );

      // No waiting for the 60s TTL: the cache entry was evicted on the change.
      await request(server())
        .get('/api/users')
        .set('Authorization', `Bearer ${targetToken}`)
        .expect(200);
    });

    it('requires roles.manage, not admins.manage', async () => {
      const adminsOnlyRole = await seedRole('ADMINSONLY', [
        PERMISSION_CODES.ADMINS_MANAGE,
      ]);
      const email = testEmail('adminsonly');
      await seedAdmin(adminsOnlyRole.id, { email });

      const targetRole = await seedRole('TARGET', []);
      const target = await seedAdmin(targetRole.id, {
        email: testEmail('target'),
      });

      const token = await tokenFor({ email, password: FIXTURE_PASSWORD });

      // The same actor can edit the admin, proving the 403 is about the code
      // this one route demands rather than about the admin being unauthorised.
      await request(server())
        .patch(`/api/admins/${target.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ firstName: 'Allowed' })
        .expect(200);

      const refused = await request(server())
        .patch(`/api/admins/${target.id}/role`)
        .set('Authorization', `Bearer ${token}`)
        .send({ roleId: adminsOnlyRole.id })
        .expect(403);

      expect(JSON.stringify(refused.body)).toContain(
        PERMISSION_CODES.ROLES_MANAGE,
      );
    });
  });

  describe('PUT /api/roles/:id/permissions', () => {
    it('takes effect on the NEXT request — the cache is evicted', async () => {
      const role = await seedRole('CACHE', [PERMISSION_CODES.USERS_VIEW]);
      const email = testEmail('cached');
      await seedAdmin(role.id, { email });

      const targetToken = await tokenFor({ email, password: FIXTURE_PASSWORD });

      // Warms the 60s per-admin cache with users.view granted.
      await request(server())
        .get('/api/users')
        .set('Authorization', `Bearer ${targetToken}`)
        .expect(200);

      const token = await adminToken();
      await request(server())
        .put(`/api/roles/${role.id}/permissions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ permissionCodes: [PERMISSION_CODES.ACTIVITY_VIEW] })
        .expect(200);

      // A permission revoked for a security reason must not survive for a
      // minute. This is the assertion the whole eviction path exists for.
      await request(server())
        .get('/api/users')
        .set('Authorization', `Bearer ${targetToken}`)
        .expect(403);

      // And the newly granted one works immediately too.
      await request(server())
        .get('/api/activity')
        .set('Authorization', `Bearer ${targetToken}`)
        .expect(200);
    });

    it('replaces the set wholesale rather than merging', async () => {
      const token = await adminToken();
      const role = await seedRole('REPLACE', [
        PERMISSION_CODES.USERS_VIEW,
        PERMISSION_CODES.ACTIVITY_VIEW,
      ]);

      const response = await request(server())
        .put(`/api/roles/${role.id}/permissions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ permissionCodes: [PERMISSION_CODES.PAYOUTS_VIEW] })
        .expect(200);

      expect((response.body as RoleItemBody).data.permissions).toEqual([
        PERMISSION_CODES.PAYOUTS_VIEW,
      ]);

      const stored = await testPrisma.rolePermission.findMany({
        where: { roleId: role.id },
        include: { permission: true },
      });

      expect(stored.map((row) => row.permission.code)).toEqual([
        PERMISSION_CODES.PAYOUTS_VIEW,
      ]);
    });

    it('rejects an unknown code with 400 and changes nothing', async () => {
      const token = await adminToken();
      const role = await seedRole('BADCODE', [PERMISSION_CODES.USERS_VIEW]);

      const response = await request(server())
        .put(`/api/roles/${role.id}/permissions`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          permissionCodes: [PERMISSION_CODES.USERS_VIEW, 'users.destroy'],
        })
        .expect(400);

      expect(messageOf(response.body)).toContain('users.destroy');

      const stored = await testPrisma.rolePermission.findMany({
        where: { roleId: role.id },
      });

      expect(stored).toHaveLength(1);
    });

    it('is refused without roles.manage', async () => {
      const role = await seedRole('FORBIDDEN', []);
      const token = await supportToken();

      await request(server())
        .put(`/api/roles/${role.id}/permissions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ permissionCodes: [] })
        .expect(403);
    });
  });

  describe('GET /api/roles', () => {
    it('includes adminCount and the permission codes', async () => {
      const token = await adminToken();
      const role = await seedRole('COUNTED', [
        PERMISSION_CODES.USERS_VIEW,
        PERMISSION_CODES.ACTIVITY_VIEW,
      ]);
      await seedAdmin(role.id, { email: testEmail('counted-a') });
      await seedAdmin(role.id, { email: testEmail('counted-b') });

      const response = await request(server())
        .get('/api/roles')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const row = (response.body as RoleListBody).data.find(
        (item) => item.id === role.id,
      );

      expect(row?.adminCount).toBe(2);
      expect(row?.permissions).toEqual(
        [PERMISSION_CODES.ACTIVITY_VIEW, PERMISSION_CODES.USERS_VIEW].sort(),
      );
    });
  });

  describe('GET /api/permissions', () => {
    it('returns the catalogue with codes, names and descriptions', async () => {
      const token = await adminToken();

      const response = await request(server())
        .get('/api/permissions')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as PermissionListBody;
      const codes = body.data.map((item) => item.code);

      expect(codes).toEqual([...Object.values(PERMISSION_CODES)].sort());
      expect(body.data[0]).toEqual(
        expect.objectContaining({
          code: expect.any(String) as unknown,
          name: expect.any(String) as unknown,
        }),
      );
    });

    it('is refused without roles.manage', async () => {
      const token = await supportToken();

      await request(server())
        .get('/api/permissions')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });
  });

  describe('403 without admins.manage', () => {
    it.each([
      ['get', '/api/admins'],
      ['post', '/api/admins'],
    ])('refuses %s %s', async (method, path) => {
      const token = await supportToken();

      const response = await (
        method === 'get'
          ? request(server()).get(path)
          : request(server()).post(path).send({})
      )
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      expect(JSON.stringify(response.body)).toContain(
        PERMISSION_CODES.ADMINS_MANAGE,
      );
    });

    it('refuses the per-admin routes', async () => {
      const role = await seedRole('FORBIDDEN2', []);
      const target = await seedAdmin(role.id, {
        email: testEmail('forbidden'),
      });
      const token = await supportToken();

      await request(server())
        .get(`/api/admins/${target.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      await request(server())
        .patch(`/api/admins/${target.id}/deactivate`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      await request(server())
        .delete(`/api/admins/${target.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });
  });

  describe('guard rails return 422 with a readable reason', () => {
    it('refuses to delete your own account', async () => {
      const { credentials } = await seedManager();
      const token = await tokenFor(credentials);

      const me = await testPrisma.admin.findUniqueOrThrow({
        where: { email: credentials.email },
      });

      const response = await request(server())
        .delete(`/api/admins/${me.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(422);

      expect(messageOf(response.body)).toContain('your own account');

      // Still there.
      await testPrisma.admin.findUniqueOrThrow({ where: { id: me.id } });
    });

    it('refuses to deactivate your own account', async () => {
      const { credentials } = await seedManager();
      const token = await tokenFor(credentials);

      const me = await testPrisma.admin.findUniqueOrThrow({
        where: { email: credentials.email },
      });

      const response = await request(server())
        .patch(`/api/admins/${me.id}/deactivate`)
        .set('Authorization', `Bearer ${token}`)
        .expect(422);

      expect(messageOf(response.body)).toContain('your own account');
    });

    it('refuses to delete the last active super admin', async () => {
      const { credentials } = await seedManager();
      const token = await tokenFor(credentials);

      const response = await request(server())
        .delete(`/api/admins/${seededSuperAdminId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(422);

      expect(messageOf(response.body)).toContain('last active SUPER_ADMIN');

      await testPrisma.admin.findUniqueOrThrow({
        where: { id: seededSuperAdminId },
      });
    });

    it('refuses to deactivate the last active super admin', async () => {
      const { credentials } = await seedManager();
      const token = await tokenFor(credentials);

      const response = await request(server())
        .patch(`/api/admins/${seededSuperAdminId}/deactivate`)
        .set('Authorization', `Bearer ${token}`)
        .expect(422);

      expect(messageOf(response.body)).toContain('last active SUPER_ADMIN');

      const stored = await testPrisma.admin.findUniqueOrThrow({
        where: { id: seededSuperAdminId },
      });

      expect(stored.isActive).toBe(true);
    });

    it('refuses to demote the last active super admin', async () => {
      const { credentials, role } = await seedManager();
      const token = await tokenFor(credentials);

      const response = await request(server())
        .patch(`/api/admins/${seededSuperAdminId}/role`)
        .set('Authorization', `Bearer ${token}`)
        .send({ roleId: role.id })
        .expect(422);

      expect(messageOf(response.body)).toContain('last active SUPER_ADMIN');

      const stored = await testPrisma.admin.findUniqueOrThrow({
        where: { id: seededSuperAdminId },
      });

      expect(stored.roleId).toBe(superAdminRoleId);
    });

    /**
     * The trap: a second SUPER_ADMIN exists, so a naive count of the role's
     * holders says two. It is deactivated, so it cannot sign in, and deleting
     * the remaining active one would still lock everybody out.
     */
    it('still refuses when an INACTIVE super admin exists', async () => {
      const { credentials } = await seedManager();
      const token = await tokenFor(credentials);

      await seedAdmin(superAdminRoleId, {
        email: testEmail('dormant-super'),
        isActive: false,
      });

      expect(
        await testPrisma.admin.count({ where: { roleId: superAdminRoleId } }),
      ).toBe(2);

      const response = await request(server())
        .delete(`/api/admins/${seededSuperAdminId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(422);

      expect(messageOf(response.body)).toContain('last active SUPER_ADMIN');

      await testPrisma.admin.findUniqueOrThrow({
        where: { id: seededSuperAdminId },
      });
    });

    it('allows deleting a super admin once another active one remains', async () => {
      const { credentials } = await seedManager();
      const token = await tokenFor(credentials);

      const spare = await seedAdmin(superAdminRoleId, {
        email: testEmail('spare-super'),
      });

      // The spare is the one deleted; the seeded super admin is never at risk.
      await request(server())
        .delete(`/api/admins/${spare.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(
        await testPrisma.admin.count({
          where: { roleId: superAdminRoleId, isActive: true },
        }),
      ).toBe(1);
    });

    it('refuses to delete a system role', async () => {
      const token = await adminToken();

      const response = await request(server())
        .delete(`/api/roles/${superAdminRoleId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(422);

      expect(messageOf(response.body)).toContain('system role');

      await testPrisma.role.findUniqueOrThrow({
        where: { id: superAdminRoleId },
      });
    });

    it('refuses to delete a role still held by an admin', async () => {
      const token = await adminToken();
      const role = await seedRole('HELD', []);
      await seedAdmin(role.id, { email: testEmail('holder') });

      const response = await request(server())
        .delete(`/api/roles/${role.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(422);

      expect(messageOf(response.body)).toContain('1 admin');

      await testPrisma.role.findUniqueOrThrow({ where: { id: role.id } });
    });

    it('deletes an unheld custom role', async () => {
      const token = await adminToken();
      const role = await seedRole('UNHELD', []);

      await request(server())
        .delete(`/api/roles/${role.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(
        await testPrisma.role.findUnique({ where: { id: role.id } }),
      ).toBeNull();
    });
  });

  describe('audit trail', () => {
    it('records admin.created and role.permissions_changed', async () => {
      const token = await adminToken();
      const role = await seedRole('AUDITED', []);

      await request(server())
        .post('/api/admins')
        .set('Authorization', `Bearer ${token}`)
        .send({
          firstName: 'Audited',
          lastName: 'Admin',
          email: testEmail('audited'),
          password: FIXTURE_PASSWORD,
          roleId: role.id,
        })
        .expect(201);

      await request(server())
        .put(`/api/roles/${role.id}/permissions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ permissionCodes: [PERMISSION_CODES.ACTIVITY_VIEW] })
        .expect(200);

      // The interceptor writes without being awaited, so poll briefly.
      const actions = await waitForActions([
        'admin.created',
        'role.permissions_changed',
      ]);

      expect(actions).toEqual(
        expect.arrayContaining(['admin.created', 'role.permissions_changed']),
      );

      const created = await testPrisma.activityLog.findFirstOrThrow({
        where: { action: 'admin.created' },
      });

      expect(created.category).toBe('ADMIN');
      expect(created.isHighPriority).toBe(true);
      // The plaintext password in the request body must never be stored.
      expect(JSON.stringify(created.metadata)).not.toContain(FIXTURE_PASSWORD);
    });
  });

  async function waitForActions(expected: string[]): Promise<string[]> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const rows = await testPrisma.activityLog.findMany({
        where: { action: { in: expected } },
        select: { action: true },
      });

      const found = rows.map((row) => row.action);

      if (expected.every((action) => found.includes(action))) {
        return found;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return [];
  }
});
