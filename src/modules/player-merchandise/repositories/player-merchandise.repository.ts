import { Injectable } from '@nestjs/common';
import {
  ItemStatus,
  Prisma,
  ShipmentStatus,
  TransactionStatus,
  TransactionType,
  UserStatus,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { recordLedgerEntry } from '../../transactions/repositories/transactions.repository';

export const PLAYER_MERCHANDISE_INCLUDE = {
  image: true,
  variants: { orderBy: [{ position: 'asc' as const }, { id: 'asc' as const }] },
} satisfies Prisma.MerchandiseInclude;

export const PLAYER_SHIPMENT_INCLUDE = {
  merchandise: { include: { image: true } },
  variant: true,
} satisfies Prisma.ShipmentInclude;

export type PlayerShipmentRow = Prisma.ShipmentGetPayload<{
  include: typeof PLAYER_SHIPMENT_INCLUDE;
}>;

export interface ClaimInput {
  merchandiseId: string;
  variantId: string;
  requestId: string;
  payloadHash: string;
  shippingName: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export type ClaimOutcome =
  | { outcome: 'CREATED' | 'EXISTING'; shipment: PlayerShipmentRow }
  | { outcome: 'PLAYER_NOT_FOUND' | 'PRODUCT_UNAVAILABLE' | 'VARIANT_MISMATCH' }
  | { outcome: 'INSUFFICIENT_BALANCE'; balance: Prisma.Decimal };

class StockRaceError extends Error {}

@Injectable()
export class PlayerMerchandiseRepository {
  constructor(private readonly prisma: PrismaService) {}

  listCatalog() {
    return this.prisma.merchandise.findMany({
      where: {
        deletedAt: null,
        status: ItemStatus.ACTIVE,
        tokenCost: { gt: 0 },
        variants: { some: { stock: { gt: 0 } } },
      },
      include: PLAYER_MERCHANDISE_INCLUDE,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  listOwned(userId: string) {
    return this.prisma.shipment.findMany({
      where: { userId },
      include: PLAYER_SHIPMENT_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 100,
    });
  }

  findOwned(userId: string, id: string) {
    return this.prisma.shipment.findFirst({
      where: { id, userId },
      include: PLAYER_SHIPMENT_INCLUDE,
    });
  }

  async create(userId: string, input: ClaimInput): Promise<ClaimOutcome> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.shipment.findUnique({
          where: { userId_requestId: { userId, requestId: input.requestId } },
          include: PLAYER_SHIPMENT_INCLUDE,
        });
        if (existing)
          return { outcome: 'EXISTING' as const, shipment: existing };

        const merchandise = await tx.merchandise.findFirst({
          where: {
            id: input.merchandiseId,
            deletedAt: null,
            status: ItemStatus.ACTIVE,
            tokenCost: { gt: 0 },
          },
        });
        if (!merchandise) return { outcome: 'PRODUCT_UNAVAILABLE' as const };

        const variant = await tx.merchandiseVariant.findFirst({
          where: { id: input.variantId, merchandiseId: merchandise.id },
        });
        if (!variant) return { outcome: 'VARIANT_MISMATCH' as const };

        const player = await tx.user.findFirst({
          where: { id: userId, status: UserStatus.ACTIVE, deletedAt: null },
          select: { id: true },
        });
        if (!player) return { outcome: 'PLAYER_NOT_FOUND' as const };

        const purchase = await recordLedgerEntry(tx, {
          userId,
          type: TransactionType.MERCHANDISE_PURCHASE,
          amount: merchandise.tokenCost.negated(),
          status: TransactionStatus.COMPLETED,
          reference: `merchandise-purchase:${userId}:${input.requestId}`,
          description: merchandise.name,
        });
        if (purchase.outcome === 'INSUFFICIENT_BALANCE') {
          return {
            outcome: 'INSUFFICIENT_BALANCE' as const,
            balance: purchase.balance,
          };
        }
        if (purchase.outcome !== 'RECORDED') {
          return { outcome: 'PLAYER_NOT_FOUND' as const };
        }

        const reserved = await tx.merchandiseVariant.updateMany({
          where: {
            id: variant.id,
            merchandiseId: merchandise.id,
            stock: { gt: 0 },
          },
          data: { stock: { decrement: 1 } },
        });
        if (reserved.count !== 1) throw new StockRaceError();

        const shipment = await tx.shipment.create({
          data: {
            userId,
            merchandiseId: merchandise.id,
            variantId: variant.id,
            requestId: input.requestId,
            payloadHash: input.payloadHash,
            tokenCost: merchandise.tokenCost,
            purchaseTransactionId: purchase.transaction.id,
            shippingName: input.shippingName,
            addressLine1: input.addressLine1,
            addressLine2: input.addressLine2,
            city: input.city,
            state: input.state,
            postalCode: input.postalCode,
            country: input.country,
          },
          include: PLAYER_SHIPMENT_INCLUDE,
        });
        return { outcome: 'CREATED' as const, shipment };
      });
    } catch (error) {
      if (error instanceof StockRaceError) {
        return { outcome: 'PRODUCT_UNAVAILABLE' };
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.shipment.findUnique({
          where: { userId_requestId: { userId, requestId: input.requestId } },
          include: PLAYER_SHIPMENT_INCLUDE,
        });
        if (existing) return { outcome: 'EXISTING', shipment: existing };
      }
      throw error;
    }
  }

  cancelOwned(userId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.shipment.updateMany({
        where: { id, userId, status: ShipmentStatus.PENDING },
        data: { status: ShipmentStatus.CANCELLED, cancelledAt: new Date() },
      });
      if (claimed.count === 0) return null;

      const row = await tx.shipment.findUniqueOrThrow({ where: { id } });
      if (row.variantId) {
        await tx.merchandiseVariant.update({
          where: { id: row.variantId },
          data: { stock: { increment: 1 } },
        });
      }
      if (row.purchaseTransactionId && !row.refundTransactionId) {
        const refund = await recordLedgerEntry(tx, {
          userId,
          type: TransactionType.REFUND,
          amount: row.tokenCost,
          status: TransactionStatus.COMPLETED,
          reference: `merchandise-refund:${id}`,
          description: 'Cancelled merchandise claim refunded',
        });
        if (refund.outcome !== 'RECORDED') {
          throw new Error(`Merchandise refund failed: ${refund.outcome}`);
        }
        await tx.shipment.update({
          where: { id },
          data: { refundTransactionId: refund.transaction.id },
        });
      }
      return tx.shipment.findUniqueOrThrow({
        where: { id },
        include: PLAYER_SHIPMENT_INCLUDE,
      });
    });
  }
}
