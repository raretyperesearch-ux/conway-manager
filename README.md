# ALiFe Conway Agent Manager

Manages Conway automatons for the ALiFe platform. Deploys on Railway.

## Deploy to Railway

1. Create a new repo with these files
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select this repo
4. Add environment variables:

| Key | Value |
|-----|-------|
| `CONWAY_API_KEY` | Generate: `openssl rand -hex 32` |
| `SUPABASE_URL` | `https://pppsvntktlzsjflugzge.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Your Supabase service role key |

5. Deploy. Grab the Railway URL.
6. Add to your ALiFe Vercel project:
   - `CONWAY_API_URL` = Railway URL (e.g. `https://conway-manager-production.up.railway.app`)
   - `CONWAY_API_KEY` = Same key from step 4

## API

- `GET /health` — Health check (no auth)
- `POST /v1/automatons` — Provision new agent (Bearer auth)
- `GET /v1/automatons` — List agents
- `POST /v1/automatons/:id/messages` — Send directive
- `DELETE /v1/automatons/:id` — Kill agent
