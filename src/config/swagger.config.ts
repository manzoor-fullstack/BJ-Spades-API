import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * Mounts Swagger UI at /api/docs.
 *
 * Never called in production — the route would expose the full API surface,
 * including which endpoints exist and what they accept.
 */
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('BJ Spades Admin API')
    .setDescription(
      'Admin backend for the BJ Spades platform. ' +
        'See docs/03-API-CONTRACT.md for the authoritative contract.',
    )
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Access token from POST /api/auth/login',
      },
      'access-token',
    )
    .addTag('auth', 'Authentication and session management')
    .addTag('users', 'Platform users (players)')
    .addTag('admins', 'Administrator accounts')
    .addTag('roles', 'Roles and permissions')
    .addTag('health', 'Service health')
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
    customSiteTitle: 'BJ Spades Admin API',
  });
}
