# Deploying Sentinel — Backend on Oracle + Frontend on Vercel

Follow this top to bottom. Backend (API + WebSocket + Postgres + Redis) runs on your Oracle VM
behind Caddy (free HTTPS). Frontend runs on Vercel and talks to the backend over HTTPS/WSS.

**Your values (replace if different):**

- VM public IP: `80.225.243.198`
- Backend domain: `sentinel-backend.duckdns.org`
- SSH user on the VM: `ubuntu`

> The files this guide uses already exist in the repo: `backend/Dockerfile`, `Caddyfile`,
> `docker-compose.prod.yml`.

---

## Step 1 — Open the firewall (TWO places, both required)

Oracle blocks all inbound traffic except SSH by default — in two layers. You must open **80** and
**443** in both, or nothing will be reachable.

### 1a. Cloud firewall (VCN Security List)

In the Oracle Cloud web console:

1. Hamburger menu → **Networking → Virtual Cloud Networks**.
2. Click your VCN → click the **subnet** → click its **Security List** (Default Security List).
3. **Add Ingress Rules** → add these two (Source CIDR `0.0.0.0/0`, IP Protocol **TCP**):
   - Destination Port: `80`
   - Destination Port: `443`
4. Save.

### 1b. OS firewall (on the VM itself)

SSH into the VM first (use the key you downloaded when you created the instance):

```bash
ssh -i /path/to/your-ssh-key.key ubuntu@80.225.243.198
```

