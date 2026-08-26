export default () => ({
  app: {
    port: parseInt(process.env.PORT ?? '5000', 10),
    nodeEnv: process.env.NODE_ENV,
    publicUrl: process.env.PUBLIC_URL,
    uploadDir: process.env.UPLOAD_DIR,
    corsOrigins: process.env.CORS_ORIGINS,
  },

  database: {
    url: process.env.DATABASE_URL,
  },

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,

    accessExpiresIn: process.env.ACCESS_TOKEN_EXPIRES,

    refreshExpiresIn: process.env.REFRESH_TOKEN_EXPIRES,
  },

  webhook: {
    secret: process.env.WEBHOOK_SECRET,
  },

  ghl: {
    /** Static bearer token for the GoHighLevel endpoint; empty disables it. */
    webhookToken: process.env.GHL_WEBHOOK_TOKEN,
  },

  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,

    apiKey: process.env.CLOUDINARY_API_KEY,

    apiSecret: process.env.CLOUDINARY_API_SECRET,
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,

    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  },
});
