import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

import { ErrorCode } from '../constants/error-codes';

interface ErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

/**
 * Structural check for a Prisma known-request error.
 *
 * Deliberately duck-typed rather than importing `Prisma.PrismaClientKnownRequestError`.
 * The Prisma 7 client is generated at build time, so a hard import couples this
 * filter to a generated artefact that may not exist when the file is type-checked.
 */
function isPrismaKnownError(
  error: unknown,
): error is { code: string; meta?: Record<string, unknown>; message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^P\d{4}$/.test((error as { code: string }).code)
  );
}

function fieldsFromMeta(meta: Record<string, unknown> | undefined): string {
  const target = meta?.target;
  if (Array.isArray(target)) return target.join(', ');
  if (typeof target === 'string') return target;
  return 'field';
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const requestId = randomUUID();
    const { status, body } = this.buildError(exception, requestId);

    // 5xx means we did something wrong — log the whole thing, server-side only.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `[${requestId}] ${request.method} ${request.url} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(
        `[${requestId}] ${request.method} ${request.url} -> ${status}: ${body.error.message}`,
      );
    }

    response.status(status).json(body);
  }

  private buildError(
    exception: unknown,
    requestId: string,
  ): { status: HttpStatus; body: ErrorBody } {
    if (exception instanceof HttpException) {
      return this.fromHttpException(exception, requestId);
    }

    if (isPrismaKnownError(exception)) {
      return this.fromPrismaError(exception, requestId);
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        success: false,
        error: {
          code: ErrorCode.INTERNAL_ERROR,
          // Never leak an internal message or stack to a client.
          message: 'An unexpected error occurred.',
          requestId,
        },
      },
    };
  }

  private fromHttpException(
    exception: HttpException,
    requestId: string,
  ): { status: HttpStatus; body: ErrorBody } {
    const status = exception.getStatus();
    const payload = exception.getResponse();

    // ValidationPipe returns { message: string[], error, statusCode }
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'message' in payload
    ) {
      const raw = payload.message;

      // An exception may name its own error code — InvalidSignatureException
      // needs INVALID_SIGNATURE, not the generic UNAUTHORIZED that 401 maps
      // to. Everything else keeps the status-derived default.
      const explicitCode =
        'code' in payload && typeof payload.code === 'string'
          ? payload.code
          : undefined;

      if (Array.isArray(raw)) {
        return {
          status,
          body: {
            success: false,
            error: {
              code: ErrorCode.VALIDATION_ERROR,
              message: 'Request validation failed.',
              details: raw,
              requestId,
            },
          },
        };
      }

      return {
        status,
        body: {
          success: false,
          error: {
            code: explicitCode ?? this.codeForStatus(status),
            message: String(raw),
            requestId,
          },
        },
      };
    }

    return {
      status,
      body: {
        success: false,
        error: {
          code: this.codeForStatus(status),
          message: exception.message,
          requestId,
        },
      },
    };
  }

  private fromPrismaError(
    exception: { code: string; meta?: Record<string, unknown> },
    requestId: string,
  ): { status: HttpStatus; body: ErrorBody } {
    switch (exception.code) {
      case 'P2002':
        return {
          status: HttpStatus.CONFLICT,
          body: {
            success: false,
            error: {
              code: ErrorCode.DUPLICATE_RECORD,
              message: `A record with this ${fieldsFromMeta(exception.meta)} already exists.`,
              requestId,
            },
          },
        };

      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          body: {
            success: false,
            error: {
              code: ErrorCode.NOT_FOUND,
              message: 'Record not found.',
              requestId,
            },
          },
        };

      case 'P2003':
        return {
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          body: {
            success: false,
            error: {
              code: ErrorCode.INVALID_REFERENCE,
              message: 'Referenced record does not exist.',
              requestId,
            },
          },
        };

      case 'P2014':
        return {
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          body: {
            success: false,
            error: {
              code: ErrorCode.RELATION_VIOLATION,
              message: 'This change would break a required relation.',
              requestId,
            },
          },
        };

      default:
        this.logger.error(
          `[${requestId}] Unmapped Prisma error ${exception.code}`,
        );
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          body: {
            success: false,
            error: {
              code: ErrorCode.DATABASE_ERROR,
              message: 'A database error occurred.',
              requestId,
            },
          },
        };
    }
  }

  private codeForStatus(status: HttpStatus): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCode.VALIDATION_ERROR;
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCode.CONFLICT;
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return ErrorCode.BUSINESS_RULE_VIOLATION;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMITED;
      default:
        return ErrorCode.INTERNAL_ERROR;
    }
  }
}
