#!/bin/sh

# -----------------------------------------------------------------------------
# Production safety: refuse to boot with the public SerpBear demo credentials.
# These are the values shipped in the upstream demo and in this repo's example
# files. Running a public instance with them means anyone can log in and call
# the API. This check only fires when NODE_ENV=production, so local dev (which
# uses the demo defaults intentionally) is unchanged.
# -----------------------------------------------------------------------------
DEMO_APIKEY="5saedXklbslhnapihe2pihp3pih4fdnakhjwq5"
DEMO_SECRET="4715aed3216f7b0a38e6b534a958362654e96d10fbc04700770d572af3dce43625dd"
DEMO_PASSWORD="0123456789"

# Audit area 3 (CRITICAL): also reject THIS repo's own .env.example placeholders, not just the
# upstream SerpBear demo values. An operator who copies .env.example and only changes the obvious
# "change me" password would otherwise boot with a publicly-known SECRET (forge sessions, decrypt
# every stored credential) and APIKEY (full admin). Belt-and-suspenders: a positive length floor
# rejects any future short/weak example value too (real values are hex-34 / hex-24).
EXAMPLE_SECRET="replace-with-openssl-rand-hex-34"
EXAMPLE_APIKEY="replace-with-openssl-rand-hex-24"
EXAMPLE_PASSWORD="change-me-to-a-strong-password"
MIN_SECRET_LEN=40
MIN_APIKEY_LEN=32

if [ "$NODE_ENV" = "production" ]; then
  fail=0
  if [ -z "$APIKEY" ] || [ "$APIKEY" = "$DEMO_APIKEY" ] || [ "$APIKEY" = "$EXAMPLE_APIKEY" ] \
     || [ "${APIKEY#REGENERATE_ME}" != "$APIKEY" ] || [ "${#APIKEY}" -lt "$MIN_APIKEY_LEN" ]; then
    echo "[SECURITY] Refusing to start: APIKEY is unset, a demo/placeholder value, or too short. Generate one: openssl rand -hex 24" >&2
    fail=1
  fi
  if [ -z "$SECRET" ] || [ "$SECRET" = "$DEMO_SECRET" ] || [ "$SECRET" = "$EXAMPLE_SECRET" ] \
     || [ "${SECRET#REGENERATE_ME}" != "$SECRET" ] || [ "${#SECRET}" -lt "$MIN_SECRET_LEN" ]; then
    echo "[SECURITY] Refusing to start: SECRET is unset, a demo/placeholder value, or too short. Generate one: openssl rand -hex 34" >&2
    fail=1
  fi
  if [ -z "$PASSWORD" ] || [ "$PASSWORD" = "$DEMO_PASSWORD" ] || [ "$PASSWORD" = "change-me-please" ] \
     || [ "$PASSWORD" = "$EXAMPLE_PASSWORD" ]; then
    echo "[SECURITY] Refusing to start: PASSWORD is unset or set to a demo/placeholder value. Set a strong admin password." >&2
    fail=1
  fi
  # Audit area 1 (host-header poisoning): NEXT_PUBLIC_APP_URL is the only header-INDEPENDENT source
  # for the public base URL that gets baked into emailed invite/login/share links and the minted
  # mcpConfig.S33K_BASE_URL (which carries a client's Bearer key). If it is unset in production, the
  # base URL would otherwise be derived from attacker-controllable Host / X-Forwarded-Host headers.
  # resolveBaseUrl() now fails closed at runtime, but refuse to boot here too so the misconfig is a
  # clear startup error, not a runtime 500 when the first link is minted. Same posture as the
  # strong-credentials block above and the fail-loud migration below.
  if [ -z "$NEXT_PUBLIC_APP_URL" ]; then
    echo "[SECURITY] Refusing to start: NEXT_PUBLIC_APP_URL is unset. Set it to your real public URL (e.g. https://your-app.example.com, see DEPLOY.md) so user-facing links are not built from forgeable request headers." >&2
    fail=1
  fi
  # Billing config completeness: if Stripe is enabled (STRIPE_SECRET_KEY set) but the webhook signing
  # secret is missing, /api/billing/webhook silently 503s every event, so a paid checkout never flips
  # the account to active (no unlock), a failed payment never locks, and a cancel never relocks. The
  # account would sit in a stale state with no error surfaced. Refuse to boot so an incomplete billing
  # config is a clear startup failure, not a silent revenue/entitlement bug. (STRIPE_PRICE_PER_SITE is
  # checked at runtime with a clean 503 on checkout, so it is not boot-fatal; the webhook secret is,
  # because its absence is invisible until a real Stripe event is dropped.)
  if [ -n "$STRIPE_SECRET_KEY" ] && [ -z "$STRIPE_WEBHOOK_SECRET" ]; then
    echo "[SECURITY] Refusing to start: STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is unset. Stripe webhooks would 503 and billing state (unlock/lock/cancel) would never apply. Set STRIPE_WEBHOOK_SECRET from your Stripe webhook endpoint (see GO_LIVE_MULTI_TENANT.md)." >&2
    fail=1
  fi
  if [ "$fail" = "1" ]; then
    echo "[SECURITY] Set strong APIKEY, SECRET, and PASSWORD env vars (see DEPLOY.md) and redeploy." >&2
    exit 1
  fi
fi

# The data volume is mounted at /app/data at runtime (Railway mounts it root-owned).
# The container runs as root, so it can create and open the SQLite database there
# directly, with no ownership dance.
mkdir -p /app/data

# Boot diagnostics: prove where we are and whether the DB path is writable.
echo "[DIAG] pwd=$(pwd) uid=$(id -u) DATABASE_PATH=${DATABASE_PATH:-unset}"
echo "[DIAG] ls -ld /app/data:"; ls -ld /app/data 2>&1
if touch /app/data/_writetest 2>/dev/null; then
  echo "[DIAG] /app/data is WRITABLE"; rm -f /app/data/_writetest
else
  echo "[DIAG] /app/data is NOT writable"
fi

# Fail LOUD and EARLY on a migration failure: a partial/failed migration would otherwise let the
# server boot against a broken/mismatched schema, surfacing as runtime 400s instead of a clear
# refuse-to-boot (the same posture as the strong-credentials block above). Refuse the deploy instead.
npx sequelize-cli db:migrate --env production || {
  echo "[FATAL] DB migration failed; refusing to boot against a possibly broken schema." >&2
  exit 1
}
exec "$@"
