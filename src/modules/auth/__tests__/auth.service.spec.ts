import {
  BadRequestException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { hashToken } from '../../../common/crypto/token-hash.util';
import { PasswordService } from '../../../common/password/password.service';
import { ActivityLogService } from '../../activity/activity.service';
import { SettingsService } from '../../settings/settings.service';
import { MediaService } from '../../storage/media.service';
import { AuthService } from '../auth.service';
import { AuthRepository } from '../repositories/auth.repository';
import { TokenService } from '../services/token.service';

type Mocked<T> = { [K in keyof T]: jest.Mock };

const ADMIN = {
  id: 'admin-1',
  firstName: 'Super',
  lastName: 'Admin',
  email: 'admin@bjspades.com',
  password: 'hashed-password',
  isActive: true,
  role: {
    id: 'role-1',
    name: 'SUPER_ADMIN',
    displayName: 'Super Administrator',
    permissions: [
      { permission: { code: 'users.manage' } },
      { permission: { code: 'roles.manage' } },
    ],
  },
};

const SESSION = { id: 'session-1', adminId: ADMIN.id };

describe('AuthService', () => {
  let service: AuthService;
  let repository: Mocked<AuthRepository>;
  let passwords: Mocked<PasswordService>;
  let tokens: Mocked<TokenService>;
  let activityLog: Pick<Mocked<ActivityLogService>, 'record'>;
  let settings: Pick<Mocked<SettingsService>, 'getSessionTimeoutMinutes'>;
  let media: Pick<Mocked<MediaService>, 'uploadImage' | 'deleteAsset'>;

  beforeEach(async () => {
    repository = {
      findAdminByEmail: jest.fn(),
      findAdminById: jest.fn(),
      // updateProfile() ends by calling me(), which reads through
      // getAdminProfile. Without this every test below fails on
      // "Cannot read properties of null (reading 'role')" — a confusing way to
      // discover that the assertion you cared about actually passed.
      getAdminProfile: jest.fn().mockResolvedValue({
        id: 'admin-1',
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.test',
        isActive: true,
        lastLogin: null,
        createdAt: new Date(),
        avatar: null,
        role: {
          name: 'SUPER_ADMIN',
          displayName: 'Super Admin',
          permissions: [],
        },
      }),
      findPermissionCodesForAdmin: jest.fn().mockResolvedValue([]),
      updateLastLogin: jest.fn().mockResolvedValue(undefined),
      updateAdminProfile: jest.fn().mockResolvedValue(undefined),
      updateAdminPassword: jest.fn().mockResolvedValue(undefined),
      createSession: jest.fn().mockResolvedValue(SESSION),
      findSessionById: jest.fn(),
      findSessionWithAdmin: jest.fn(),
      findActiveSessionsForAdmin: jest.fn(),
      findAllActiveSessions: jest.fn().mockResolvedValue([]),
      countActiveSessions: jest.fn().mockResolvedValue(0),
      touchSession: jest.fn(),
      revokeSession: jest.fn().mockResolvedValue(undefined),
      revokeAllSessionsForAdmin: jest.fn().mockResolvedValue(undefined),
      revokeAllSessionsExcept: jest.fn().mockResolvedValue(0),
      createRefreshToken: jest.fn().mockResolvedValue(undefined),
      findRefreshTokenByHash: jest.fn(),
      rotateRefreshToken: jest.fn().mockResolvedValue(undefined),
      deleteExpiredRefreshTokens: jest.fn(),
    };

    passwords = {
      hash: jest.fn().mockResolvedValue('dummy-hash'),
      compare: jest.fn(),
    };

    tokens = {
      generateAccessToken: jest.fn().mockResolvedValue('access-token'),
      generateRefreshToken: jest.fn().mockResolvedValue({
        token: 'refresh-token',
        expiresAt: new Date(Date.now() + 604_800_000),
      }),
      verifyAccessToken: jest.fn(),
      verifyRefreshToken: jest.fn(),
    };

    const config = {
      getOrThrow: jest.fn((key: string) =>
        key === 'jwt.accessExpiresIn' ? '15m' : '7d',
      ),
    } as unknown as ConfigService;

    activityLog = { record: jest.fn().mockResolvedValue(undefined) };

    settings = {
      getSessionTimeoutMinutes: jest.fn().mockResolvedValue(10080),
    };

    media = {
      uploadImage: jest.fn(),
      deleteAsset: jest.fn().mockResolvedValue(undefined),
    };

    service = new AuthService(
      repository as unknown as AuthRepository,
      passwords as unknown as PasswordService,
      tokens as unknown as TokenService,
      config,
      activityLog as unknown as ActivityLogService,
      settings as unknown as SettingsService,
      media as unknown as MediaService,
    );

    await service.onModuleInit();
  });

  describe('login', () => {
    it('returns tokens and the admin profile on success', async () => {
      repository.findAdminByEmail.mockResolvedValue(ADMIN);
      passwords.compare.mockResolvedValue(true);

      const result = await service.login({
        email: ADMIN.email,
        password: 'Admin123!',
      });

      expect(result.accessToken).toBe('access-token');
      expect(result.refreshToken).toBe('refresh-token');
      expect(result.expiresIn).toBe(900);
      expect(result.admin.email).toBe(ADMIN.email);
      expect(result.admin.permissions).toEqual([
        'users.manage',
        'roles.manage',
      ]);
    });

    it('creates a session before issuing tokens', async () => {
      repository.findAdminByEmail.mockResolvedValue(ADMIN);
      passwords.compare.mockResolvedValue(true);

      await service.login({ email: ADMIN.email, password: 'Admin123!' });

      expect(repository.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ adminId: ADMIN.id }),
      );
    });

    // D-10: the session timeout is a real duration, not a toggle. If this
    // stopped being read, the settings field would go back to being a number
    // nothing acts on.
    it('expires the session after the configured session timeout', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-06T00:00:00.000Z'));

      repository.findAdminByEmail.mockResolvedValue(ADMIN);
      passwords.compare.mockResolvedValue(true);
      settings.getSessionTimeoutMinutes.mockResolvedValue(30);

      await service.login({ email: ADMIN.email, password: 'Admin123!' });

      const calls = repository.createSession.mock.calls as Array<
        [{ expiresAt: Date }]
      >;

      expect(calls[0]?.[0]?.expiresAt.toISOString()).toBe(
        '2026-08-06T00:30:00.000Z',
      );

      jest.useRealTimers();
    });

    it('falls back to the refresh window when settings cannot be read', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-06T00:00:00.000Z'));

      repository.findAdminByEmail.mockResolvedValue(ADMIN);
      passwords.compare.mockResolvedValue(true);
      settings.getSessionTimeoutMinutes.mockRejectedValue(
        new Error('settings unavailable'),
      );

      // The fallback path deliberately warns; keep the suite output readable.
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      await service.login({ email: ADMIN.email, password: 'Admin123!' });

      const calls = repository.createSession.mock.calls as Array<
        [{ expiresAt: Date }]
      >;

      // jwt.refreshExpiresIn is mocked to '7d'.
      expect(calls[0]?.[0]?.expiresAt.toISOString()).toBe(
        '2026-08-13T00:00:00.000Z',
      );
      expect(warn).toHaveBeenCalled();

      warn.mockRestore();
      jest.useRealTimers();
    });

    it('stores the refresh token as a hash, never in plaintext', async () => {
      repository.findAdminByEmail.mockResolvedValue(ADMIN);
      passwords.compare.mockResolvedValue(true);

      await service.login({ email: ADMIN.email, password: 'Admin123!' });

      const calls = repository.createRefreshToken.mock.calls as Array<
        [{ tokenHash: string }]
      >;
      const stored = calls[0]?.[0];

      expect(stored?.tokenHash).toBe(hashToken('refresh-token'));
      expect(stored?.tokenHash).not.toBe('refresh-token');
    });

    it('binds the token to the session id', async () => {
      repository.findAdminByEmail.mockResolvedValue(ADMIN);
      passwords.compare.mockResolvedValue(true);

      await service.login({ email: ADMIN.email, password: 'Admin123!' });

      const calls = tokens.generateAccessToken.mock.calls as Array<
        [{ sid: string }]
      >;

      expect(calls[0]?.[0]?.sid).toBe(SESSION.id);
    });

    it('lowercases and trims the email before lookup', async () => {
      repository.findAdminByEmail.mockResolvedValue(ADMIN);
      passwords.compare.mockResolvedValue(true);

      await service.login({
        email: '  ADMIN@BJSpades.com  ',
        password: 'Admin123!',
      });

      expect(repository.findAdminByEmail).toHaveBeenCalledWith(
        'admin@bjspades.com',
      );
    });

    it('throws on an unknown email', async () => {
      repository.findAdminByEmail.mockResolvedValue(null);

      await expect(
        service.login({ email: 'nobody@x.com', password: 'whatever' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('still runs a password comparison for an unknown email', async () => {
      // Equal-time failure; otherwise response timing enumerates valid admins.
      repository.findAdminByEmail.mockResolvedValue(null);

      await expect(
        service.login({ email: 'nobody@x.com', password: 'whatever' }),
      ).rejects.toThrow();

      expect(passwords.compare).toHaveBeenCalledTimes(1);
    });

    it('throws on a wrong password', async () => {
      repository.findAdminByEmail.mockResolvedValue(ADMIN);
      passwords.compare.mockResolvedValue(false);

      await expect(
        service.login({ email: ADMIN.email, password: 'wrong' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('uses the same message for unknown email and wrong password', async () => {
      repository.findAdminByEmail.mockResolvedValue(null);
      const unknown = await service
        .login({ email: 'nobody@x.com', password: 'x' })
        .catch((error: Error) => error.message);

      repository.findAdminByEmail.mockResolvedValue(ADMIN);
      passwords.compare.mockResolvedValue(false);
      const wrongPassword = await service
        .login({ email: ADMIN.email, password: 'x' })
        .catch((error: Error) => error.message);

      expect(unknown).toBe(wrongPassword);
    });

    it('rejects a deactivated account only after the password checks out', async () => {
      repository.findAdminByEmail.mockResolvedValue({
        ...ADMIN,
        isActive: false,
      });
      passwords.compare.mockResolvedValue(true);

      await expect(
        service.login({ email: ADMIN.email, password: 'Admin123!' }),
      ).rejects.toThrow('Your account has been deactivated.');
    });

    it('does not create a session when the password is wrong', async () => {
      repository.findAdminByEmail.mockResolvedValue(ADMIN);
      passwords.compare.mockResolvedValue(false);

      await expect(
        service.login({ email: ADMIN.email, password: 'wrong' }),
      ).rejects.toThrow();

      expect(repository.createSession).not.toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    const validPayload = {
      sub: ADMIN.id,
      email: ADMIN.email,
      role: 'SUPER_ADMIN',
      roleId: 'role-1',
      sid: SESSION.id,
    };

    const activeStored = {
      id: 'token-1',
      adminId: ADMIN.id,
      sessionId: SESSION.id,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 3_600_000),
      session: { id: SESSION.id, isActive: true, revokedAt: null },
    };

    it('rotates the token on success', async () => {
      tokens.verifyRefreshToken.mockResolvedValue(validPayload);
      repository.findRefreshTokenByHash.mockResolvedValue(activeStored);
      repository.findAdminById.mockResolvedValue(ADMIN);

      const result = await service.refresh('old-token');

      expect(result.accessToken).toBe('access-token');
      expect(repository.rotateRefreshToken).toHaveBeenCalledWith(
        expect.objectContaining({ currentTokenId: 'token-1' }),
      );
    });

    it('rejects a token that fails signature verification', async () => {
      tokens.verifyRefreshToken.mockRejectedValue(new Error('bad signature'));

      await expect(service.refresh('forged')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(repository.findRefreshTokenByHash).not.toHaveBeenCalled();
    });

    it('rejects a signed token that is not in the database', async () => {
      tokens.verifyRefreshToken.mockResolvedValue(validPayload);
      repository.findRefreshTokenByHash.mockResolvedValue(null);

      await expect(service.refresh('ghost')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('revokes the whole session when a rotated token is replayed', async () => {
      tokens.verifyRefreshToken.mockResolvedValue(validPayload);
      repository.findRefreshTokenByHash.mockResolvedValue({
        ...activeStored,
        revokedAt: new Date(),
      });

      await expect(service.refresh('replayed')).rejects.toThrow(
        /security reasons/i,
      );

      expect(repository.revokeSession).toHaveBeenCalledWith(SESSION.id);
      expect(repository.rotateRefreshToken).not.toHaveBeenCalled();
    });

    it('rejects an expired token', async () => {
      tokens.verifyRefreshToken.mockResolvedValue(validPayload);
      repository.findRefreshTokenByHash.mockResolvedValue({
        ...activeStored,
        expiresAt: new Date(Date.now() - 1_000),
      });

      await expect(service.refresh('stale')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a token whose session was revoked', async () => {
      tokens.verifyRefreshToken.mockResolvedValue(validPayload);
      repository.findRefreshTokenByHash.mockResolvedValue({
        ...activeStored,
        session: { id: SESSION.id, isActive: false, revokedAt: new Date() },
      });

      await expect(service.refresh('orphan')).rejects.toThrow(
        /no longer active/i,
      );
    });

    it('rejects when the payload session does not match the stored session', async () => {
      tokens.verifyRefreshToken.mockResolvedValue({
        ...validPayload,
        sid: 'someone-elses-session',
      });
      repository.findRefreshTokenByHash.mockResolvedValue(activeStored);

      await expect(service.refresh('mismatched')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('revokes the session when the admin has been deactivated', async () => {
      tokens.verifyRefreshToken.mockResolvedValue(validPayload);
      repository.findRefreshTokenByHash.mockResolvedValue(activeStored);
      repository.findAdminById.mockResolvedValue({
        ...ADMIN,
        isActive: false,
      });

      await expect(service.refresh('token')).rejects.toThrow(
        /no longer active/i,
      );
      expect(repository.revokeSession).toHaveBeenCalledWith(SESSION.id);
    });
  });

  describe('logout', () => {
    it('revokes the given session', async () => {
      await service.logout('session-9');
      expect(repository.revokeSession).toHaveBeenCalledWith('session-9');
    });
  });

  describe('logoutAll', () => {
    it('revokes every session except the caller’s', async () => {
      await service.logoutAll('admin-1', 'session-current');

      expect(repository.revokeAllSessionsForAdmin).toHaveBeenCalledWith(
        'admin-1',
        'session-current',
      );
    });
  });

  describe('me', () => {
    it('returns the profile with resolved permissions', async () => {
      repository.getAdminProfile.mockResolvedValue({
        ...ADMIN,
        lastLogin: null,
        createdAt: new Date(),
      });

      const result = await service.me(ADMIN.id);

      expect(result.fullName).toBe('Super Admin');
      expect(result.permissions).toEqual(['users.manage', 'roles.manage']);
    });

    it('never returns the password hash', async () => {
      repository.getAdminProfile.mockResolvedValue({
        ...ADMIN,
        lastLogin: null,
        createdAt: new Date(),
      });

      const result = await service.me(ADMIN.id);

      expect(JSON.stringify(result)).not.toContain('hashed-password');
    });

    it('throws when the admin no longer exists', async () => {
      repository.getAdminProfile.mockResolvedValue(null);

      await expect(service.me('gone')).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('updateProfile', () => {
    const IMAGE = { buffer: Buffer.from('x'), mimetype: 'image/png' };

    it('refuses an image and removeAvatar together', async () => {
      await expect(
        service.updateProfile('admin-1', { removeAvatar: true }, IMAGE),
      ).rejects.toThrow(BadRequestException);

      // Nothing was uploaded, so nothing needs cleaning up.
      expect(media.uploadImage).not.toHaveBeenCalled();
    });

    it('uploads to the avatars folder with each edge bounded at 512px', async () => {
      repository.findAdminById.mockResolvedValue({
        id: 'admin-1',
        avatarId: null,
      });
      media.uploadImage.mockResolvedValue({ id: 'asset-new' });

      await service.updateProfile('admin-1', {}, IMAGE);

      expect(media.uploadImage).toHaveBeenCalledWith(
        IMAGE,
        'avatars',
        'admin-1',
        { maxEdge: 512, fit: 'cover' },
      );
      expect(repository.updateAdminProfile).toHaveBeenCalledWith('admin-1', {
        avatarId: 'asset-new',
      });
    });

    it('deletes the previous asset only after the row points at the new one', async () => {
      repository.findAdminById.mockResolvedValue({
        id: 'admin-1',
        avatarId: 'asset-old',
      });
      media.uploadImage.mockResolvedValue({ id: 'asset-new' });

      const order: string[] = [];
      repository.updateAdminProfile.mockImplementation(() => {
        order.push('update');
        return Promise.resolve();
      });
      media.deleteAsset.mockImplementation(() => {
        order.push('delete');
        return Promise.resolve();
      });

      await service.updateProfile('admin-1', {}, IMAGE);

      expect(order).toEqual(['update', 'delete']);
      expect(media.deleteAsset).toHaveBeenCalledWith('asset-old');
    });

    it('cleans up the new asset when the row update fails', async () => {
      repository.findAdminById.mockResolvedValue({
        id: 'admin-1',
        avatarId: null,
      });
      media.uploadImage.mockResolvedValue({ id: 'asset-new' });
      repository.updateAdminProfile.mockRejectedValue(new Error('db down'));

      await expect(service.updateProfile('admin-1', {}, IMAGE)).rejects.toThrow(
        'db down',
      );

      // Otherwise every failed save leaks a file nothing references.
      expect(media.deleteAsset).toHaveBeenCalledWith('asset-new');
    });

    it('clears the relation and deletes the file on removeAvatar', async () => {
      repository.findAdminById.mockResolvedValue({
        id: 'admin-1',
        avatarId: 'asset-old',
      });

      await service.updateProfile('admin-1', { removeAvatar: true });

      expect(repository.updateAdminProfile).toHaveBeenCalledWith('admin-1', {
        avatarId: null,
      });
      expect(media.deleteAsset).toHaveBeenCalledWith('asset-old');
    });

    it('does not touch storage when removeAvatar is sent but there is no avatar', async () => {
      repository.findAdminById.mockResolvedValue({
        id: 'admin-1',
        avatarId: null,
      });

      await service.updateProfile('admin-1', { removeAvatar: true });

      expect(media.deleteAsset).not.toHaveBeenCalled();
    });
  });

  describe('changePassword', () => {
    const STORED_HASH = 'stored-hash';

    beforeEach(() => {
      repository.findAdminById.mockResolvedValue({
        id: 'admin-1',
        password: STORED_HASH,
      });
      repository.revokeAllSessionsForAdmin.mockResolvedValue(3);
    });

    it('rejects a wrong current password with 401', async () => {
      passwords.compare.mockResolvedValue(false);

      await expect(
        service.changePassword('admin-1', 'session-1', {
          currentPassword: 'wrong',
          newPassword: 'BrandNew123!',
        }),
      ).rejects.toThrow(UnauthorizedException);

      expect(repository.updateAdminPassword).not.toHaveBeenCalled();
      // A failed attempt must not sign anybody out.
      expect(repository.revokeAllSessionsForAdmin).not.toHaveBeenCalled();
    });

    it('rejects a new password identical to the current one', async () => {
      passwords.compare.mockResolvedValue(true);

      await expect(
        service.changePassword('admin-1', 'session-1', {
          currentPassword: 'Same12345!',
          newPassword: 'Same12345!',
        }),
      ).rejects.toThrow(BadRequestException);

      expect(repository.updateAdminPassword).not.toHaveBeenCalled();
    });

    it('stores a hash, never the plaintext', async () => {
      passwords.compare.mockResolvedValue(true);
      passwords.hash.mockResolvedValue('new-hash');

      await service.changePassword('admin-1', 'session-1', {
        currentPassword: 'Old12345!',
        newPassword: 'BrandNew123!',
      });

      expect(passwords.hash).toHaveBeenCalledWith('BrandNew123!');
      expect(repository.updateAdminPassword).toHaveBeenCalledWith(
        'admin-1',
        'new-hash',
      );
    });

    it('revokes the other sessions and spares the current one', async () => {
      passwords.compare.mockResolvedValue(true);
      passwords.hash.mockResolvedValue('new-hash');

      const result = await service.changePassword('admin-1', 'session-1', {
        currentPassword: 'Old12345!',
        newPassword: 'BrandNew123!',
      });

      expect(repository.revokeAllSessionsForAdmin).toHaveBeenCalledWith(
        'admin-1',
        'session-1',
      );
      expect(result).toEqual({ sessionsEnded: 3 });
    });
  });
});
