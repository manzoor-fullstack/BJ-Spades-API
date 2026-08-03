import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),

  PORT: Joi.number().default(5000),

  DATABASE_URL: Joi.string().required(),

  JWT_ACCESS_SECRET: Joi.string().required(),

  JWT_REFRESH_SECRET: Joi.string().required(),

  ACCESS_TOKEN_EXPIRES: Joi.string().required(),

  REFRESH_TOKEN_EXPIRES: Joi.string().required(),

  WEBHOOK_SECRET: Joi.string().required(),

  CLOUDINARY_CLOUD_NAME: Joi.string().allow(''),

  CLOUDINARY_API_KEY: Joi.string().allow(''),

  CLOUDINARY_API_SECRET: Joi.string().allow(''),

  STRIPE_SECRET_KEY: Joi.string().allow(''),

  STRIPE_WEBHOOK_SECRET: Joi.string().allow(''),
});
