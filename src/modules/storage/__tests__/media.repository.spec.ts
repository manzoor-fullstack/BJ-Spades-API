import type { PrismaService } from '../../prisma/prisma.service';
import { MediaRepository } from '../repositories/media.repository';

interface FindManyArgs {
  where: Record<string, unknown>;
}

/**
 * MediaRepository is a thin Prisma wrapper, so the only thing worth asserting is
 * the `where` clause it builds — and for `findOrphans` that clause is the whole
 * safety property. A missing relation there silently deletes images that are
 * still on screen.
 */
describe('MediaRepository.findOrphans', () => {
  let findMany: jest.Mock;
  let repository: MediaRepository;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([]);

    repository = new MediaRepository({
      mediaAsset: { findMany },
    } as unknown as PrismaService);
  });

  const whereClause = (): Record<string, unknown> =>
    (findMany.mock.calls[0] as [FindManyArgs])[0].where;

  it('only considers assets older than the cutoff', async () => {
    const cutoff = new Date('2026-08-01T00:00:00.000Z');

    await repository.findOrphans(cutoff);

    expect(whereClause().createdAt).toEqual({ lt: cutoff });
  });

  it.each(['tournaments', 'rewards', 'merchandise'])(
    'treats an asset referenced by a %s row as still in use',
    async (relation) => {
      await repository.findOrphans(new Date());

      // Phase 5 added rewards and merchandise. Without their clauses every
      // reward icon and product photo looks unreferenced and the cleanup
      // deletes it while it is still being rendered.
      expect(whereClause()[relation]).toEqual({ none: {} });
    },
  );

  it('checks every relation declared on MediaAsset and no fewer', async () => {
    await repository.findOrphans(new Date());

    // Spelled out rather than derived: a new relation added to the schema
    // without a matching clause here is exactly the bug this asserts against,
    // and a derived list would grow with the schema and never fail.
    expect(Object.keys(whereClause()).sort()).toEqual([
      'createdAt',
      'merchandise',
      'rewards',
      'tournaments',
    ]);
  });
});
