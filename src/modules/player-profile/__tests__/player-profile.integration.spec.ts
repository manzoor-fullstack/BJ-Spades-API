import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';

import { createTestApp } from '../../../../test/create-test-app';
import { testPrisma } from '../../../../test/setup';
import { PlayerEmailService } from '../../player-auth/services/player-email.service';

const ORIGIN = 'http://127.0.0.1:4173';

class CapturingEmailService {
  token = '';

  verification(_email: string, token: string): Promise<void> {
    this.token = token;
    return Promise.resolve();
  }

  passwordReset(): Promise<void> {
    return Promise.resolve();
  }
}

function cookieValue(response: request.Response, name: string): string {
  const values = response.headers['set-cookie'] as
    string | string[] | undefined;
  const cookies = Array.isArray(values) ? values : values ? [values] : [];
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Missing ${name} cookie`);
  return decodeURIComponent(cookie.split(';', 1)[0]!.slice(name.length + 1));
}

describe('Player profile API (integration)', () => {
  let app: INestApplication;
  const email = new CapturingEmailService();

  beforeAll(async () => {
    app = await createTestApp({
      overrides: [{ provide: PlayerEmailService, useValue: email }],
    });
  });

  afterAll(async () => app?.close());

  const server = (): Server => app.getHttpServer() as Server;

  async function signedInPlayer() {
    const agent = request.agent(server());
    await agent
      .post('/api/player/v1/auth/register')
      .set('Origin', ORIGIN)
      .send({
        username: 'profile_player',
        email: 'profile@example.com',
        password: 'StrongPass123',
      })
      .expect(202);
    await agent
      .post('/api/player/v1/auth/verify-email')
      .set('Origin', ORIGIN)
      .send({ token: email.token })
      .expect(200);
    const login = await agent
      .post('/api/player/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({
        email: 'profile@example.com',
        password: 'StrongPass123',
        rememberMe: false,
      })
      .expect(200);
    return { agent, csrf: cookieValue(login, 'bjs_player_csrf') };
  }

  it('requires an authenticated player', async () => {
    await request(server()).get('/api/player/v1/me/profile').expect(401);
  });

  it('loads defaults, saves owned fields, and keeps account email immutable', async () => {
    const { agent, csrf } = await signedInPlayer();
    const initial = await agent.get('/api/player/v1/me/profile').expect(200);
    const initialBody = initial.body as { data: Record<string, unknown> };
    expect(initialBody.data).toMatchObject({
      username: 'profile_player',
      displayName: 'profile_player',
      email: 'profile@example.com',
      avatarName: 'Poppa Cool',
      avatarBackground: '#fbbf24',
    });

    const updated = await agent
      .patch('/api/player/v1/me/profile')
      .set('Origin', ORIGIN)
      .set('x-csrf-token', csrf)
      .send({
        username: 'table_champion',
        displayName: 'Table Champion',
        tagline: 'Play smart',
        firstName: 'Table',
        lastName: 'Champion',
        phone: '+1 555 000 4444',
        dateOfBirth: '1991-06-15',
        location: 'Atlanta, GA',
        twitter: '@tablechampion',
      })
      .expect(200);

    const updatedBody = updated.body as { data: Record<string, unknown> };
    expect(updatedBody.data).toMatchObject({
      username: 'table_champion',
      displayName: 'Table Champion',
      firstName: 'Table',
      lastName: 'Champion',
      email: 'profile@example.com',
      dateOfBirth: '1991-06-15',
    });
    const stored = await testPrisma.user.findUniqueOrThrow({
      where: { email: 'profile@example.com' },
      include: { credential: true, playerProfile: true },
    });
    expect(stored.credential?.username).toBe('table_champion');
    expect(stored.playerProfile?.twitter).toBe('@tablechampion');

    await agent
      .patch('/api/player/v1/me/profile')
      .set('Origin', ORIGIN)
      .set('x-csrf-token', csrf)
      .send({ email: 'attacker@example.com', tier: 'LEGEND' })
      .expect(400);
    expect(
      await testPrisma.user.findUnique({
        where: { email: 'attacker@example.com' },
      }),
    ).toBeNull();
  });

  it('requires CSRF for updates', async () => {
    const { agent } = await signedInPlayer();
    await agent
      .patch('/api/player/v1/me/profile')
      .set('Origin', ORIGIN)
      .send({ displayName: 'Blocked' })
      .expect(403);
  });
});
