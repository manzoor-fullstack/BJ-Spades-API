import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PlayerEmailService {
  private readonly logger = new Logger(PlayerEmailService.name);

  constructor(private readonly config: ConfigService) {}

  verification(email: string, token: string): Promise<void> {
    return this.deliver(
      email,
      'Verify your BJ Spades account',
      'verifyToken',
      token,
    );
  }

  passwordReset(email: string, token: string): Promise<void> {
    return this.deliver(
      email,
      'Reset your BJ Spades password',
      'resetToken',
      token,
    );
  }

  private async deliver(
    email: string,
    subject: string,
    queryKey: string,
    token: string,
  ): Promise<void> {
    const appUrl = new URL(this.config.getOrThrow<string>('playerAuth.appUrl'));
    appUrl.searchParams.set(queryKey, token);

    const mode = this.config.get<string>('playerAuth.emailDeliveryMode');
    const nodeEnv = this.config.get<string>('app.nodeEnv');

    if (mode === 'console' && nodeEnv !== 'production') {
      this.logger.debug(`${subject} for ${email}: ${appUrl.toString()}`);
      return;
    }

    const apiKey = this.config.get<string>('playerAuth.resendApiKey');
    const from = this.config.getOrThrow<string>('playerAuth.emailFrom');

    if (mode !== 'resend' || !apiKey) {
      throw new ServiceUnavailableException(
        'Player email delivery is not configured.',
      );
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject,
        text: `${subject}: ${appUrl.toString()}`,
      }),
    });

    if (!response.ok) {
      throw new ServiceUnavailableException(
        'Player email could not be delivered. Please try again.',
      );
    }
  }
}
