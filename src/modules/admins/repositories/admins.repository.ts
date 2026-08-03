import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class AdminsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.AdminCreateInput) {
    return this.prisma.admin.create({
      data,
      include: {
        role: true,
      },
    });
  }

  findById(id: string) {
    return this.prisma.admin.findUnique({
      where: { id },
      include: {
        role: true,
      },
    });
  }

  findByEmail(email: string) {
    return this.prisma.admin.findUnique({
      where: { email },
      include: {
        role: true,
      },
    });
  }

  findAll() {
    return this.prisma.admin.findMany({
      include: {
        role: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  update(id: string, data: Prisma.AdminUpdateInput) {
    return this.prisma.admin.update({
      where: { id },
      data,
      include: {
        role: true,
      },
    });
  }

  delete(id: string) {
    return this.prisma.admin.delete({
      where: { id },
    });
  }
}
