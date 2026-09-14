# Licence server

Issues and validates licence keys, and turns Razorpay payments into keys.

Two files, no dependencies beyond Node.

```
licence-server.js    the server
razorpay-webhook.js  signature checking and event interpretation
```

## The one thing that must be right

**`LICENCE_DB` has to point at a persistent volume.**

Most hosts give containers a filesystem that is wiped on every restart and
every deploy. This file *is* the record of who your customers are — lose it and
every paying customer is locked out at once, with no way to work out who to
apologise to.

The server refuses to start if it detects a container and a path that does not
look persistent. That check exists because the failure is silent otherwise: it
works fine for three weeks, then a routine deploy destroys the business.

## Deploying

### Railway

1. New project → Deploy from GitHub → this repo
2. **Add a Volume, mounted at `/data`** ← do not skip this
3. Variables:

```
LICENCE_DB=/data/licences.json
RAZORPAY_WEBHOOK_SECRET=<from Razorpay>
RESEND_API_KEY=<optional>
LICENCE_FROM_EMAIL=<optional, e.g. keys@yourdomain>
DOWNLOAD_URL=<where the .exe lives>
```

4. Deploy, then check the logs say `N keys on file` rather than refusing to start

No root directory to configure - the Dockerfile at the repo root is found
automatically, and copies in only the two files this server needs.

### Render

Same, with a **Disk** mounted at `/data` instead of a Volume.

### Anywhere with Docker

```bash
docker build -t licence-server .
docker run -p 8787:8787 -v licences:/data \
  -e RAZORPAY_WEBHOOK_SECRET=whsec_... licence-server
```

## Connecting Razorpay

Dashboard → **Account & Settings → Webhooks → Add New Webhook**

- **URL**: `https://your-server/webhook/razorpay`
- **Secret**: generate one, then set it as `RAZORPAY_WEBHOOK_SECRET`
- **Events**: `subscription.charged`, `subscription.halted`, `subscription.cancelled`

`subscription.charged` is the only one that releases a key. Authorising the
mandate is not payment — issuing on `subscription.authenticated` would hand a
free licence to everyone who starts checkout and walks away.

## Endpoints

| | |
|---|---|
| `GET /health` | for the host's health check |
| `POST /v1/activate` | `{ key, machine }` → plan and expiry, or an error |
| `POST /webhook/razorpay` | signed by Razorpay; issues, extends or revokes |

## Issuing keys by hand

Before any payment system exists, or for a free account:

```bash
node server/licence-server.js --issue 5
node server/licence-server.js --issue 1 --team --months 12
```

## Environment

| Variable | Required | Notes |
|---|---|---|
| `LICENCE_DB` | **yes in production** | must be on a persistent volume |
| `PORT` | no | defaults to 8787 |
| `RAZORPAY_WEBHOOK_SECRET` | for webhooks | without it, webhooks are refused |
| `RESEND_API_KEY` | no | without it, keys are logged rather than emailed |
| `LICENCE_FROM_EMAIL` | with Resend | verified sender address |
| `DOWNLOAD_URL` | no | included in the email |
| `RAZORPAY_PLAN_MAP` | no | JSON mapping Razorpay plan ids to `solo` / `team` |
| `LICENCE_ALLOW_EPHEMERAL` | no | skips the storage check. Local testing only |

## Backing it up

`licences.json` is small and irreplaceable. Copy it somewhere else daily.
Losing it means every customer loses access, and the file is the only record of
who they were.
