import { Injectable, UnauthorizedException } from '@nestjs/common';

import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login-response.dto';

import { AuthRepository } from './repositories/auth.repository';
import { PasswordService } from 'src/common/password/password.service';
import { TokenService } from './services/token.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly authRepository: AuthRepository,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
  ) {}

async login(loginDto: LoginDto): Promise<LoginResponseDto> {
  const { email, password } = loginDto;

  // 1. Find admin
  const admin = await this.authRepository.findAdminByEmail(email);

  if (!admin) {
    throw new UnauthorizedException('Invalid email or password.');
  }

  // 2. Check account status
  if (!admin.isActive) {
    throw new UnauthorizedException(
      'Your account has been deactivated.',
    );
  }

  const isPasswordValid = await this.passwordService.compare(
    password,
    admin.password,
  );

  if (!isPasswordValid) {
    throw new UnauthorizedException('Invalid email or password.');
  }

 const payload = {
  sub: admin.id,
  email: admin.email,
  role: admin.role.name,
  roleId: admin.role.id,
};

const [accessToken, refreshToken] =
  await Promise.all([
    this.tokenService.generateAccessToken(payload),
    this.tokenService.generateRefreshToken(payload),
  ]);

await this.authRepository.createRefreshToken(
  admin.id,
  refreshToken.token,
  refreshToken.expiresAt,
);

await this.authRepository.updateLastLogin(admin.id);

await this.authRepository.createSession(admin.id);

const permissions = admin.role.permissions.map(
  (permission) => permission.permission.code,
);

return {
  accessToken,
  refreshToken: refreshToken.token,
  admin: {
    id: admin.id,
    firstName: admin.firstName,
    lastName: admin.lastName,
    email: admin.email,
    role: admin.role.name,
    permissions,
  },
 };
 }

 async me(adminId: string) {
  const admin = await this.authRepository.getAdminProfile(adminId);

  if (!admin) {
    throw new UnauthorizedException('Admin not found.');
  }

  return {
    id: admin.id,
    firstName: admin.firstName,
    lastName: admin.lastName,
    email: admin.email,
    role: admin.role.name,
    permissions: admin.role.permissions.map(
      (permission) => permission.permission.code,
    ),
    lastLogin: admin.lastLogin,
    createdAt: admin.createdAt,
  };
}
}
