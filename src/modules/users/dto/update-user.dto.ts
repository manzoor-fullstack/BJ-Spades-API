import { OmitType, PartialType } from '@nestjs/swagger';

import { CreateUserDto } from './create-user.dto';

/**
 * Every create field is optional here EXCEPT the ones that have their own
 * endpoint.
 *
 * `initialBalance` is omitted because money only ever moves through
 * `POST /users/:id/balance/adjust`, which demands a reason and refuses to go
 * below zero. `status` is not editable here either — suspend and activate are
 * separate routes — and `source` is set once at creation and is the only thing
 * distinguishing an admin-created user from a webhook-created one, so it is
 * immutable by design. With `forbidNonWhitelisted` on the global pipe, sending
 * any of the three returns 400 rather than being silently dropped.
 */
export class UpdateUserDto extends PartialType(
  OmitType(CreateUserDto, ['initialBalance'] as const),
) {}
