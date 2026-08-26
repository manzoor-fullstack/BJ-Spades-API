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
});
