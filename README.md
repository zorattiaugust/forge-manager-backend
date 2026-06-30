# Forge Manager Backend

## What this is
The server that holds your Anthropic API key securely and runs two agents:
- **Coach**: logs your Forge data (workouts, meals, etc.) when you confirm
- **Manager**: breaks business ideas into sub-tasks and delegates to specialist agents

Your API key and database credentials never appear in any public frontend code — they live only as environment variables on the server.

## Setup steps

### 1. Run the database schema
In Supabase: open your project, go to **SQL Editor** (left sidebar) → **New query**,
paste the entire contents of `schema.sql`, and click **Run**. This creates all the tables.

### 2. Push this code to a new GitHub repo
Create a new repo (e.g. "forge-manager-backend"), upload all these files
(`server.js`, `agent-coach.js`, `agent-manager.js`, `claude.js`, `package.json`, `schema.sql`).
Do NOT upload `.env` (only `.env.example`) — never commit real keys to GitHub.

### 3. Connect Railway to that repo
In Railway: **New Project** → **Deploy from GitHub repo** → pick the repo you just made.

### 4. Set environment variables in Railway
In your Railway project → **Variables** tab, add:
- `ANTHROPIC_API_KEY` — your key from console.anthropic.com
- `SUPABASE_URL` — from Supabase Settings → API → Project URL
- `SUPABASE_SERVICE_KEY` — from Supabase Settings → API → service_role key (click reveal)

Railway will redeploy automatically once variables are saved.

### 5. Get your backend URL
Railway gives you a public URL like `forge-manager-backend-production.up.railway.app`
once deployed. Visit `<that-url>/health` in a browser — you should see `{"ok":true}`.
That confirms the server is live. Save this URL, the frontend will need it.

## API endpoints
- `POST /api/coach/message` — `{ message }` → coach reply + pending log ids
- `POST /api/coach/confirm` — `{ id, approve }` → confirms or rejects a pending log
- `GET /api/coach/pending` — list of logs awaiting your approval
- `GET /api/forge/logs` — recent confirmed logs
- `POST /api/manager/message` — `{ message, threadId? }` → manager plan + specialist results
- `GET /api/manager/threads` — list of business idea conversations
- `GET /api/manager/threads/:id/messages` — full history of one thread
