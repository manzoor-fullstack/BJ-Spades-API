import { Request } from 'express';
import { AuthenticatedAdmin } from './authenticated-admin.interface';

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedAdmin;
}
