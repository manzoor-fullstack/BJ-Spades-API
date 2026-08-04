import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { ErrorCode } from '../../constants/error-codes';
import { AllExceptionsFilter } from '../all-exceptions.filter';

interface CapturedResponse {
  status: number;
  body: {
    success: false;
    error: {
      code: string;
      message: string;
      details?: unknown;
      requestId: string;
    };
  };
}

function createHost(): { host: ArgumentsHost; captured: CapturedResponse } {
  const captured = {} as CapturedResponse;

  const response = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: CapturedResponse['body']) {
      captured.body = body;
      return this;
    },
  };

  const request = { method: 'POST', url: '/api/users' };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  return { host, captured };
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;

  beforeAll(() => {
    // The filter logs every handled exception; silence it so test output stays
    // readable without suppressing genuine failures.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  beforeEach(() => {
    filter = new AllExceptionsFilter();
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  describe('HTTP exceptions', () => {
    it.each([
      [new BadRequestException('bad'), 400, ErrorCode.VALIDATION_ERROR],
      [new UnauthorizedException('nope'), 401, ErrorCode.UNAUTHORIZED],
      [new ForbiddenException('denied'), 403, ErrorCode.FORBIDDEN],
      [new NotFoundException('missing'), 404, ErrorCode.NOT_FOUND],
      [new ConflictException('exists'), 409, ErrorCode.CONFLICT],
    ])('maps %s to the right status and code', (exception, status, code) => {
      const { host, captured } = createHost();

      filter.catch(exception, host);

      expect(captured.status).toBe(status);
      expect(captured.body.error.code).toBe(code);
      expect(captured.body.success).toBe(false);
    });

    it('flattens ValidationPipe messages into details', () => {
      const { host, captured } = createHost();

      filter.catch(
        new BadRequestException({
          message: ['email must be an email', 'password is too short'],
          error: 'Bad Request',
          statusCode: 400,
        }),
        host,
      );

      expect(captured.status).toBe(HttpStatus.BAD_REQUEST);
      expect(captured.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(captured.body.error.details).toEqual([
        'email must be an email',
        'password is too short',
      ]);
    });
  });

  describe('Prisma errors', () => {
    it('maps P2002 to 409 and names the duplicated field', () => {
      const { host, captured } = createHost();

      filter.catch({ code: 'P2002', meta: { target: ['email'] } }, host);

      expect(captured.status).toBe(HttpStatus.CONFLICT);
      expect(captured.body.error.code).toBe(ErrorCode.DUPLICATE_RECORD);
      expect(captured.body.error.message).toContain('email');
    });

    it('handles P2002 with a string target', () => {
      const { host, captured } = createHost();

      filter.catch({ code: 'P2002', meta: { target: 'phone' } }, host);

      expect(captured.body.error.message).toContain('phone');
    });

    it('handles P2002 with no meta at all', () => {
      const { host, captured } = createHost();

      filter.catch({ code: 'P2002' }, host);

      expect(captured.status).toBe(HttpStatus.CONFLICT);
      expect(captured.body.error.message).toContain('field');
    });

    it.each([
      ['P2025', HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND],
      ['P2003', HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.INVALID_REFERENCE],
      ['P2014', HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.RELATION_VIOLATION],
    ])('maps %s to %i', (prismaCode, status, code) => {
      const { host, captured } = createHost();

      filter.catch({ code: prismaCode }, host);

      expect(captured.status).toBe(status);
      expect(captured.body.error.code).toBe(code);
    });

    it('maps an unrecognised Prisma code to 500 without leaking it', () => {
      const { host, captured } = createHost();

      filter.catch({ code: 'P9999' }, host);

      expect(captured.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(captured.body.error.code).toBe(ErrorCode.DATABASE_ERROR);
      expect(captured.body.error.message).not.toContain('P9999');
    });

    it('does not treat an arbitrary object with a code as a Prisma error', () => {
      const { host, captured } = createHost();

      filter.catch({ code: 'ECONNREFUSED' }, host);

      expect(captured.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(captured.body.error.code).toBe(ErrorCode.INTERNAL_ERROR);
    });
  });

  describe('unknown errors', () => {
    it('never leaks an internal message to the client', () => {
      const { host, captured } = createHost();

      filter.catch(
        new Error('Connection string postgres://user:hunter2@db/prod failed'),
        host,
      );

      expect(captured.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(captured.body.error.message).toBe('An unexpected error occurred.');
      expect(JSON.stringify(captured.body)).not.toContain('hunter2');
    });

    it('handles a thrown string', () => {
      const { host, captured } = createHost();

      filter.catch('something broke', host);

      expect(captured.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(captured.body.error.code).toBe(ErrorCode.INTERNAL_ERROR);
    });
  });

  it('attaches a unique requestId to every response', () => {
    const first = createHost();
    const second = createHost();

    filter.catch(new NotFoundException(), first.host);
    filter.catch(new NotFoundException(), second.host);

    expect(first.captured.body.error.requestId).toBeTruthy();
    expect(second.captured.body.error.requestId).toBeTruthy();
    expect(first.captured.body.error.requestId).not.toBe(
      second.captured.body.error.requestId,
    );
  });
});
