export default () => ({
  app: {
    port: parseInt(process.env.PORT ?? '5000', 10),
    nodeEnv: process.env.NODE_ENV,
    publicUrl: process.env.PUBLIC_URL,
    uploadDir: process.env.UPLOAD_DIR,
    corsOrigins: process.env.CORS_ORIGINS,
    trustedProxyHops: parseInt(process.env.TRUSTED_PROXY_HOPS ?? '0', 10),
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

  playerAuth: {
    accessSecret: process.env.PLAYER_JWT_ACCESS_SECRET,
    refreshSecret: process.env.PLAYER_JWT_REFRESH_SECRET,
    accessExpiresIn: process.env.PLAYER_ACCESS_TOKEN_EXPIRES,
    refreshExpiresIn: process.env.PLAYER_REFRESH_TOKEN_EXPIRES,
    sessionExpiresIn: process.env.PLAYER_SESSION_EXPIRES,
    appUrl: process.env.PLAYER_APP_URL,
    allowedOrigins: process.env.PLAYER_APP_ORIGINS,
    emailDeliveryMode: process.env.PLAYER_EMAIL_DELIVERY_MODE,
    resendApiKey: process.env.RESEND_API_KEY,
    emailFrom: process.env.PLAYER_EMAIL_FROM,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    githubClientId: process.env.GITHUB_CLIENT_ID,
    githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
  },

  webhook: {
    secret: process.env.WEBHOOK_SECRET,
  },

  ghl: {
    /** Static bearer token for the GoHighLevel endpoint; empty disables it. */
    webhookToken: process.env.GHL_WEBHOOK_TOKEN,

    /**
     * Turns the bearer check off entirely, leaving the endpoint open to anyone
     * who knows the URL. Temporary escape hatch only — see GhlTokenGuard.
     */
    authDisabled: process.env.GHL_WEBHOOK_AUTH_DISABLED === 'true',
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
