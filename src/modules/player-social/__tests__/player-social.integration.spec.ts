import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';

import { createTestApp } from '../../../../test/create-test-app';
import { testPrisma } from '../../../../test/setup';
import { PlayerEmailService } from '../../player-auth/services/player-email.service';

const ORIGIN = 'http://127.0.0.1:4173';

class CapturingEmailService {
  tokens = new Map<string, string>();
  verification(email: string, token: string) {
    this.tokens.set(email, token);
    return Promise.resolve();
  }
  passwordReset() {
    return Promise.resolve();
  }
}

function cookieValue(response: request.Response, name: string): string {
  const raw = (
    response.headers as Record<string, string | string[] | undefined>
  )['set-cookie'];
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = values.find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Missing ${name} cookie`);
  return cookie.split(';')[0]!.slice(name.length + 1);
}

function responseData<T>(response: request.Response): T {
  return (response.body as { data: T }).data;
}

interface ChallengeBody {
  id: string;
  status: string;
  matchId: string | null;
}

describe('Player social and challenge API (integration)', () => {
  let app: INestApplication;
  const email = new CapturingEmailService();
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    app = await createTestApp({
      overrides: [{ provide: PlayerEmailService, useValue: email }],
    });
  });

  afterAll(async () => app?.close());

  async function signedInPlayer(suffix: string) {
    const agent = request.agent(server());
    const address = `f08-${suffix}@example.com`;
    await agent
      .post('/api/player/v1/auth/register')
      .set('Origin', ORIGIN)
      .send({
        username: `f08_${suffix}`,
        email: address,
        password: 'StrongPass123',
      })
      .expect(202);
    await agent
      .post('/api/player/v1/auth/verify-email')
      .set('Origin', ORIGIN)
      .send({ token: email.tokens.get(address) })
      .expect(200);
    const login = await agent
      .post('/api/player/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: address, password: 'StrongPass123', rememberMe: false })
      .expect(200);
    return {
      agent,
      csrf: cookieValue(login, 'bjs_player_csrf'),
      user: await testPrisma.user.findUniqueOrThrow({
        where: { email: address },
      }),
    };
  }

  async function post(
    player: Awaited<ReturnType<typeof signedInPlayer>>,
    path: string,
    body?: object,
    status = 201,
  ) {
    return player.agent
      .post(`/api/player/v1${path}`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', player.csrf)
      .send(body)
      .expect(status);
  }

  async function makeFriends(
    sender: Awaited<ReturnType<typeof signedInPlayer>>,
    receiver: Awaited<ReturnType<typeof signedInPlayer>>,
  ) {
    const requested = responseData<{ id: string }>(
      await post(sender, '/me/friend-requests', { playerId: receiver.user.id }),
    );
    await post(receiver, `/me/friend-requests/${requested.id}/accept`);
  }

  it('atomically pairs two accepted friend teams into one playable F07 match', async () => {
    const one = await signedInPlayer('one');
    const two = await signedInPlayer('two');
    const three = await signedInPlayer('three');
    const four = await signedInPlayer('four');
    const outsider = await signedInPlayer('outsider');
    await makeFriends(one, two);
    await makeFriends(three, four);
    await Promise.all(
      [one, two, three, four].map((player) =>
        post(player, '/me/presence/heartbeat'),
      ),
    );

    const firstRequestId = crypto.randomUUID();
    const first = responseData<ChallengeBody>(
      await post(one, '/challenges', {
        requestId: firstRequestId,
        friendId: two.user.id,
      }),
    );
    const duplicate = responseData<ChallengeBody>(
      await post(one, '/challenges', {
        requestId: firstRequestId,
        friendId: two.user.id,
      }),
    );
    expect(duplicate.id).toBe(first.id);

    const second = responseData<ChallengeBody>(
      await post(three, '/challenges', {
        requestId: crypto.randomUUID(),
        friendId: four.user.id,
      }),
    );
    await Promise.all([
      post(two, `/challenges/${first.id}/accept`),
      post(four, `/challenges/${second.id}/accept`),
    ]);

    const firstFinal = responseData<ChallengeBody>(
      await one.agent.get(`/api/player/v1/challenges/${first.id}`).expect(200),
    );
    const secondFinal = responseData<ChallengeBody>(
      await three.agent
        .get(`/api/player/v1/challenges/${second.id}`)
        .expect(200),
    );
    expect(firstFinal.status).toBe('MATCHED');
    expect(firstFinal.matchId).toBeTruthy();
    expect(secondFinal.matchId).toBe(firstFinal.matchId);

    const seats = await testPrisma.gameSeat.findMany({
      where: { matchId: firstFinal.matchId! },
      orderBy: { seat: 'asc' },
    });
    expect(seats).toHaveLength(4);
    expect(new Set(seats.map((seat) => seat.userId))).toEqual(
      new Set([one.user.id, two.user.id, three.user.id, four.user.id]),
    );
    const teamByPlayer = new Map(seats.map((seat) => [seat.userId, seat.team]));
    expect(teamByPlayer.get(one.user.id)).toBe(teamByPlayer.get(two.user.id));
    expect(teamByPlayer.get(three.user.id)).toBe(
      teamByPlayer.get(four.user.id),
    );
    expect(teamByPlayer.get(one.user.id)).not.toBe(
      teamByPlayer.get(three.user.id),
    );

    const joined = responseData<{
      entryToken: string;
      state: { phase: string };
    }>(await post(one, `/matches/${firstFinal.matchId}/join`));
    expect(joined.entryToken).toBeTruthy();
    expect(joined.state.phase).toBe('BIDDING');
    await outsider.agent
      .get(`/api/player/v1/challenges/${first.id}`)
      .expect(404);
  });

  it('enforces offline, expiry, decline, cancellation and block rules', async () => {
    const one = await signedInPlayer('policy_one');
    const two = await signedInPlayer('policy_two');
    await makeFriends(one, two);
    await post(one, '/me/presence/heartbeat');
    await post(
      one,
      '/challenges',
      { requestId: crypto.randomUUID(), friendId: two.user.id },
      409,
    );
    await post(two, '/me/presence/heartbeat');

    const expiring = responseData<ChallengeBody>(
      await post(one, '/challenges', {
        requestId: crypto.randomUUID(),
        friendId: two.user.id,
      }),
    );
    await testPrisma.gameChallenge.update({
      where: { id: expiring.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const expired = responseData<ChallengeBody>(
      await one.agent
        .get(`/api/player/v1/challenges/${expiring.id}`)
        .expect(200),
    );
    expect(expired.status).toBe('EXPIRED');

    const declined = responseData<ChallengeBody>(
      await post(one, '/challenges', {
        requestId: crypto.randomUUID(),
        friendId: two.user.id,
      }),
    );
    expect(
      responseData<ChallengeBody>(
        await post(two, `/challenges/${declined.id}/decline`),
      ).status,
    ).toBe('DECLINED');

    const cancelled = responseData<ChallengeBody>(
      await post(one, '/challenges', {
        requestId: crypto.randomUUID(),
        friendId: two.user.id,
      }),
    );
    expect(
      responseData<ChallengeBody>(
        await post(one, `/challenges/${cancelled.id}/cancel`),
      ).status,
    ).toBe('CANCELLED');

    await post(two, `/me/blocks/${one.user.id}`);
    await post(
      one,
      '/challenges',
      { requestId: crypto.randomUUID(), friendId: two.user.id },
      403,
    );
    expect(await testPrisma.playerFriendship.count()).toBe(0);
  });
});
