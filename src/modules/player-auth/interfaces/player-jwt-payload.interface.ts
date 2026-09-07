export interface PlayerJwtPayload {
  sub: string;
  sid: string;
  email: string;
  type: 'player';
}

export interface AuthenticatedPlayer {
  id: string;
  sessionId: string;
  email: string;
  username: string;
}
