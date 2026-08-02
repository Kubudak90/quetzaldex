# nginx configs

## faucet.quetzaldex.xyz.conf

TLS-terminating reverse proxy for the Sub-7a Quetzal Faucet (`https://faucet.quetzaldex.xyz/` → `127.0.0.1:3130` on VPS `161.97.110.1`).

## Operator deploy steps

(Performed once; subsequent faucet deploys don't touch nginx.)

### 1. DNS — Vercel dashboard

Dashboard → Domains → `quetzaldex.xyz` → DNS Records → Add:
- Name: `faucet`
- Type: `A`
- Value: `161.97.110.1`
- TTL: 60

Verify:
```
dig +short A faucet.quetzaldex.xyz
```
Expected: `161.97.110.1`.

### 2. nginx + certbot on VPS

```
ssh root@161.97.110.1
apt-get update && apt-get install -y nginx certbot python3-certbot-nginx
```

### 3. Install the server-block

```
scp infra/nginx/faucet.quetzaldex.xyz.conf root@161.97.110.1:/etc/nginx/sites-available/
ssh root@161.97.110.1 'ln -sf /etc/nginx/sites-available/faucet.quetzaldex.xyz.conf /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx'
```

### 4. Issue the Let's Encrypt cert

```
ssh root@161.97.110.1 'certbot --nginx -d faucet.quetzaldex.xyz --non-interactive --agree-tos -m huseyinarslan89@hotmail.com'
```

certbot will edit the server-block in place to point to the issued cert paths (which matches what's already in the template). Auto-renewal is enabled by the certbot systemd timer.

### 5. Smoke test

```
curl -I https://faucet.quetzaldex.xyz/api/health
```
Expected: `HTTP/2 200`.

## Notes

- `proxy_read_timeout 600s` — accommodates the L1 bridge call (which waits for Sepolia tx confirmation ~12-60s) plus L2 mint calls (each ~6-10s with ClientIVC proving).
- `X-Forwarded-For` + `X-Real-IP` headers are forwarded — the faucet's rate-limit middleware reads `x-forwarded-for` first.
- The 80→443 redirect leaves `/.well-known/acme-challenge/` open for certbot's HTTP-01 challenge renewals.
