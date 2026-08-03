import { Request } from 'express';
import { AuthenticatedAdmin } from 'src/modules/auth/interfaces/authenticated-admin.interface';

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedAdmin;
}
