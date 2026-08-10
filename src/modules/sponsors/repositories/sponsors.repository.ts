import { Injectable } from '@nestjs/common';
import { Prisma, Sponsor, SponsorStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

export interface SponsorFilter {
  search?: string;
  status?: SponsorStatus;
}

export interface ListSponsorsArgs {
  filter: SponsorFilter;
  skip: number;
  take: number;
}

export interface SponsorData {
  name: string;
  prizeDescription: string;
  value: Prisma.Decimal;
  splitType: string;
  contactEmail: string;
  status?: SponsorStatus;
}

@Injectable()
export class SponsorsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private buildWhere(filter: SponsorFilter): Prisma.SponsorWhereInput {
    const where: Prisma.SponsorWhereInput = {};

    if (filter.status) where.status = filter.status;

    if (filter.search) {
      const contains: Prisma.StringFilter = {
        contains: filter.search,
        mode: 'insensitive',
      };

      where.OR = [
        { name: contains },
        { prizeDescription: contains },
        { contactEmail: contains },
        { splitType: contains },
      ];
    }

    return where;
  }

  findMany(args: ListSponsorsArgs): Promise<Sponsor[]> {
    return this.prisma.sponsor.findMany({
      where: this.buildWhere(args.filter),
      // Active first, then alphabetical: the list is a roster, and the
      // sponsors currently funding something are the ones being looked for.
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      skip: args.skip,
      take: args.take,
    });
  }

  count(filter: SponsorFilter): Promise<number> {
    return this.prisma.sponsor.count({ where: this.buildWhere(filter) });
  }

  findById(id: string): Promise<Sponsor | null> {
    return this.prisma.sponsor.findUnique({ where: { id } });
  }

  create(data: SponsorData): Promise<Sponsor> {
    return this.prisma.sponsor.create({ data });
  }

  update(id: string, data: Partial<SponsorData>): Promise<Sponsor> {
    return this.prisma.sponsor.update({ where: { id }, data });
  }

  delete(id: string): Promise<Sponsor> {
    return this.prisma.sponsor.delete({ where: { id } });
  }
}
