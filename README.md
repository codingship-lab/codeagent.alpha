# CodeAgent

CodeAgent is split into two deployable apps:

- `web` (root): Next.js App Router frontend + `/api/chat`, deployed to Cloudflare Workers with OpenNext.
- `runtime` (`./runtime`): Node runtime service for `/api/arena*` and `/api/preview*`.

## Project layout

- `app/`: Next.js routes and API route handler.
- `components/`, `hooks/`, `lib/`: shared frontend modules.
- `runtime/`: Express runtime service with sandbox orchestration.

## Local development

### 1) Install dependencies

```bash
npm install
cd runtime && npm install
```

### 2) Configure environment

```bash
cp .env.example .env
cp runtime/.env.example runtime/.env
```

Set the following minimum values:

- Root `.env`: `GROQ_API_KEY`, `NEXT_PUBLIC_RUNTIME_API_BASE_URL`
- `runtime/.env`: `GROQ_API_KEY`, `CORS_ORIGIN`, plus Vercel sandbox credentials if preview is needed.

### 3) Run both services

Terminal A (web):

```bash
npm run dev
```

Terminal B (runtime):

```bash
cd runtime
npm run dev
```

## Cloudflare deploy (web)

The web app uses OpenNext for Cloudflare Workers.

Recommended build settings in Cloudflare:

- Build command: `npm run build`
- Build output directory: `.open-next/assets`
- Node version: `20` or `22`

1. Set secret in Cloudflare:

```bash
wrangler secret put GROQ_API_KEY
```

2. Configure public runtime URL in your deployment environment:

- `NEXT_PUBLIC_RUNTIME_API_BASE_URL=https://your-runtime-service.example.com`

3. Build + deploy:

```bash
npm run deploy
```

## Runtime deploy (Node)

Deploy `./runtime` to any Node host (for example, Fly.io, Render, Railway, or a VM).

Required env vars:

- `GROQ_API_KEY`
- `CORS_ORIGIN` (frontend origin or `*`)

Optional preview/sandbox vars:

- `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`
- `PREVIEW_PORT`, `SANDBOX_RUNTIME`, `MAX_VALIDATE_ATTEMPTS`, `BUILD_TIMEOUT_MS`
