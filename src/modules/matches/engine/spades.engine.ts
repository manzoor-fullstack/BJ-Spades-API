import { randomInt } from 'node:crypto';

import {
  RANKS,
  SPADES_RULES_V1,
  SPADES_RULESET_VERSION,
  SUITS,
  type Card,
  type PublicSpadesState,
  type Rank,
  type Seat,
  type SpadesBid,
  type SpadesState,
  type Suit,
  type Team,
  type TrickPlay,
} from './spades.types';

export class SpadesRuleError extends Error {}

function asSeat(value: number): Seat {
  if (!Number.isInteger(value) || value < 0 || value > 3) {
    throw new SpadesRuleError('Seat must be between 0 and 3.');
  }
  return value as Seat;
}

function nextSeat(seat: Seat): Seat {
  return asSeat((seat + 1) % 4);
}

function teamForSeat(seat: Seat): Team {
  return (seat % 2) as Team;
}

function suitOf(card: Card): Suit {
  return card.slice(-1) as Suit;
}

function rankOf(card: Card): Rank {
  return card.slice(0, -1) as Rank;
}

function rankValue(card: Card): number {
  return RANKS.indexOf(rankOf(card));
}

export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push(`${rank}${suit}`);
  }
  return deck;
}

export function shuffleDeck(deck: readonly Card[] = createDeck()): Card[] {
  const shuffled = [...deck];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapWith = randomInt(index + 1);
    [shuffled[index], shuffled[swapWith]] = [
      shuffled[swapWith]!,
      shuffled[index]!,
    ];
  }
  return shuffled;
}

function validateDeck(deck: readonly Card[]): void {
  const standard = new Set(createDeck());
  if (
    deck.length !== standard.size ||
    new Set(deck).size !== standard.size ||
    deck.some((card) => !standard.has(card))
  ) {
    throw new SpadesRuleError(
      'A deal requires each standard card exactly once.',
    );
  }
}

function deal(deck: readonly Card[], dealerSeat: Seat): Card[][] {
  validateDeck(deck);
  const hands: Card[][] = [[], [], [], []];
  let seat = nextSeat(dealerSeat);
  for (const card of deck) {
    hands[seat]!.push(card);
    seat = nextSeat(seat);
  }
  return hands;
}

export function createSpadesState(
  deck: readonly Card[] = shuffleDeck(),
  dealerSeat: Seat = 0,
): SpadesState {
  return {
    rulesVersion: SPADES_RULESET_VERSION,
    version: 1,
    phase: 'BIDDING',
    handNumber: 1,
    dealerSeat,
    currentSeat: nextSeat(dealerSeat),
    spadesBroken: false,
    bids: [null, null, null, null],
    hands: deal(deck, dealerSeat),
    currentTrick: [],
    tricksWon: [0, 0, 0, 0],
    teamScores: [0, 0],
    teamBags: [0, 0],
    timeoutCounts: [0, 0, 0, 0],
    winnerTeam: null,
  };
}

function assertTurn(state: SpadesState, seat: Seat): void {
  if (state.currentSeat !== seat) {
    throw new SpadesRuleError(`It is seat ${state.currentSeat}'s turn.`);
  }
}

export function placeBid(
  state: SpadesState,
  seat: Seat,
  bid: SpadesBid,
): SpadesState {
  if (state.phase !== 'BIDDING') {
    throw new SpadesRuleError('Bidding is closed.');
  }
  assertTurn(state, seat);
  if (!Number.isInteger(bid.amount) || bid.amount < 0 || bid.amount > 13) {
    throw new SpadesRuleError('Bid must be a whole number from 0 to 13.');
  }
  if (bid.blindNil && bid.amount !== 0) {
    throw new SpadesRuleError('Blind nil requires a zero bid.');
  }
  if (state.bids[seat]) {
    throw new SpadesRuleError('This seat has already bid.');
  }

  const bids = [...state.bids];
  bids[seat] = { ...bid };
  const complete = bids.every((entry) => entry !== null);
  return {
    ...state,
    version: state.version + 1,
    phase: complete ? 'PLAYING' : state.phase,
    bids,
    currentSeat: complete ? nextSeat(state.dealerSeat) : nextSeat(seat),
  };
}

