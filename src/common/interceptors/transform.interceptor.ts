import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';

import { PaginationMeta } from '../dto/pagination.dto';

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  meta?: PaginationMeta;
}

/** A service returning this shape gets its `meta` hoisted into the envelope. */
export interface Paginated<T> {
  data: T;
  meta: PaginationMeta;
}

function isPaginated(value: unknown): value is Paginated<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    'meta' in value &&
    typeof (value as { meta: unknown }).meta === 'object' &&
    (value as { meta: unknown }).meta !== null &&
    'total' in (value as { meta: object }).meta
  );
}

/**
 * Wraps every successful response in the standard envelope:
 *
 *   { success: true, data: ... }
 *   { success: true, data: [...], meta: { page, limit, total, totalPages } }
 *
 * See docs/01-ARCHITECTURE.md ADR-006.
 */
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<
  T,
  SuccessEnvelope<unknown>
> {
  intercept(
    _context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<SuccessEnvelope<unknown>> {
    return next.handle().pipe(
      map((value): SuccessEnvelope<unknown> => {
        if (isPaginated(value)) {
          return { success: true, data: value.data, meta: value.meta };
        }

        return { success: true, data: value ?? null };
      }),
    );
  }
}
