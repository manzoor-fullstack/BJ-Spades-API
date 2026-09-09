import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),

  PORT: Joi.number().port().default(5000),

  DATABASE_URL: Joi.string().required(),

  JWT_ACCESS_SECRET: Joi.string().min(16).required(),

  // Must differ from the access secret. If the same key signs both, a stolen
  // access token can be presented as a refresh token.
  JWT_REFRESH_SECRET: Joi.string()
    .min(16)
    .required()
    .invalid(Joi.ref('JWT_ACCESS_SECRET'))
    .messages({
      'any.invalid':
        'JWT_REFRESH_SECRET must be different from JWT_ACCESS_SECRET.',
    }),

  ACCESS_TOKEN_EXPIRES: Joi.string().required(),

  REFRESH_TOKEN_EXPIRES: Joi.string().required(),

  PLAYER_JWT_ACCESS_SECRET: Joi.string().min(16).required(),

  PLAYER_JWT_REFRESH_SECRET: Joi.string()
    .min(16)
    .required()
    .invalid(Joi.ref('PLAYER_JWT_ACCESS_SECRET'))
    .messages({
      'any.invalid':
        'PLAYER_JWT_REFRESH_SECRET must be different from PLAYER_JWT_ACCESS_SECRET.',
    }),

  PLAYER_ACCESS_TOKEN_EXPIRES: Joi.string().required(),

  PLAYER_REFRESH_TOKEN_EXPIRES: Joi.string().required(),

  PLAYER_SESSION_EXPIRES: Joi.string().required(),

  PLAYER_APP_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .required(),

  PLAYER_APP_ORIGINS: Joi.string().required(),

  PLAYER_EMAIL_DELIVERY_MODE: Joi.string()
    .valid('console', 'resend')
    .default('console'),

  RESEND_API_KEY: Joi.string().allow(''),

  PLAYER_EMAIL_FROM: Joi.string().email().required(),

  GOOGLE_CLIENT_ID: Joi.string().allow(''),
  GOOGLE_CLIENT_SECRET: Joi.string().allow(''),
  GITHUB_CLIENT_ID: Joi.string().allow(''),
  GITHUB_CLIENT_SECRET: Joi.string().allow(''),

  WEBHOOK_SECRET: Joi.string().min(16).required(),

  // Optional so existing deployments keep booting. Empty leaves the
  // GoHighLevel endpoint refusing every request — GhlTokenGuard fails closed.
  GHL_WEBHOOK_TOKEN: Joi.string().allow('').min(16),

  // Leaves the GoHighLevel endpoint open to anyone who knows the URL.
  // Validated rather than read loosely so a typo in the VALUE fails at boot:
  // silently staying protected is the wrong answer when an operator has
  // deliberately asked for the check to be off.
  GHL_WEBHOOK_AUTH_DISABLED: Joi.string()
    .valid('true', 'false')
    .default('false'),

  CLOUDINARY_CLOUD_NAME: Joi.string().allow(''),

  CLOUDINARY_API_KEY: Joi.string().allow(''),

  CLOUDINARY_API_SECRET: Joi.string().allow(''),

  STRIPE_SECRET_KEY: Joi.string().allow(''),

  STRIPE_WEBHOOK_SECRET: Joi.string().allow(''),

  UPLOAD_DIR: Joi.string().required(),

  PUBLIC_URL: Joi.string().required(),

  CORS_ORIGINS: Joi.string().allow(''),

  // Number of reverse proxies between the public client and this API. Zero is
  // the safe default for direct exposure and local development.
  TRUSTED_PROXY_HOPS: Joi.number().integer().min(0).max(10).default(0),

  // Swagger stays off by default in production and can be enabled explicitly
  // for deployments where the API documentation must be available.
  SWAGGER_ENABLED: Joi.string().valid('true', 'false'),
});
