export class LoginResponseDto {
  accessToken: string;

  refreshToken: string;

  admin: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    role: string;
    permissions: string[];
  };
}
