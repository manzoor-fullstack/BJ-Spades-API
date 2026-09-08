import {
  applyTurnTimeout,
  createDeck,
  createSpadesState,
  forfeitMatch,
  legalCards,
  placeBid,
  playCard,
  publicStateForSeat,
  SpadesRuleError,
  trickWinner,
} from './spades.engine';
import type { Seat, SpadesState } from './spades.types';

function finishBidding(state: SpadesState, bids = [3, 3, 3, 3]): SpadesState {
  let next = state;
  for (const amount of bids) {
    const seat = next.currentSeat as Seat;
    next = placeBid(next, seat, { amount, blindNil: false });
  }
  return next;
}

describe('authoritative Spades engine', () => {
  it('deals every card once and starts bidding left of the dealer', () => {
    const state = createSpadesState(createDeck(), 0);
    expect(state.currentSeat).toBe(1);
    expect(state.hands.map((hand) => hand.length)).toEqual([13, 13, 13, 13]);
    expect(new Set(state.hands.flat()).size).toBe(52);
  });

  it('rejects out-of-turn and invalid bids then begins play after four bids', () => {
    const state = createSpadesState(createDeck(), 0);
    expect(() => placeBid(state, 2, { amount: 3, blindNil: false })).toThrow(
      SpadesRuleError,
    );
    expect(() => placeBid(state, 1, { amount: 14, blindNil: false })).toThrow(
      'Bid must be a whole number from 0 to 13.',
    );
    const playing = finishBidding(state);
    expect(playing.phase).toBe('PLAYING');
    expect(playing.version).toBe(5);
  });

  it('enforces following suit and prevents an opening spade while another suit remains', () => {
    let state = finishBidding(createSpadesState(createDeck(), 0));
    const leader = state.currentSeat as Seat;
    expect(legalCards(state, leader).every((card) => !card.endsWith('S'))).toBe(
      true,
    );
    const lead = legalCards(state, leader)[0]!;
    state = playCard(state, leader, lead, createDeck());
    expect(state.version).toBe(6);
    const follower = state.currentSeat as Seat;
    const leadSuit = lead.slice(-1);
    const suited = state.hands[follower]!.filter((card) =>
      card.endsWith(leadSuit),
    );
    if (suited.length > 0) {
      const offSuit = state.hands[follower]!.find(
        (card) => !card.endsWith(leadSuit),
      );
      if (offSuit) {
        expect(() => playCard(state, follower, offSuit, createDeck())).toThrow(
          'The selected card is not legal for this trick.',
        );
      }
    }
  });

  it('selects the highest trump, otherwise the highest lead-suit card', () => {
    expect(
      trickWinner([
        { seat: 0, card: 'AH' },
        { seat: 1, card: '2S' },
        { seat: 2, card: 'KH' },
        { seat: 3, card: 'AS' },
      ]),
    ).toBe(3);
    expect(
      trickWinner([
        { seat: 0, card: '9D' },
        { seat: 1, card: 'AD' },
        { seat: 2, card: 'AC' },
        { seat: 3, card: 'TD' },
      ]),
    ).toBe(1);
  });

  it('never exposes another seat hand', () => {
    const state = createSpadesState(createDeck(), 0);
    const view = publicStateForSeat(state, 2);
    expect(view.hand).toEqual(state.hands[2]);
    expect(view).not.toHaveProperty('hands');
    const hiddenCards = state.hands[0]!.filter(
      (card) => !view.hand.includes(card),
    );
    expect(hiddenCards.length).toBeGreaterThan(0);
    expect(JSON.stringify(view)).not.toContain(hiddenCards[0]);
  });

  it('ends a forfeit immediately and awards the opposing partnership', () => {
    const result = forfeitMatch(createSpadesState(createDeck(), 0), 2);
    expect(result).toMatchObject({
      phase: 'FORFEITED',
      currentSeat: null,
      winnerTeam: 1,
    });
  });

  it('applies a deterministic action on timeout and forfeits after three', () => {
    let state = createSpadesState(createDeck(), 0);
    state = applyTurnTimeout(state, createDeck());
    expect(state.bids[1]).toEqual({ amount: 1, blindNil: false });
    expect(state.timeoutCounts[1]).toBe(1);
    state = {
      ...state,
      phase: 'BIDDING',
      currentSeat: 1,
      bids: [null, null, null, null],
    };
    state = applyTurnTimeout(state, createDeck());
    state = {
      ...state,
      phase: 'BIDDING',
      currentSeat: 1,
      bids: [null, null, null, null],
    };
    state = applyTurnTimeout(state, createDeck());
    expect(state.phase).toBe('FORFEITED');
    expect(state.winnerTeam).toBe(0);
  });

  it('rejects a malformed deck', () => {
    const malformed = createDeck();
    malformed[51] = malformed[0]!;
    expect(() => createSpadesState(malformed, 0)).toThrow(
      'A deal requires each standard card exactly once.',
    );
  });

  it('plays an entire hand with legal server moves and completes at the score target', () => {
    let state = finishBidding(createSpadesState(createDeck(), 0), [1, 1, 1, 1]);
    state = { ...state, teamScores: [1000, 0] };
    let plays = 0;
    while (state.phase === 'PLAYING') {
      const seat = state.currentSeat as Seat;
      const card = legalCards(state, seat)[0]!;
      const previousVersion = state.version;
      state = playCard(state, seat, card, createDeck());
      expect(state.version).toBe(previousVersion + 1);
      plays += 1;
      if (plays > 52)
        throw new Error('The hand did not terminate after 52 cards.');
    }
    expect(plays).toBe(52);
    expect(state.phase).toBe('COMPLETED');
    expect(state.winnerTeam).toBe(0);
    expect(state.hands.every((hand) => hand.length === 0)).toBe(true);
  });
});
