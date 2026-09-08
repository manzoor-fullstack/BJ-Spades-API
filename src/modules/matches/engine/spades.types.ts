export const SPADES_RULESET_VERSION = 'spades-partnership-v1' as const;

export const SUITS = ['C', 'D', 'H', 'S'] as const;
export const RANKS = [
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'T',
  'J',
  'Q',
  'K',
  'A',
] as const;

export type Suit = (typeof SUITS)[number];
export type Rank = (typeof RANKS)[number];
export type Card = `${Rank}${Suit}`;
export type Seat = 0 | 1 | 2 | 3;
export type Team = 0 | 1;

export interface SpadesBid {
  amount: number;
  blindNil: boolean;
}

export interface TrickPlay {
  seat: Seat;
  card: Card;
}

export type SpadesPhase = 'BIDDING' | 'PLAYING' | 'COMPLETED' | 'FORFEITED';

export interface SpadesState {
  rulesVersion: typeof SPADES_RULESET_VERSION;
  version: number;
  phase: SpadesPhase;
  handNumber: number;
  dealerSeat: Seat;
  currentSeat: Seat | null;
  spadesBroken: boolean;
  bids: Array<SpadesBid | null>;
  hands: Card[][];
  currentTrick: TrickPlay[];
  tricksWon: number[];
  teamScores: number[];
  teamBags: number[];
  timeoutCounts: number[];
  winnerTeam: Team | null;
}

export interface SpadesRules {
  version: typeof SPADES_RULESET_VERSION;
  playerCount: 4;
  winningScore: number;
  nilBonus: number;
  blindNilBonus: number;
  bagPenaltyAt: number;
  bagPenalty: number;
  turnSeconds: number;
  maxTimeoutsBeforeForfeit: number;
}

export const SPADES_RULES_V1: SpadesRules = {
  version: SPADES_RULESET_VERSION,
  playerCount: 4,
  winningScore: 500,
  nilBonus: 100,
  blindNilBonus: 200,
  bagPenaltyAt: 10,
  bagPenalty: 100,
  turnSeconds: 30,
  maxTimeoutsBeforeForfeit: 3,
};

export interface PublicSpadesState {
  rulesVersion: typeof SPADES_RULESET_VERSION;
  version: number;
  phase: SpadesPhase;
  handNumber: number;
  dealerSeat: Seat;
  currentSeat: Seat | null;
  spadesBroken: boolean;
  bids: Array<SpadesBid | null>;
  cardCounts: number[];
  hand: Card[];
  currentTrick: TrickPlay[];
  tricksWon: number[];
  teamScores: number[];
  teamBags: number[];
  timeoutCounts: number[];
  winnerTeam: Team | null;
}
