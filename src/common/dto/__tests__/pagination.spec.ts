import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  DEFAULT_LIMIT,
  DEFAULT_PAGE,
  MAX_LIMIT,
  PaginationQueryDto,
  SortOrder,
  buildPaginationMeta,
  resolveSortField,
} from '../pagination.dto';

describe('buildPaginationMeta', () => {
  it('computes totalPages by rounding up', () => {
    expect(buildPaginationMeta(147, 1, 20)).toEqual({
      page: 1,
      limit: 20,
      total: 147,
      totalPages: 8,
    });
  });

  it('returns 1 page when the total exactly fills it', () => {
    expect(buildPaginationMeta(20, 1, 20).totalPages).toBe(1);
  });

  it('returns 0 pages for an empty result set', () => {
    expect(buildPaginationMeta(0, 1, 20).totalPages).toBe(0);
  });

  it('does not divide by zero when limit is 0', () => {
    expect(buildPaginationMeta(10, 1, 0).totalPages).toBe(0);
  });
});

describe('resolveSortField', () => {
  const allowed = ['createdAt', 'email', 'balance'] as const;

  it('accepts an allowlisted field', () => {
    expect(resolveSortField('email', allowed, 'createdAt')).toBe('email');
  });

  it('falls back when the field is not allowlisted', () => {
    expect(resolveSortField('password', allowed, 'createdAt')).toBe(
      'createdAt',
    );
  });

  // sortBy is interpolated into a Prisma orderBy key; an unchecked value is an
  // injection vector.
  it('rejects an SQL injection attempt', () => {
    expect(
      resolveSortField('id; DROP TABLE users;--', allowed, 'createdAt'),
    ).toBe('createdAt');
  });
});

describe('PaginationQueryDto', () => {
  const transform = (query: Record<string, unknown>) =>
    plainToInstance(PaginationQueryDto, query, {
      enableImplicitConversion: true,
    });

  it('applies defaults when nothing is supplied', () => {
    const dto = transform({});

    expect(dto.page).toBe(DEFAULT_PAGE);
    expect(dto.limit).toBe(DEFAULT_LIMIT);
    expect(dto.sortOrder).toBe(SortOrder.DESC);
    expect(dto.sortBy).toBe('createdAt');
  });

  it('coerces numeric strings from the query string', async () => {
    const dto = transform({ page: '3', limit: '50' });

    expect(dto.page).toBe(3);
    expect(dto.limit).toBe(50);
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('computes skip from page and limit', () => {
    const dto = transform({ page: '3', limit: '10' });
    expect(dto.skip).toBe(20);
    expect(dto.take).toBe(10);
  });

  it('skip is 0 on the first page', () => {
    expect(transform({ page: '1', limit: '20' }).skip).toBe(0);
  });

  it(`rejects a limit above ${MAX_LIMIT}`, async () => {
    const errors = await validate(transform({ limit: '500' }));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.constraints).toHaveProperty('max');
  });

  it('rejects a page below 1', async () => {
    const errors = await validate(transform({ page: '0' }));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.constraints).toHaveProperty('min');
  });

  it('rejects an unknown sortOrder', async () => {
    const errors = await validate(transform({ sortOrder: 'sideways' }));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.constraints).toHaveProperty('isEnum');
  });
});
