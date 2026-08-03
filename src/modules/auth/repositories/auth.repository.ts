import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/modules/prisma/prisma.service';

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAdminByEmail(email: string) {
    return this.prisma.admin.findUnique({
      where: {
        email,
      },
      include: {
        role: {
          include: {
            permissions: {
              include: {
                permission: true,
              },
            },
          },
        },
      },
    });
  }

  async findAdminById(id: string) {
    return this.prisma.admin.findUnique({
      where: { id },
      include: {
        role: true,
      },
    });
  }

  async getAdminProfile(id: string) {
    return this.prisma.admin.findUnique({
      where: { id },
      include: {
        role: {
          include: {
            permissions: {
              include: {
                permission: true,
              },
            },
          },
        },
      },
    });
  }

  async updateLastLogin(adminId: string) {
    return this.prisma.admin.update({
      where: {
        id: adminId,
      },
      data: {
        lastLogin: new Date(),
      },
    });
  }

  async createRefreshToken(adminId: string, token: string, expiresAt: Date) {
    return this.prisma.refreshToken.create({
      data: {
        adminId,
        token,
        expiresAt,
      },
    });
  }

  async createSession(
    adminId: string,
    device?: string,
    browser?: string,
    ipAddress?: string,
  ) {
    return this.prisma.session.create({
      data: {
        adminId,
        device,
        browser,
        ipAddress,
      },
    });
  }
}
