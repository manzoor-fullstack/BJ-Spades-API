import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { PERMISSION_CODES } from '../../common/constants/permissions';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { Public } from '../auth/decorators/public.decorator';

import { WebhookAckDto } from './dto/webhook-ack.dto';
import { WebhookEventsQueryDto } from './dto/webhook-events-query.dto';
import { GhlTokenGuard } from './guards/ghl-token.guard';
import type { RawBodyRequest } from './webhook-raw-body';
import { WebhooksService, type WebhookEventsPage } from './webhooks.service';

/** Contract limit: 100 requests per minute. */
export const WEBHOOK_RATE_LIMIT = 100;
export const WEBHOOK_RATE_TTL_MS = 60_000;

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  /**
   * Authenticated by HMAC signature, not by JWT — hence @Public().
   *
   * Every outcome a signed request can produce is a 200: PROCESSED, DUPLICATE
   * and FAILED alike. Only a bad, missing or stale signature is a 401. A 4xx
   * for a payload problem would put the sender in a retry loop over a request
   * that can never succeed. See docs/specs/WEBHOOK-CONTRACT.md.
   */
  @Public()
  @Throttle({
    default: { limit: WEBHOOK_RATE_LIMIT, ttl: WEBHOOK_RATE_TTL_MS },
  })
  // Nest defaults POST to 201; the contract says 200.
  @HttpCode(HttpStatus.OK)
  @Post('user-registration')
  @ApiOperation({ summary: 'Register a user from the external signup form.' })
  @ApiOkResponse({ type: WebhookAckDto })
  @ApiUnauthorizedResponse({ description: 'Signature verification failed.' })
  handleUserRegistration(
    @Req() request: Request & RawBodyRequest,
  ): Promise<WebhookAckDto> {
    // The controller hands over the untouched bytes and headers. Everything
    // else — including which header means what — belongs to the service.
    return this.webhooksService.handleUserRegistration({
      rawBody: request.rawBody,
      headers: request.headers,
    });
  }

  /**
   * The GoHighLevel path: a flat body, authenticated by a static bearer token.
   *
   * GHL workflows send only static values and merge fields, so they cannot
   * compute the per-request HMAC the endpoint above requires. Everything after
   * authentication is the same pipeline, and the outcomes match: 200 for
   * PROCESSED, DUPLICATE and FAILED alike; 401 only for a bad token.
   */
  @Public()
  @UseGuards(GhlTokenGuard)
  @Throttle({
    default: { limit: WEBHOOK_RATE_LIMIT, ttl: WEBHOOK_RATE_TTL_MS },
  })
  @HttpCode(HttpStatus.OK)
  @Post('ghl/user-registration')
  @ApiOperation({ summary: 'Register a user from a GoHighLevel workflow.' })
  @ApiOkResponse({ type: WebhookAckDto })
  @ApiUnauthorizedResponse({ description: 'Bearer token missing or invalid.' })
  handleGhlRegistration(@Body() body: unknown): Promise<WebhookAckDto> {
    // Typed `unknown` deliberately: the global ValidationPipe has no DTO to
    // bind here, and the service must see exactly what the workflow sent so an
    // unmapped merge field is recorded rather than silently dropped.
    return this.webhooksService.handleGhlRegistration(body);
  }

  @ApiBearerAuth('access-token')
  @RequirePermissions(PERMISSION_CODES.SECURITY_MANAGE)
  @Get('events')
  @ApiOperation({ summary: 'Inspect received webhook events.' })
  findEvents(
    @Query() query: WebhookEventsQueryDto,
  ): Promise<WebhookEventsPage> {
    return this.webhooksService.findEvents(query);
  }

  @ApiBearerAuth('access-token')
  @RequirePermissions(PERMISSION_CODES.SECURITY_MANAGE)
  @HttpCode(HttpStatus.OK)
  @Post('events/:id/retry')
  @ApiOperation({ summary: 'Reprocess a stored webhook payload.' })
  @ApiOkResponse({ type: WebhookAckDto })
  retryEvent(@Param('id', ParseUUIDPipe) id: string): Promise<WebhookAckDto> {
    return this.webhooksService.retryEvent(id);
  }
}