export function legalCards(state: SpadesState, seat: Seat): Card[] {
  if (state.phase !== 'PLAYING' || state.currentSeat !== seat) return [];
  const hand = state.hands[seat] ?? [];
  const lead = state.currentTrick[0];
  if (lead) {
    const leadSuit = suitOf(lead.card);
    const following = hand.filter((card) => suitOf(card) === leadSuit);
    return following.length > 0 ? following : [...hand];
  }
  if (state.spadesBroken) return [...hand];
  const nonSpades = hand.filter((card) => suitOf(card) !== 'S');
  return nonSpades.length > 0 ? nonSpades : [...hand];
}

export function trickWinner(trick: readonly TrickPlay[]): Seat {
  if (trick.length !== 4) {
    throw new SpadesRuleError('A completed trick must contain four plays.');
  }
  const leadSuit = suitOf(trick[0]!.card);
  return trick.slice(1).reduce((winner, play) => {
    const winnerSuit = suitOf(winner.card);
    const playSuit = suitOf(play.card);
    if (playSuit === 'S' && winnerSuit !== 'S') return play;
    if (playSuit !== winnerSuit) return winner;
    if (
      playSuit === winnerSuit &&
      rankValue(play.card) > rankValue(winner.card)
    ) {
      return play;
    }
    if (
      winnerSuit !== 'S' &&
      playSuit === leadSuit &&
      winnerSuit !== leadSuit
    ) {
      return play;
    }
    return winner;
  }, trick[0]!).seat;
}

function scoreTeam(
  team: Team,
  bids: readonly (SpadesBid | null)[],
  tricksWon: readonly number[],
  score: number,
  bags: number,
): { score: number; bags: number } {
  const seats = team === 0 ? ([0, 2] as const) : ([1, 3] as const);
  const teamBids = seats.map((seat) => bids[seat]!);
  const teamTricks = seats.reduce<number>(
    (total, seat) => total + tricksWon[seat]!,
    0,
  );
  const contract = teamBids.reduce(
    (total, bid) => total + (bid.amount === 0 ? 0 : bid.amount),
    0,
  );
  const madeContract = teamTricks >= contract;
  const overtricks = madeContract ? teamTricks - contract : 0;
  let nextScore =
    score + (madeContract ? contract * 10 + overtricks : -contract * 10);
  let nextBags = bags + overtricks;

  for (const seat of seats) {
    const bid = bids[seat]!;
    if (bid.amount !== 0) continue;
    const madeNil = tricksWon[seat] === 0;
    const bonus = bid.blindNil
      ? SPADES_RULES_V1.blindNilBonus
      : SPADES_RULES_V1.nilBonus;
    nextScore += madeNil ? bonus : -bonus;
  }

  while (nextBags >= SPADES_RULES_V1.bagPenaltyAt) {
    nextBags -= SPADES_RULES_V1.bagPenaltyAt;
    nextScore -= SPADES_RULES_V1.bagPenalty;
  }
  return { score: nextScore, bags: nextBags };
}

function startNextHand(state: SpadesState, deck: readonly Card[]): SpadesState {
  const dealerSeat = nextSeat(state.dealerSeat);
  return {
    ...state,
    version: state.version,
    phase: 'BIDDING',
    handNumber: state.handNumber + 1,
    dealerSeat,
    currentSeat: nextSeat(dealerSeat),
    spadesBroken: false,
    bids: [null, null, null, null],
    hands: deal(deck, dealerSeat),
    currentTrick: [],
    tricksWon: [0, 0, 0, 0],
  };
}

function finishHand(
  state: SpadesState,
  nextDeck: readonly Card[],
): SpadesState {
  const team0 = scoreTeam(
    0,
    state.bids,
    state.tricksWon,
    state.teamScores[0]!,
    state.teamBags[0]!,
  );
  const team1 = scoreTeam(
    1,
    state.bids,
    state.tricksWon,
    state.teamScores[1]!,
    state.teamBags[1]!,
  );
  const teamScores = [team0.score, team1.score];
  const teamBags = [team0.bags, team1.bags];
  const reachedTarget = teamScores.some(
    (score) => score >= SPADES_RULES_V1.winningScore,
  );
  if (reachedTarget && teamScores[0] !== teamScores[1]) {
    const winnerTeam = teamScores[0]! > teamScores[1]! ? 0 : 1;
    return {
      ...state,
      version: state.version,
      phase: 'COMPLETED',
      currentSeat: null,
      currentTrick: [],
      teamScores,
      teamBags,
      winnerTeam,
    };
  }
  return startNextHand({ ...state, teamScores, teamBags }, nextDeck);
}

