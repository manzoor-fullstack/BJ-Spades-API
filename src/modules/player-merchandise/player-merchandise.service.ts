import { createHash } from 'node:crypto';

import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { formatMoney } from '../../common/money/money.util';
import type { CreateMerchandiseClaimDto } from './dto/create-merchandise-claim.dto';
import {
  toPlayerMerchandise,
  toPlayerShipment,
} from './player-merchandise.serializer';
import { PlayerMerchandiseRepository } from './repositories/player-merchandise.repository';

@Injectable()
export class PlayerMerchandiseService {
  constructor(private readonly repository: PlayerMerchandiseRepository) {}

  async catalog() {
    return (await this.repository.listCatalog()).map(toPlayerMerchandise);
  }

  async list(userId: string) {
    return (await this.repository.listOwned(userId)).map(toPlayerShipment);
  }

  async create(userId: string, dto: CreateMerchandiseClaimDto) {
    const normalized = {
      merchandiseId: dto.merchandiseId,
      variantId: dto.variantId,
      shippingName: dto.shippingName.trim(),
      addressLine1: dto.addressLine1.trim(),
      addressLine2: dto.addressLine2?.trim() || null,
      city: dto.city.trim(),
      state: dto.state?.trim() || '',
      postalCode: dto.postalCode.trim(),
      country: dto.country.trim(),
    };
    const payloadHash = createHash('sha256')
      .update(JSON.stringify(normalized))
      .digest('hex');
    const result = await this.repository.create(userId, {
      ...normalized,
      requestId: dto.requestId,
      payloadHash,
    });

    switch (result.outcome) {
      case 'CREATED':
        return toPlayerShipment(result.shipment);
      case 'EXISTING':
        if (result.shipment.payloadHash !== payloadHash) {
          throw new UnprocessableEntityException(
            'This requestId was already used for a different merchandise claim.',
          );
        }
        return toPlayerShipment(result.shipment);
      case 'INSUFFICIENT_BALANCE':
        throw new UnprocessableEntityException(
          `Insufficient balance. Available: ${formatMoney(result.balance)} tokens.`,
        );
      case 'VARIANT_MISMATCH':
        throw new UnprocessableEntityException(
          'The selected variant does not belong to this product.',
        );
      case 'PLAYER_NOT_FOUND':
        throw new NotFoundException('Player not found.');
      case 'PRODUCT_UNAVAILABLE':
        throw new ConflictException(
          'This merchandise item is no longer available.',
        );
    }
  }

  async cancel(userId: string, id: string) {
    const row = await this.repository.cancelOwned(userId, id);
    if (!row) {
      const existing = await this.repository.findOwned(userId, id);
      if (!existing) throw new NotFoundException('Shipment not found.');
      throw new ConflictException('Only pending shipments can be cancelled.');
    }
    return toPlayerShipment(row);
  }
}
