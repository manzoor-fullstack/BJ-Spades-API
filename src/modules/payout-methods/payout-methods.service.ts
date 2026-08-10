import { Injectable, NotFoundException } from '@nestjs/common';

import { buildPaginationMeta } from '../../common/dto/pagination.dto';
import type { Paginated } from '../../common/interceptors/transform.interceptor';

import {
  ConnectPayoutMethodDto,
  QueryPayoutMethodsDto,
} from './dto/payout-method.dto';
import { PayoutMethodsRepository } from './repositories/payout-methods.repository';
import type { MethodAccountWithUser } from './repositories/payout-methods.repository';
import { toPayoutMethodAccountItem } from './serializers/payout-method.serializer';
import type { PayoutMethodAccountItem } from './serializers/payout-method.serializer';

@Injectable()
export class PayoutMethodsService {
  constructor(private readonly repository: PayoutMethodsRepository) {}

  async findAll(
    query: QueryPayoutMethodsDto,
  ): Promise<Paginated<PayoutMethodAccountItem[]>> {
    const filter = {
      search: query.search?.trim() ? query.search.trim() : undefined,
      method: query.method,
      userId: query.userId,
    };

    const [accounts, total] = await Promise.all([
      this.repository.findMany({ filter, skip: query.skip, take: query.take }),
      this.repository.count(filter),
    ]);

    return {
      data: accounts.map(toPayoutMethodAccountItem),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  async connect(dto: ConnectPayoutMethodDto): Promise<PayoutMethodAccountItem> {
    return toPayoutMethodAccountItem(
      await this.repository.upsert({
        userId: dto.userId,
        method: dto.method,
        label: dto.label?.trim() || null,
        reference: dto.reference.trim(),
        isVerified: dto.isVerified ?? false,
      }),
    );
  }

  async setDefault(id: string): Promise<PayoutMethodAccountItem> {
    const account = await this.getOrThrow(id);

    return toPayoutMethodAccountItem(
      await this.repository.setDefault(id, account.userId),
    );
  }

  async setVerified(
    id: string,
    isVerified: boolean,
  ): Promise<PayoutMethodAccountItem> {
    await this.getOrThrow(id);

    return toPayoutMethodAccountItem(
      await this.repository.setVerified(id, isVerified),
    );
  }

  async disconnect(id: string): Promise<{ id: string }> {
    await this.getOrThrow(id);

    return this.repository.delete(id);
  }

  private async getOrThrow(id: string): Promise<MethodAccountWithUser> {
    const account = await this.repository.findById(id);

    if (!account) {
      throw new NotFoundException(`Payout method ${id} not found`);
    }

    return account;
  }
}
