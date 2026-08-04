export interface JwtPayload {
  /** Admin id. */
  sub: string;
  email: string;
  role: string;
  roleId: string;
  /**
   * Session id. Ties the token to a revocable session so logout and refresh
   * know which session they are acting on.
   */
  sid: string;
}
