import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class PlayerJwtGuard extends AuthGuard('player-jwt') {}