export function playCard(
  state: SpadesState,
  seat: Seat,
  card: Card,
  nextDeck: readonly Card[] = shuffleDeck(),
): SpadesState {
  if (state.phase !== 'PLAYING') {
    throw new SpadesRuleError('Cards cannot be played in the current phase.');
  }
  assertTurn(state, seat);
  if (!state.hands[seat]?.includes(card)) {
    throw new SpadesRuleError('The card is not in this seat’s hand.');
  }
  if (!legalCards(state, seat).includes(card)) {
    throw new SpadesRuleError('The selected card is not legal for this trick.');
  }

  const hands = state.hands.map((hand, index) =>
    index === seat ? hand.filter((entry) => entry !== card) : [...hand],
  );
  const currentTrick = [...state.currentTrick, { seat, card }];
  const spadesBroken = state.spadesBroken || suitOf(card) === 'S';
  if (currentTrick.length < 4) {
    return {
      ...state,
      version: state.version + 1,
      hands,
      currentTrick,
      spadesBroken,
      currentSeat: nextSeat(seat),
    };
  }

  const winner = trickWinner(currentTrick);
  const tricksWon = [...state.tricksWon];
  tricksWon[winner] = tricksWon[winner]! + 1;
  const completedHand = hands.every((hand) => hand.length === 0);
  const afterTrick: SpadesState = {
    ...state,
    version: state.version + 1,
    hands,
    currentTrick: [],
    tricksWon,
    spadesBroken,
    currentSeat: winner,
  };
  return completedHand ? finishHand(afterTrick, nextDeck) : afterTrick;
}

export function forfeitMatch(state: SpadesState, seat: Seat): SpadesState {
  if (state.phase === 'COMPLETED' || state.phase === 'FORFEITED') {
    throw new SpadesRuleError('The match has already ended.');
  }
  return {
    ...state,
    version: state.version + 1,
    phase: 'FORFEITED',
    currentSeat: null,
    winnerTeam: teamForSeat(seat) === 0 ? 1 : 0,
  };
}

export function applyTurnTimeout(
  state: SpadesState,
  nextDeck: readonly Card[] = shuffleDeck(),
): SpadesState {
  const timedOutSeat = state.currentSeat;
  if (timedOutSeat === null) {
    throw new SpadesRuleError('The match has no active turn.');
  }
  const timeoutCounts = [...state.timeoutCounts];
  timeoutCounts[timedOutSeat] = timeoutCounts[timedOutSeat]! + 1;
  if (timeoutCounts[timedOutSeat] >= SPADES_RULES_V1.maxTimeoutsBeforeForfeit) {
    return {
      ...forfeitMatch(state, timedOutSeat),
      timeoutCounts,
    };
  }
  if (state.phase === 'BIDDING') {
    return {
      ...placeBid(state, timedOutSeat, { amount: 1, blindNil: false }),
      timeoutCounts,
    };
  }
  if (state.phase === 'PLAYING') {
    const card = legalCards(state, timedOutSeat)[0];
    if (!card)
      throw new SpadesRuleError('The timed-out seat has no legal card.');
    return {
      ...playCard(state, timedOutSeat, card, nextDeck),
      timeoutCounts,
    };
  }
  throw new SpadesRuleError('The match has already ended.');
}

export function publicStateForSeat(
  state: SpadesState,
  seat: Seat,
  includeHand = true,
): PublicSpadesState {
  return {
    rulesVersion: state.rulesVersion,
    version: state.version,
    phase: state.phase,
    handNumber: state.handNumber,
    dealerSeat: state.dealerSeat,
    currentSeat: state.currentSeat,
    spadesBroken: state.spadesBroken,
    bids: state.bids.map((bid) => (bid ? { ...bid } : null)),
    cardCounts: state.hands.map((hand) => hand.length),
    hand: includeHand ? [...(state.hands[seat] ?? [])] : [],
    currentTrick: state.currentTrick.map((play) => ({ ...play })),
    tricksWon: [...state.tricksWon],
    teamScores: [...state.teamScores],
    teamBags: [...state.teamBags],
    timeoutCounts: [...state.timeoutCounts],
    winnerTeam: state.winnerTeam,
  };
}
