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

  const email = 'admin@bjspades.com';
  const existing = await prisma.admin.findUnique({ where: { email } });

  if (existing) {
    // Seeding is routinely re-run during deployments. Never reset a real
    // operator's password, role, name, or activation state on a repeat run.
    console.log('✅ Super Admin Already Exists (credentials preserved)');
    console.log(`📧 Email: ${email}`);
    console.log('🎉 Super Admin Seeded Successfully\n');
    return;
  }

  // Printed only for the first creation, when this initial credential is real.
  const plainPassword = 'Admin123!';
  const hashedPassword = await bcrypt.hash(plainPassword, 12);

  await prisma.admin.create({
    data: {
      firstName: 'Super',
      lastName: 'Admin',
      email,
      password: hashedPassword,
      roleId: superAdminRole.id,
      isActive: true,
    },
  });

  console.log('✅ Super Admin Created');
  console.log(`📧 Email: ${email}`);
  console.log(`🔑 Password: ${plainPassword}`);
  console.log('🎉 Super Admin Seeded Successfully\n');
}
