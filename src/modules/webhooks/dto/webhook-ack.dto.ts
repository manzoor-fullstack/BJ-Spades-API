import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Outcomes a *successfully authenticated* webhook can produce.
 *
 * Deliberately narrower than WebhookEventStatus: RECEIVED is a storage state,
 * never a final answer to the sender.
 */
export type WebhookAckStatus = 'PROCESSED' | 'DUPLICATE' | 'FAILED';

/**
 * The body of every 200 from the webhook endpoint.
 *
 * A valid signature always yields 2xx — the sender proved its identity, so the
 * request genuinely arrived. A 4xx would tell it to retry a request that can
 * never succeed. See docs/specs/WEBHOOK-CONTRACT.md, "Responses".
 */
export class WebhookAckDto {
  @ApiProperty({ description: 'The X-BJS-Event-Id this response is about.' })
  eventId: string;

  @ApiProperty({ enum: ['PROCESSED', 'DUPLICATE', 'FAILED'] })
  status: WebhookAckStatus;

  @ApiPropertyOptional({
    description: 'Set when a user exists for this event.',
  })
  userId?: string;

  @ApiPropertyOptional({ description: 'Why processing did not complete.' })
  reason?: string;
}
