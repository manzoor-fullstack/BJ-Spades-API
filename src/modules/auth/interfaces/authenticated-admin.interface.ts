export interface AuthenticatedAdmin {
  id: string;
  email: string;
  role: string;
  roleId: string;
  /** Session this request is authenticated against. */
  sessionId: string;
}
