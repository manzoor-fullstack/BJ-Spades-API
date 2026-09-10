import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  ItemStatus,
  LessonDifficulty,
  LessonProgressStatus,
  Prisma,
  UserTier,
} from '@prisma/client';
import type { Server } from 'node:http';
import request from 'supertest';

import { createTestApp } from '../../../test/create-test-app';
import { testPrisma } from '../../../test/setup';
import { PlayerEmailService } from '../player-auth/services/player-email.service';

const ORIGIN = 'http://127.0.0.1:4173';

class EmailCapture {
  tokens = new Map<string, string>();
  verification(email: string, token: string) {
    this.tokens.set(email, token);
    return Promise.resolve();
  }
  passwordReset() {
    return Promise.resolve();
  }
}

function cookie(response: request.Response, name: string) {
  const raw = (
    response.headers as Record<string, string[] | string | undefined>
  )['set-cookie'];
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const value = rows.find((row) => row.startsWith(`${name}=`));
  if (!value) throw new Error(`Missing ${name}`);
  return value.split(';')[0]!.slice(name.length + 1);
}

function data<T>(response: request.Response): T {
  return (response.body as { data: T }).data;
}

describe('Player learning API (integration)', () => {
  let app: INestApplication;
  const emails = new EmailCapture();
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    app = await createTestApp({
      overrides: [{ provide: PlayerEmailService, useValue: emails }],
    });
  });
  afterAll(async () => app?.close());

  async function player(label: string, tier: UserTier = UserTier.PLAYER) {
    const agent = request.agent(server());
    const safeLabel = label.replace(/[^a-z0-9]/gi, '').slice(0, 10);
    const email = `learning-${label}-${randomUUID().slice(0, 7)}@example.com`;
    await agent
      .post('/api/player/v1/auth/register')
      .set('Origin', ORIGIN)
      .send({
        username: `learn_${safeLabel}_${randomUUID().slice(0, 7)}`,
        email,
        password: 'StrongPass123',
      })
      .expect(202);
    await agent
      .post('/api/player/v1/auth/verify-email')
      .set('Origin', ORIGIN)
      .send({ token: emails.tokens.get(email) })
      .expect(200);
    const login = await agent
      .post('/api/player/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email, password: 'StrongPass123', rememberMe: false })
      .expect(200);
    const user = await testPrisma.user.findUniqueOrThrow({ where: { email } });
    await testPrisma.user.update({ where: { id: user.id }, data: { tier } });
    return { agent, user, csrf: cookie(login, 'bjs_player_csrf') };
  }

  async function lesson(requiredTier: UserTier = UserTier.PLAYER) {
    return testPrisma.lesson.create({
      data: {
        slug: `lesson-${randomUUID()}`,
        title: `Lesson ${randomUUID().slice(0, 5)}`,
        description: 'A server-owned Spades lesson.',
        durationMinutes: 12,
        difficulty: LessonDifficulty.BEGINNER,
        moduleCount: 3,
        mediaUrl: '/lessons/spades-basics.png',
        requiredTier,
        status: ItemStatus.ACTIVE,
        content: [
          { title: 'One', body: 'First section.' },
          { title: 'Two', body: 'Second section.' },
          { title: 'Three', body: 'Final section.' },
        ] as Prisma.InputJsonValue,
      },
    });
  }

  function start(owner: Awaited<ReturnType<typeof player>>, lessonId: string) {
    return owner.agent
      .post(`/api/player/v1/me/learning/${lessonId}/start`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', owner.csrf);
  }

  function advance(
    owner: Awaited<ReturnType<typeof player>>,
    lessonId: string,
    sectionIndex: number,
  ) {
    return owner.agent
      .post(`/api/player/v1/me/learning/${lessonId}/progress`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', owner.csrf)
      .send({ sectionIndex });
  }

  it('persists ordered progress and completes idempotently with zero XP', async () => {
    const owner = await player('owner');
    const item = await lesson();
    const transactionsBefore = await testPrisma.transaction.count({
      where: { userId: owner.user.id },
    });

    const started = data<{
      sections: unknown[];
      progress: { percent: number };
      xpAward: number;
    }>(await start(owner, item.id).expect(201));
    expect(started.sections).toHaveLength(3);
    expect(started.progress.percent).toBe(0);
    expect(started.xpAward).toBe(0);
    await advance(owner, item.id, 1).expect(201);
    const completed = data<{
      progress: { status: string; percent: number; completedAt: string };
    }>(await advance(owner, item.id, 2).expect(201));
    expect(completed.progress).toEqual(
      expect.objectContaining({ status: 'COMPLETED', percent: 100 }),
    );
    const completedAt = completed.progress.completedAt;
    const repeated = data<{ progress: { completedAt: string } }>(
      await advance(owner, item.id, 2).expect(201),
    );
    expect(repeated.progress.completedAt).toBe(completedAt);

    const reloaded = data<{ progress: { status: string; percent: number } }>(
      await owner.agent.get(`/api/player/v1/lessons/${item.id}`).expect(200),
    );
    expect(reloaded.progress).toEqual(
      expect.objectContaining({ status: 'COMPLETED', percent: 100 }),
    );
    expect(
      await testPrisma.transaction.count({ where: { userId: owner.user.id } }),
    ).toBe(transactionsBefore);
  });

  it('keeps progress private and rejects skipped or unstarted sections', async () => {
    const owner = await player('private-owner');
    const stranger = await player('private-stranger');
    const item = await lesson();
    await start(owner, item.id).expect(201);
    await advance(owner, item.id, 2).expect(409);
    await advance(stranger, item.id, 0).expect(409);

    const ownerCatalog = data<
      Array<{ id: string; progress: { status: string } }>
    >(await owner.agent.get('/api/player/v1/lessons').expect(200));
    const strangerCatalog = data<
      Array<{ id: string; progress: { status: string } }>
    >(await stranger.agent.get('/api/player/v1/lessons').expect(200));
    expect(
      ownerCatalog.find((row) => row.id === item.id)?.progress.status,
    ).toBe('IN_PROGRESS');
    expect(
      strangerCatalog.find((row) => row.id === item.id)?.progress.status,
    ).toBe('NOT_STARTED');
  });

  it('enforces access tiers and hides inactive lessons', async () => {
    const playerOnly = await player('locked');
    const premium = await player('premium', UserTier.PREMIUM);
    const locked = await lesson(UserTier.PREMIUM);
    const catalog = data<
      Array<{ id: string; locked: boolean; mediaUrl: string }>
    >(await playerOnly.agent.get('/api/player/v1/lessons').expect(200));
    expect(catalog).toContainEqual(
      expect.objectContaining({
        id: locked.id,
        locked: true,
        mediaUrl: '/lessons/spades-basics.png',
      }),
    );
    await start(playerOnly, locked.id).expect(403);
    await start(premium, locked.id).expect(201);
    await testPrisma.lesson.update({
      where: { id: locked.id },
      data: { status: ItemStatus.INACTIVE },
    });
    await premium.agent.get(`/api/player/v1/lessons/${locked.id}`).expect(404);
    const after = data<Array<{ id: string }>>(
      await premium.agent.get('/api/player/v1/lessons').expect(200),
    );
    expect(after.some((row) => row.id === locked.id)).toBe(false);
  });

  it('resets stale progress when lesson content changes', async () => {
    const owner = await player('version');
    const item = await lesson();
    await start(owner, item.id).expect(201);
    await advance(owner, item.id, 1).expect(201);
    await testPrisma.lesson.update({
      where: { id: item.id },
      data: { contentVersion: 2 },
    });
    const restarted = data<{
      contentVersion: number;
      progress: { status: string; currentSection: number };
    }>(await start(owner, item.id).expect(201));
    expect(restarted.contentVersion).toBe(2);
    expect(restarted.progress).toEqual(
      expect.objectContaining({ status: 'IN_PROGRESS', currentSection: 0 }),
    );
    const stored = await testPrisma.lessonProgress.findUniqueOrThrow({
      where: { userId_lessonId: { userId: owner.user.id, lessonId: item.id } },
    });
    expect(stored.status).toBe(LessonProgressStatus.IN_PROGRESS);
    expect(stored.contentVersion).toBe(2);
  });
});
