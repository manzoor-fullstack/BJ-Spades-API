# syntax=docker/dockerfile:1

# Production image for the BJ Spades API.
#
# Debian slim rather than Alpine on purpose: `sharp` (image processing) and
# Prisma both ship glibc prebuilds, and on musl they either fall back to a
# slow path or fail to load outright. The size saving is not worth debugging
# a native module on a deploy night.

# ─── Build ────────────────────────────────────────────────────
FROM node:24-slim AS builder

WORKDIR /app

RUN corepack enable

# Dependency manifests first, so a source-only change does not reinstall.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# The Prisma client is generated, not committed. Must run before the build:
# the generated types are what the TypeScript compile checks against.
RUN pnpm db:generate

# tsc is the memory high-water mark of the whole image build. Node's default
# heap is sized from available RAM, which on a small shared instance is
# whatever is left after everything else on the box — and that was not enough:
# the build died with SIGABRT (exit 134) and a V8 out-of-memory trace on a
# t3-class host already running other containers. Asking for a fixed 2 GB is
# not greed, it is making the build's requirement explicit instead of letting
# it depend on what happens to be running next to it.
ENV NODE_OPTIONS=--max-old-space-size=2048
RUN pnpm build

# ─── Runtime ──────────────────────────────────────────────────
FROM node:24-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

RUN corepack enable

# node_modules is copied wholesale rather than reinstalled with --prod.
# pnpm's layout is a tree of relative symlinks into node_modules/.pnpm, which
# survives the copy intact, and it keeps the `prisma` CLI available so
# `prisma migrate deploy` can be run against this same image on the box. That
# costs image size and buys one less moving part at deploy time.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json /app/prisma.config.ts ./

# Uploaded avatars and banners live on disk (ADR-003). Without a volume
# mounted here every redeploy silently loses them — see docs/DEPLOYMENT.md.
ENV UPLOAD_DIR=/app/uploads
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads

USER node

EXPOSE 5000

# No curl in the slim image, so the check uses the runtime already present.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/main.js"]