Then open the ports at the OS level (Oracle's Ubuntu image ships with strict iptables):

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

✅ **Checkpoint:** `sudo iptables -L INPUT --line-numbers | grep -E "80|443"` shows both ACCEPT rules.

---

## Step 2 — Point a free domain at the VM (DuckDNS)

Caddy needs a real hostname to get a free HTTPS certificate.

1. Go to **https://www.duckdns.org**, sign in (Google/GitHub).
2. Type a subdomain, e.g. `sentinel-backend`, click **add domain**.
3. In the **current ip** box for that domain, enter `80.225.243.198` and click **update ip**.

✅ **Checkpoint (run on your laptop):** `ping sentinel-backend.duckdns.org` resolves to `80.225.243.198`.

---

## Step 3 — Install Docker on the VM

While SSH'd into the VM:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
newgrp docker          # apply the group now (or log out and back in)
```

✅ **Checkpoint:** `docker --version` and `docker compose version` both print a version.

---

## Step 4 — Get the code onto the VM

Easiest is GitHub. On your **laptop**, push the project to a (private) GitHub repo if you haven't.
Then on the **VM**:

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/<your-username>/<your-repo>.git sentinel
cd sentinel
```

> No GitHub? From your laptop you can copy it up instead (skips node_modules):
> `rsync -av --exclude node_modules --exclude dist ./ ubuntu@80.225.243.198:~/sentinel/`

---

## Step 5 — Create the `.env` on the VM (this holds your secrets)

`.env` is intentionally **not** in git, so create it on the VM. From inside `~/sentinel`:

```bash
nano .env
```

Paste this, then fill the two secret lines with the values from your **local** `.env`
(your funded testnet key and DeepSeek key). Everything else below is already correct:

```dotenv
# --- the domain Caddy will serve (matches Step 2) ---
SENTINEL_DOMAIN=sentinel-backend.duckdns.org

# --- Sui Testnet ---
SUI_RPC_URL=https://fullnode.testnet.sui.io:443
SUI_TESTNET_CHAIN_ID=4c78adac
SENTINEL_POLICY_PACKAGE_ID=0xacc43943d51e0bdf43f8a0ea471fd1bb8c4ecaab6df1b9c3a5cab5bbcbea82e7
SENTINEL_DEMO_MARKET_PACKAGE_ID=0xacc43943d51e0bdf43f8a0ea471fd1bb8c4ecaab6df1b9c3a5cab5bbcbea82e7
SENTINEL_ADAPTERS_PACKAGE_ID=0xacc43943d51e0bdf43f8a0ea471fd1bb8c4ecaab6df1b9c3a5cab5bbcbea82e7

# --- Walrus Testnet ---
WALRUS_PUBLISHER_URL=https://publisher.walrus-testnet.walrus.space
WALRUS_AGGREGATOR_URL=https://aggregator.walrus-testnet.walrus.space

# --- SECRET: paste from your local .env ---
AGENT_SIGNER_KEY=PASTE_YOUR_suiprivkey_HERE
LLM_API_KEY=PASTE_YOUR_DEEPSEEK_KEY_HERE
LLM_MODEL=deepseek-v4-flash
LLM_BASE_URL=https://api.deepseek.com

# --- backend service ---
PORT=4000
NODE_ENV=production
RATE_LIMIT_MAX=120
RATE_LIMIT_WINDOW_MS=60000

# --- demo on-chain objects (public) ---
DEMO_MARKET_STATE_ID=0x95120424738ae3f9f159bfeafea4e6a11e462463b2b831255d1284e5c3606d12
DEMO_POLICY_OBJECT_ID=0x81591e148e9a257bd175b696339eba97008fa0762b9132b6320dc1876dba8387
DEMO_GUARDIAN_CAP_ID=0x21e7bf5b5989422f9a37c766735619a6c389cfbed879a795cc9ba91617ab4706
DEMO_OVERRIDE_CAP_ID=0x72b45229d9481a87f5e82049b2a789b52dda4fcbb6cc4396e99cfb715cc2bf39
```

Save in nano: `Ctrl+O`, `Enter`, then `Ctrl+X`.

> You do **not** need to set `DATABASE_URL` / `REDIS_URL` — the prod compose file points the backend
> at the Postgres and Redis containers automatically.

---

## Step 6 — Start everything

From `~/sentinel`:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

First build takes a few minutes. Then create the database tables and seed the demo data:

```bash
docker compose -f docker-compose.prod.yml exec backend node dist/db/migrate.js
docker compose -f docker-compose.prod.yml exec backend node dist/db/seed.js
```

Optional — add the 2 extra markets (SUI Perps, USDC Vault). This **mints 2 real on-chain objects
and spends a little testnet gas**, so only run it if your agent key is funded:

```bash
docker compose -f docker-compose.prod.yml exec backend node dist/demo/seedExtraMarkets.js
```

✅ **Checkpoint:** `docker compose -f docker-compose.prod.yml ps` shows postgres, redis, backend,
caddy all "running"/"healthy".

---

## Step 7 — Verify the backend is live over HTTPS

Give Caddy ~30 seconds on first run to fetch the certificate, then from your laptop:

```bash
curl https://sentinel-backend.duckdns.org/health
# -> {"status":"ok","service":"sentinel-backend","network":"sui:testnet",...}

curl https://sentinel-backend.duckdns.org/api/markets
# -> {"role":"DeFi User","markets":[ ... ]}
```

If `/health` works but `/api/markets` is empty, re-run the migrate + seed commands from Step 6.

---

## Step 8 — Deploy the frontend on Vercel

1. Go to **vercel.com → Add New → Project**, import your GitHub repo.
2. **Root Directory:** set it to **`frontend`** (click "Edit" next to Root Directory).
3. Framework Preset: **Astro** (auto-detected). Leave build/output defaults.
4. **Environment Variables** — add these (Production), then Deploy:

| Name                                     | Value                                                                |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `PUBLIC_SUI_NETWORK`                     | `testnet`                                                            |
| `PUBLIC_BACKEND_URL`                     | `https://sentinel-backend.duckdns.org`                              |
| `PUBLIC_WS_URL`                          | `wss://sentinel-backend.duckdns.org/ws`                             |
| `PUBLIC_SENTINEL_POLICY_PACKAGE_ID`      | `0xacc43943d51e0bdf43f8a0ea471fd1bb8c4ecaab6df1b9c3a5cab5bbcbea82e7` |
| `PUBLIC_SENTINEL_DEMO_MARKET_PACKAGE_ID` | `0xacc43943d51e0bdf43f8a0ea471fd1bb8c4ecaab6df1b9c3a5cab5bbcbea82e7` |
| `PUBLIC_SENTINEL_ADAPTERS_PACKAGE_ID`    | `0xacc43943d51e0bdf43f8a0ea471fd1bb8c4ecaab6df1b9c3a5cab5bbcbea82e7` |
| `PUBLIC_DEMO_MARKET_STATE_ID`            | `0x95120424738ae3f9f159bfeafea4e6a11e462463b2b831255d1284e5c3606d12` |
| `PUBLIC_DEMO_MARKET_ID`                  | `11111111-1111-4111-8111-111111111111`                               |
| `PUBLIC_DEMO_POLICY_ID`                  | `22222222-2222-4222-8222-222222222222`                               |
| `PUBLIC_DEMO_POLICY_OBJECT_ID`           | `0x81591e148e9a257bd175b696339eba97008fa0762b9132b6320dc1876dba8387` |
| `PUBLIC_DEMO_OVERRIDE_CAP_ID`            | `0x72b45229d9481a87f5e82049b2a789b52dda4fcbb6cc4396e99cfb715cc2bf39` |
| `PUBLIC_DEMO_DAO_ADDRESS`                | `0xa054daa9e6db27e623f377f17b0702222f2b54b9ef76d16ca02cf3dec189d4b4` |

5. Vercel gives you a URL like `https://your-project.vercel.app`.

> CORS is already enabled on the backend (it reflects the request origin), so the Vercel site can
> call the Oracle backend directly — no extra config needed.

---

## Step 9 — Final smoke test

Open your Vercel URL and check:

- The landing page loads.
- **Connect Wallet** (Sui Testnet) — the nav shows your address.
- **/dashboard** — the three markets load and the risk gauge updates (this proves REST + WebSocket
  reach the Oracle backend).
- **/simulator** — pick "SUI flash crash", Start, and watch the score move + a testnet tx digest appear.

If the dashboard is stuck "loading" or the gauge never moves, open the browser DevTools → Network:
a failed `…duckdns.org/api/markets` means the backend/cert/firewall isn't reachable (recheck Steps
1, 2, 7); a failed `wss://…/ws` means the WebSocket isn't getting through Caddy (recheck `PUBLIC_WS_URL`
has the `/ws` suffix).

---

## Updating later

```bash
# on the VM, after git pull:
cd ~/sentinel && git pull
docker compose -f docker-compose.prod.yml up -d --build
```

The frontend redeploys automatically when you push to GitHub (Vercel watches the repo).

---

## Security notes

- `AGENT_SIGNER_KEY` is a real key controlling testnet gas. Keep only a small amount on it, and
  rotate it after the hackathon. It lives only in the VM's `.env` (never in git, never on Vercel).
- Everything stays on **Sui Testnet** — the backend's network guard refuses to start otherwise.
