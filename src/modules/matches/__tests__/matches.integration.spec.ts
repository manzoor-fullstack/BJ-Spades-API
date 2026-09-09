import type { INestApplication } from '@nestjs/common';
import { GameCommandType, Prisma } from '@prisma/client';
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

interface MatchState {
  version: number;
  phase: 'BIDDING' | 'PLAYING' | 'COMPLETED' | 'FORFEITED';
  currentSeat: number | null;
  hand: string[];
  bids: Array<{ amount: number; blindNil: boolean } | null>;
  cardCounts: number[];
  currentTrick: Array<{ seat: number; card: string }>;
  timeoutCounts: number[];
  winnerTeam: number | null;
}

interface MatchBody {
  id: string;
  seat: number;
  team: number;
  duplicate?: boolean;
  entryToken?: string;
  state: MatchState;
  players: Array<{ id: string; seat: number; team: number }>;
}

type Seat = 0 | 1 | 2 | 3;

describe('Player matches API (integration)', () => {
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
    const address = `f07-${suffix}@example.com`;
    await agent
      .post('/api/player/v1/auth/register')
      .set('Origin', ORIGIN)
      .send({
        username: `f07_${suffix}`,
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

  async function join(
    player: Awaited<ReturnType<typeof signedInPlayer>>,
    matchId: string,
  ) {
    const response = await player.agent
      .post(`/api/player/v1/matches/${matchId}/join`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', player.csrf)
      .expect(201);
    const body = responseData<MatchBody>(response);
    expect(body.entryToken).toBeTruthy();
    return body.entryToken!;
  }

  async function command(
    player: Awaited<ReturnType<typeof signedInPlayer>>,
    matchId: string,
    entryToken: string,
    body: Record<string, unknown>,
    status = 201,
  ) {
    return player.agent
      .post(`/api/player/v1/matches/${matchId}/commands`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', player.csrf)
      .set('x-game-entry-token', entryToken)
      .send(body)
      .expect(status);
  }

  it('serializes four players, protects every hand, and deduplicates commands', async () => {
    // Player-auth already owns concurrency coverage. Keep this feature's setup
    // sequential so its assertions isolate match concurrency and ordering.
    const creator = await signedInPlayer('creator');
    const east = await signedInPlayer('east');
    const north = await signedInPlayer('north');
    const west = await signedInPlayer('west');
    const players = [creator, east, north, west] as const;
    const outsider = await signedInPlayer('outsider');
    const requestId = crypto.randomUUID();
    const createdResponse = await players[0].agent
      .post('/api/player/v1/matches')
      .set('Origin', ORIGIN)
      .set('x-csrf-token', players[0].csrf)
      .send({
        requestId,
        opponentIds: players.slice(1).map((player) => player.user.id),
      })
      .expect(201);
    const created = responseData<MatchBody>(createdResponse);
    expect(created.players).toHaveLength(4);
    expect(created.state.hand).toEqual([]);
    expect(created.state.cardCounts).toEqual([13, 13, 13, 13]);

    const duplicateCreate = responseData<MatchBody>(
      await players[0].agent
        .post('/api/player/v1/matches')
        .set('Origin', ORIGIN)
        .set('x-csrf-token', players[0].csrf)
        .send({
          requestId,
          opponentIds: players.slice(1).map((player) => player.user.id),
        })
        .expect(201),
    );
    expect(duplicateCreate.id).toBe(created.id);
    await outsider.agent
      .post(`/api/player/v1/matches/${created.id}/join`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', outsider.csrf)
      .expect(404);

    const tokens = await Promise.all([
      join(players[0], created.id),
      join(players[1], created.id),
      join(players[2], created.id),
      join(players[3], created.id),
    ]);
    const rotatedToken = await join(players[0], created.id);
    await players[0].agent
      .get(`/api/player/v1/matches/${created.id}`)
      .set('x-game-entry-token', tokens[0])
      .expect(401);
    tokens[0] = rotatedToken;
    await testPrisma.gameSeat.update({
      where: {
        matchId_userId: { matchId: created.id, userId: players[3].user.id },
      },
      data: { entryTokenExpiresAt: new Date(Date.now() - 1000) },
    });
    await players[3].agent
      .get(`/api/player/v1/matches/${created.id}`)
      .set('x-game-entry-token', tokens[3])
      .expect(401);
    tokens[3] = await join(players[3], created.id);
    const hidden = responseData<MatchBody>(
      await players[1].agent
        .get(`/api/player/v1/matches/${created.id}`)
        .set('x-game-entry-token', tokens[1])
        .expect(200),
    );
    expect(hidden.state.hand).toEqual([]);

    const revealed = responseData<MatchBody>(
      await players[1].agent
        .post(`/api/player/v1/matches/${created.id}/reveal-hand`)
        .set('Origin', ORIGIN)
        .set('x-csrf-token', players[1].csrf)
        .set('x-game-entry-token', tokens[1])
        .expect(201),
    );
    expect(revealed.state.hand).toHaveLength(13);
    expect(revealed.state).not.toHaveProperty('hands');

    await command(
      players[1],
      created.id,
      tokens[1],
      {
        idempotencyKey: crypto.randomUUID(),
        expectedVersion: 1,
        type: GameCommandType.BID,
        bid: 0,
        blindNil: true,
      },
      422,
    );

    const firstCommandId = crypto.randomUUID();
    const firstBidInput = {
      idempotencyKey: firstCommandId,
      expectedVersion: 1,
      type: GameCommandType.BID,
      bid: 3,
      blindNil: false,
    };
    const firstBid = responseData<MatchBody>(
      await command(players[1], created.id, tokens[1], firstBidInput),
    );
    expect(firstBid).toMatchObject({ duplicate: false });
    expect(firstBid.state.version).toBe(2);

    const duplicateBid = responseData<MatchBody>(
      await command(players[1], created.id, tokens[1], firstBidInput),
    );
    expect(duplicateBid).toMatchObject({ duplicate: true });
    expect(duplicateBid.state.version).toBe(2);
    await command(
      players[2],
      created.id,
      tokens[2],
      {
        idempotencyKey: crypto.randomUUID(),
        expectedVersion: 1,
        type: GameCommandType.BID,
        bid: 3,
      },
      409,
    );

    let version = 2;
    for (const seat of [2, 3, 0] as const) {
      const result = responseData<MatchBody>(
        await command(players[seat], created.id, tokens[seat], {
          idempotencyKey: crypto.randomUUID(),
          expectedVersion: version,
          type: GameCommandType.BID,
          bid: 3,
        }),
      );
      version = result.state.version;
    }
    expect(version).toBe(5);

    const views = await Promise.all([
      ...players.map(async (player, index) =>
        responseData<MatchBody>(
          await player.agent
            .get(`/api/player/v1/matches/${created.id}`)
            .set('x-game-entry-token', tokens[index]!)
            .expect(200),
        ),
      ),
    ]);
    expect(views.every((view) => view.state.phase === 'PLAYING')).toBe(true);
    expect(views.every((view) => view.state.hand.length === 13)).toBe(true);
    expect(new Set(views.flatMap((view) => view.state.hand)).size).toBe(52);

    const leader = views.find((view) => view.seat === view.state.currentSeat)!;
    const leadCard = leader.state.hand.find((card) => !card.endsWith('S'))!;
    const leadPlayerIndex = leader.seat as Seat;
    const played = responseData<MatchBody>(
      await command(
        players[leadPlayerIndex],
        created.id,
        tokens[leadPlayerIndex],
        {
          idempotencyKey: crypto.randomUUID(),
          expectedVersion: version,
          type: GameCommandType.PLAY_CARD,
          card: leadCard,
        },
      ),
    );
    expect(played.state.version).toBe(6);
    expect(played.state.currentTrick).toContainEqual({
      seat: leader.seat,
      card: leadCard,
    });

    await command(
      players[0],
      created.id,
      tokens[0],
      {
        idempotencyKey: crypto.randomUUID(),
        expectedVersion: 6,
        type: GameCommandType.CLAIM_TIMEOUT,
      },
      409,
    );
    await testPrisma.gameMatch.update({
      where: { id: created.id },
      data: { actionDeadlineAt: new Date(Date.now() - 1000) },
    });
    const timedOut = responseData<MatchBody>(
      await command(players[0], created.id, tokens[0], {
        idempotencyKey: crypto.randomUUID(),
        expectedVersion: 6,
        type: GameCommandType.CLAIM_TIMEOUT,
      }),
    );
    expect(timedOut.state.version).toBe(7);
    expect(timedOut.state.timeoutCounts[2]).toBe(1);

    const events = responseData<Array<{ sequence: number; payload: unknown }>>(
      await players[0].agent
        .get(`/api/player/v1/matches/${created.id}/events?after=0`)
        .set('x-game-entry-token', tokens[0])
        .expect(200),
    );
    expect(events.map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(JSON.stringify(events)).not.toContain(views[0]!.state.hand[1]);

    const persisted = await testPrisma.gameMatch.findUniqueOrThrow({
      where: { id: created.id },
      select: { state: true },
    });
    await testPrisma.gameMatch.update({
      where: { id: created.id },
      data: {
        state: {
          ...(persisted.state as Prisma.JsonObject),
          teamScores: [1000, 0],
        },
      },
    });

    let game = responseData<MatchBody>(
      await players[0].agent
        .get(`/api/player/v1/matches/${created.id}`)
        .set('x-game-entry-token', tokens[0])
        .expect(200),
    );
    let remainingPlays = 0;
    while (game.state.phase === 'PLAYING') {
      const activeSeat = game.state.currentSeat as Seat;
      const activeView = responseData<MatchBody>(
        await players[activeSeat].agent
          .get(`/api/player/v1/matches/${created.id}`)
          .set('x-game-entry-token', tokens[activeSeat])
          .expect(200),
      );
      const leadSuit = activeView.state.currentTrick[0]?.card.at(-1);
      const legal = leadSuit
        ? (activeView.state.hand.find((card) => card.endsWith(leadSuit)) ??
          activeView.state.hand[0])
        : (activeView.state.hand.find((card) => !card.endsWith('S')) ??
          activeView.state.hand[0]);
      if (!legal) throw new Error('The active seat has no card to play.');
      game = responseData<MatchBody>(
        await command(players[activeSeat], created.id, tokens[activeSeat], {
          idempotencyKey: crypto.randomUUID(),
          expectedVersion: activeView.state.version,
          type: GameCommandType.PLAY_CARD,
          card: legal,
        }),
      );
      remainingPlays += 1;
      if (remainingPlays > 50) {
        throw new Error(
          'The API match did not finish after the remaining cards.',
        );
      }
    }
    expect(remainingPlays).toBe(50);
    expect(game.state).toMatchObject({
      phase: 'COMPLETED',
      currentSeat: null,
      winnerTeam: 0,
      version: 57,
    });

    const forfeitMatch = responseData<MatchBody>(
      await players[0].agent
        .post('/api/player/v1/matches')
        .set('Origin', ORIGIN)
        .set('x-csrf-token', players[0].csrf)
        .send({
          requestId: crypto.randomUUID(),
          opponentIds: players.slice(1).map((player) => player.user.id),
        })
        .expect(201),
    );
    const forfeitToken = await join(players[0], forfeitMatch.id);
    const forfeited = responseData<MatchBody>(
      await command(players[0], forfeitMatch.id, forfeitToken, {
        idempotencyKey: crypto.randomUUID(),
        expectedVersion: 1,
        type: GameCommandType.FORFEIT,
      }),
    );
    expect(forfeited.state).toMatchObject({
      phase: 'FORFEITED',
      currentSeat: null,
      winnerTeam: 1,
    });
    await players[0].agent
      .post(`/api/player/v1/matches/${created.id}/join`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', players[0].csrf)
      .expect(409);
  });
});
