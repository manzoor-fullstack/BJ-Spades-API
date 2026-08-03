import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

export async function seedAdmin(prisma: PrismaClient) {
  console.log('\n🌱 Seeding Super Admin...');

  const superAdminRole = await prisma.role.findUnique({
    where: {
      name: 'SUPER_ADMIN',
    },
  });

  if (!superAdminRole) {
    throw new Error('SUPER_ADMIN role not found. Please run roles seed first.');
  }

  const hashedPassword = await bcrypt.hash('Admin123!', 12);

  await prisma.admin.upsert({
    where: {
      email: 'admin@bjspades.com',
    },
    update: {
      firstName: 'Super',
      lastName: 'Admin',
      password: hashedPassword,
      roleId: superAdminRole.id,
      isActive: true,
    },
    create: {
      firstName: 'Super',
      lastName: 'Admin',
      email: 'admin@bjspades.com',
      password: hashedPassword,
      roleId: superAdminRole.id,
      isActive: true,
    },
  });

  console.log('✅ Super Admin Created');
  console.log('📧 Email: admin@bjspades.com');
  console.log('🔑 Password: Admin@123');
  console.log('🎉 Super Admin Seeded Successfully\n');
}
