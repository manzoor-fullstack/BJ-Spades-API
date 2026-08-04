import { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';

import { TransformInterceptor } from '../transform.interceptor';

describe('TransformInterceptor', () => {
  const interceptor = new TransformInterceptor();
  const context = {} as ExecutionContext;

  const run = <T>(value: T) => {
    const next: CallHandler = { handle: () => of(value) };
    return firstValueFrom(interceptor.intercept(context, next));
  };

  it('wraps an object in the success envelope', async () => {
    await expect(run({ id: '1', name: 'Ada' })).resolves.toEqual({
      success: true,
      data: { id: '1', name: 'Ada' },
    });
  });

  it('wraps an array without treating it as paginated', async () => {
    await expect(run([1, 2, 3])).resolves.toEqual({
      success: true,
      data: [1, 2, 3],
    });
  });

  it('hoists meta when the service returns a paginated shape', async () => {
    const paginated = {
      data: [{ id: '1' }],
      meta: { page: 1, limit: 20, total: 147, totalPages: 8 },
    };

    await expect(run(paginated)).resolves.toEqual({
      success: true,
      data: [{ id: '1' }],
      meta: { page: 1, limit: 20, total: 147, totalPages: 8 },
    });
  });

  it('does not mistake a domain object with a data field for a paginated result', async () => {
    // `meta` here has no `total`, so it must not be hoisted.
    const value = { data: 'payload', meta: { note: 'not pagination' } };

    await expect(run(value)).resolves.toEqual({
      success: true,
      data: value,
    });
  });

  it('normalises undefined to null so the envelope is always well-formed', async () => {
    await expect(run(undefined)).resolves.toEqual({
      success: true,
      data: null,
    });
  });

  it('preserves an explicit null', async () => {
    await expect(run(null)).resolves.toEqual({ success: true, data: null });
  });

  it('preserves falsy primitives rather than nulling them', async () => {
    await expect(run(0)).resolves.toEqual({ success: true, data: 0 });
    await expect(run(false)).resolves.toEqual({ success: true, data: false });
    await expect(run('')).resolves.toEqual({ success: true, data: '' });
  });
});
