import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PasswordService } from '../../common/password/password.service';
import { RolesService } from '../roles/roles.service';
import { CreateAdminDto } from './dto/create-admin.dto';
import { UpdateAdminDto } from './dto/update-admin.dto';
import { AdminsRepository } from './repositories/admins.repository';

@Injectable()
export class AdminsService {
  constructor(
    private readonly repository: AdminsRepository,
    private readonly passwordService: PasswordService,
    private readonly rolesService: RolesService,
  ) {}

  async create(dto: CreateAdminDto) {
    const existing = await this.repository.findByEmail(dto.email);

    if (existing) {
      throw new ConflictException('Admin email already exists');
    }

    await this.rolesService.findById(dto.roleId);

    const hashedPassword = await this.passwordService.hash(dto.password);

    return this.repository.create({
      firstName: dto.firstName,
      lastName: dto.lastName,
      email: dto.email,
      password: hashedPassword,
      role: {
        connect: {
          id: dto.roleId,
        },
      },
    });
  }

  async findByEmail(email: string) {
    return this.repository.findByEmail(email);
  }

  async findById(id: string) {
    const admin = await this.repository.findById(id);

    if (!admin) {
      throw new NotFoundException('Admin not found');
    }

    return admin;
  }

  async findAll() {
    return this.repository.findAll();
  }

  async update(id: string, dto: UpdateAdminDto) {
    await this.findById(id);

    return this.repository.update(id, dto);
  }

  async remove(id: string) {
    await this.findById(id);

    return this.repository.delete(id);
  }

  async updateLastLogin(id: string) {
    return this.repository.update(id, {
      lastLogin: new Date(),
    });
  }

  async activate(id: string) {
    return this.repository.update(id, {
      isActive: true,
    });
  }

  async deactivate(id: string) {
    return this.repository.update(id, {
      isActive: false,
    });
  }
}
