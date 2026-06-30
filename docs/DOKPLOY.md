# Dokploy Deployment

Deploy RouterDone as a Docker Compose application.

## Required Settings

Use `docker-compose.dokploy.yml` as the compose file. Keep the service name as `routerdone`; the Dokploy domain mapping is attached to that service.

Set these environment variables:

```text
JWT_SECRET=replace-with-openssl-rand-hex-32
INITIAL_PASSWORD=replace-with-a-long-admin-password
API_KEY_SECRET=replace-with-openssl-rand-hex-32
MACHINE_ID_SALT=replace-with-openssl-rand-hex-32
NODE_ENV=production
PORT=20128
TZ=UTC
DATA_DIR=/app/data
NODE_IMAGE=node:22-alpine
BASE_URL=https://your-routerdone-domain.example
NEXT_PUBLIC_BASE_URL=https://your-routerdone-domain.example
AUTH_COOKIE_SECURE=true
REQUIRE_API_KEY=true
```

`NODE_IMAGE` is optional. If the deploy server has intermittent Docker Hub TLS timeouts, point it at a reachable mirror that provides the same Node Alpine image.

## Persistent Volumes

Persist this path:

```text
/app/data
```

## Preflight

Before pushing or redeploying:

```bash
npm run verify:dokploy
```

This catches malformed newlines, wrong service names, and compose parse errors before Dokploy runs.

## Verify

After deploy:

```bash
curl https://your-routerdone-domain.example/api/health
```

Then sign in, add a provider, create a combo, and call `/v1/chat/completions`.
