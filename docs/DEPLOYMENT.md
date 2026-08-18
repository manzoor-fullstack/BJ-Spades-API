# Deploying the BJ Spades API to EC2

Backend only. The Next.js admin is a separate repo and is not deployed by any
of this.

## What you need before starting

- An EC2 instance you can SSH into (Ubuntu 22.04/24.04 assumed below).
- A security group allowing **22** (your IP only), **80** and **443**.
  **Do not open 5000** — the API binds to loopback and nginx fronts it.
- A DNS A record pointing at the instance, if you want TLS.

## 1. Install Docker on the instance

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl nginx
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo tee /etc/apt/keyrings/docker.asc > /dev/null
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker $USER   # log out and back in for this to apply
```

## 2. Get the code

```bash
git clone https://github.com/manzoor-fullstack/BJ-Spades-API.git
cd BJ-Spades-API
```

## 3. Write the `.env`

Copy `.env.example` and fill it in. The values that **must** change from the
example, because the defaults are either local-only or empty:

| Variable | Production value |
|---|---|
| `NODE_ENV` | `production` |
| `PUBLIC_URL` | `https://api.yourdomain.com` — this is what uploaded image URLs are built from, so a wrong value serves broken images |
| `CORS_ORIGINS` | the admin app's origin, e.g. `https://admin.yourdomain.com` |
| `DATABASE_URL` | `postgresql://USER:PASS@db:5432/bj_spades?schema=public` — host is `db`, the compose service name, not `localhost` |
| `JWT_ACCESS_SECRET` | `openssl rand -hex 32` |
| `JWT_REFRESH_SECRET` | `openssl rand -hex 32` — **must differ** from the access secret |
| `WEBHOOK_SECRET` | `openssl rand -hex 32` — required, min 16 chars. Easy to miss: it is not optional, and the process refuses to boot without it |
| `ACCESS_TOKEN_EXPIRES` / `REFRESH_TOKEN_EXPIRES` | `15m` / `7d` — both required, no defaults |
| `UPLOAD_DIR` | `/app/uploads` (matches the volume in the compose file) |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | used by the `db` service; the first two must match `DATABASE_URL` |

The following are validated but may be left **empty**, and the API starts
without them — features that need them fail at call time rather than at boot:
`CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`,
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CORS_ORIGINS`. Note that an
empty `CORS_ORIGINS` fails closed — no browser origin is allowed, which is the
correct posture under the BFF architecture but will block anything calling the
API directly.

`env.validation.ts` rejects the process at boot if any required variable is
missing, so a bad `.env` fails immediately and loudly rather than at the first
request.

```bash
chmod 600 .env
```

## 4. Start it

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

## 5. Apply migrations, then seed **once**

The container does not migrate on boot — that would let a rolled-back deploy
silently alter the schema.

```bash
docker compose -f docker-compose.prod.yml exec api npx prisma migrate deploy
```

Seeding creates roles, permissions and the first super admin. Run it **only on
a brand-new database**:

```bash
docker compose -f docker-compose.prod.yml exec api npx prisma db seed
```

> The seeded admin is `admin@bjspades.com` / `Admin123!`. **Change that password
> immediately** via the profile page, or the API is publicly known-credentialed.

## 6. Put nginx in front

`/etc/nginx/sites-available/bj-spades-api`:

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    client_max_body_size 6M;   # uploads are capped at 5 MB; leave headroom

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        # Without these two the API records every session as coming from the
        # proxy, and the security page shows no real browser or IP.
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/bj-spades-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo snap install --classic certbot && sudo certbot --nginx -d api.yourdomain.com
```

## 7. Check it

```bash
curl -i https://api.yourdomain.com/api/health          # expect 200
curl -i https://api.yourdomain.com/api/auth/me         # expect 401 without a token
```

## Redeploying

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec api npx prisma migrate deploy
```

The `uploads` and `pgdata` volumes survive this. Uploaded files and the
database do not live in the image.

## Things that will bite you

- **`PUBLIC_URL` is baked into stored image URLs.** Change the domain later and
  previously uploaded avatars keep pointing at the old host.
- **Swagger is disabled when `NODE_ENV=production`** (`main.ts`). That is
  deliberate; do not set `NODE_ENV=development` to get the docs back on a public
  box.
- **Rate limiting is on in production.** Login is capped at 5 attempts/minute
  per IP. `THROTTLE_DISABLED=true` exists for the test suite — never set it here.
- **Backups are not configured.** `pgdata` is a local Docker volume on one
  instance. Before this is genuinely production, either move to RDS with
  automated snapshots or add a `pg_dump` cron to S3.
