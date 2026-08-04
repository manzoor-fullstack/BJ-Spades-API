import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { PERMISSION_CODES } from '../../common/constants/permissions';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';

import { AdminsService } from './admins.service';
import { CreateAdminDto } from './dto/create-admin.dto';
import { UpdateAdminDto } from './dto/update-admin.dto';

// PATCH /admins/:id/role does not exist yet (Phase 3). Per
// docs/03-API-CONTRACT.md it requires roles.manage, not admins.manage, so it
// must carry its own decorator rather than inherit a controller-level one —
// which is why the codes are declared per route here.
@ApiTags('admins')
@ApiBearerAuth('access-token')
@Controller('admins')
export class AdminsController {
  constructor(private readonly adminsService: AdminsService) {}

  @RequirePermissions(PERMISSION_CODES.ADMINS_MANAGE)
  @Post()
  create(@Body() dto: CreateAdminDto) {
    return this.adminsService.create(dto);
  }

  @RequirePermissions(PERMISSION_CODES.ADMINS_MANAGE)
  @Get()
  findAll() {
    return this.adminsService.findAll();
  }

  @RequirePermissions(PERMISSION_CODES.ADMINS_MANAGE)
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.adminsService.findById(id);
  }

  @RequirePermissions(PERMISSION_CODES.ADMINS_MANAGE)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAdminDto) {
    return this.adminsService.update(id, dto);
  }

  @RequirePermissions(PERMISSION_CODES.ADMINS_MANAGE)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.adminsService.remove(id);
  }

  @RequirePermissions(PERMISSION_CODES.ADMINS_MANAGE)
  @Patch(':id/activate')
  activate(@Param('id') id: string) {
    return this.adminsService.activate(id);
  }

  @RequirePermissions(PERMISSION_CODES.ADMINS_MANAGE)
  @Patch(':id/deactivate')
  deactivate(@Param('id') id: string) {
    return this.adminsService.deactivate(id);
  }
}
