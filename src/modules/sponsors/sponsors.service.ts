import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { buildPaginationMeta } from '../../common/dto/pagination.dto';
import type { Paginated } from '../../common/interceptors/transform.interceptor';

import {
  CreateSponsorDto,
  QuerySponsorsDto,
  UpdateSponsorDto,
} from './dto/sponsor.dto';
import { SponsorsRepository } from './repositories/sponsors.repository';
import type { SponsorData } from './repositories/sponsors.repository';
import { toSponsorListItem } from './serializers/sponsor.serializer';
import type { SponsorListItem } from './serializers/sponsor.serializer';

@Injectable()
export class SponsorsService {
  constructor(private readonly repository: SponsorsRepository) {}

  async findAll(
    query: QuerySponsorsDto,
  ): Promise<Paginated<SponsorListItem[]>> {
    const filter = {
      search: query.search?.trim() ? query.search.trim() : undefined,
      status: query.status,
    };

    const [sponsors, total] = await Promise.all([
      this.repository.findMany({ filter, skip: query.skip, take: query.take }),
      this.repository.count(filter),
    ]);

    return {
      data: sponsors.map(toSponsorListItem),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  async findOne(id: string): Promise<SponsorListItem> {
    return toSponsorListItem(await this.getOrThrow(id));
  }

  async create(dto: CreateSponsorDto): Promise<SponsorListItem> {
    return toSponsorListItem(await this.repository.create(this.toData(dto)));
  }

  async update(id: string, dto: UpdateSponsorDto): Promise<SponsorListItem> {
    await this.getOrThrow(id);

    const data: Partial<SponsorData> = {};

    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.prizeDescription !== undefined) {
      data.prizeDescription = dto.prizeDescription.trim();
    }
    // Money is converted through a string, never a float: `new Decimal(0.1 +
    // 0.2)` is not 0.3, and a sponsorship value is a figure someone invoices.
    if (dto.value !== undefined) {
      data.value = new Prisma.Decimal(dto.value.toFixed(2));
    }
    if (dto.splitType !== undefined) data.splitType = dto.splitType.trim();
    if (dto.contactEmail !== undefined) {
      data.contactEmail = dto.contactEmail.trim();
    }
    if (dto.status !== undefined) data.status = dto.status;

    return toSponsorListItem(await this.repository.update(id, data));
  }

  async remove(id: string): Promise<{ id: string; name: string }> {
    const sponsor = await this.getOrThrow(id);

    await this.repository.delete(id);

    return { id: sponsor.id, name: sponsor.name };
  }

  private toData(dto: CreateSponsorDto): SponsorData {
    return {
      name: dto.name.trim(),
      prizeDescription: dto.prizeDescription.trim(),
      value: new Prisma.Decimal(dto.value.toFixed(2)),
      splitType: dto.splitType.trim(),
      contactEmail: dto.contactEmail.trim(),
      status: dto.status,
    };
  }

  private async getOrThrow(id: string) {
    const sponsor = await this.repository.findById(id);

    if (!sponsor) throw new NotFoundException(`Sponsor ${id} not found`);

    return sponsor;
  }
}
