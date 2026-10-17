# Torrent Cloud

Send a magnet link or `.torrent` file to a cloud worker with one command. The worker downloads it
with aria2, uploads the result to S3-compatible storage and gives you back a fast, expiring
download link.

```bash
tc add "magnet:?xt=urn:btih:..." --wait
# [5678ac28cfa5]  downloading   63.0%  265.6 MB/420.9 MB  2.2 MB/s  peers 4  ...
# big_buck_bunny_720p_surround.mp4 (59.0 MB), expires 2026-10-18T07:59:30Z
# http://localhost:8333/torrent-cloud/5678ac28cfa5/...mp4?X-Amz-Signature=...
```

Architecture, security decisions and verification: [`docs/PLAN.md`](docs/PLAN.md).

```
tc CLI ──Bearer──► api (Node 22 / Fastify / SQLite) ──JSON-RPC──► aria2
                         │                                          │ /downloads volume
                         └── upload (S3 multipart) ──► SeaweedFS / S3 / R2 / B2 ── presigned link
```

## Quick start (local Docker)

Requirements: Docker, Node 22.13+.

```bash
npm install
npm run gen-env          # creates .env with random secrets (never commit it)
npm run build            # builds the CLI (and server for local runs)
docker compose up -d --build
export TC_API_TOKEN=...  # value of TC_API_TOKEN in .env
node cli/dist/tc.js add "magnet:?xt=urn:btih:..." --wait
```

- API: `http://127.0.0.1:8080` (status page at `/`, paste the token there).
- Links point to `S3_PUBLIC_ENDPOINT` (`http://localhost:8333` locally).
- Install the CLI globally with `npm i -g ./cli`, or save settings with
  `tc login --url <api-url> --token <token>`.

### CLI

```
tc add <magnet | file.torrent | https://.../file.torrent> [--zip] [--wait] [--json]
tc status <id> [--wait] [--json]
tc ls [--json]
tc rm <id>              # cancels and deletes local files and uploaded objects
```

`--zip` bundles multi-file torrents into one archive. For `https://` torrent URLs the CLI
downloads the `.torrent` itself; the server never fetches URLs (no SSRF).

## Demo

Offline and deterministic: a private tracker + seeder container seeds a generated 64 MB file.

```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d --build
npm run demo
```

Verified run (2026-10-17, this machine):

```
[1] magnet -> link             job done after 7.7 s, downloaded 64.0 MB, sha256 MATCHES
[2] .torrent file + --zip      job done after 4.7 s, demo-file.bin.zip size MATCHES
DEMO PASSED
```

Real swarm: `tc add https://archive.org/download/BigBuckBunny_124/BigBuckBunny_124_archive.torrent --wait`
downloaded 420.9 MB (CC-BY 3.0) in about 5 minutes and returned 13 working links; a tampered
signature and unsigned access both got HTTP 403.

## Configuration

See [`.env.example`](.env.example). Main options:

| Variable | Default | Meaning |
|---|---|---|
| `STORAGE_PROVIDER` | `s3` | `s3` (any S3-compatible) or `local` (served by the API with HMAC-signed links) |
| `S3_ENDPOINT` / `S3_PUBLIC_ENDPOINT` | `http://storage:8333` / `http://localhost:8333` | Internal endpoint for uploads / endpoint written into links |
| `LINK_TTL_SEC` | `86400` | Link lifetime (max 7 days); links are re-signed every time a job is read |
| `SEED_TIME_MIN` | `0` | Minutes to keep seeding after completion |
| `KEEP_LOCAL` | `false` | Keep files on the worker after upload |

To use a real bucket (AWS S3, Cloudflare R2, Backblaze B2), set `S3_ENDPOINT`,
`S3_PUBLIC_ENDPOINT`, region and keys, and remove the `storage` service.

## Development

```bash
npm run lint && npm run typecheck && npm test
```

Tests: server (Vitest, fake aria2 + local storage, full job flow), CLI (`node --test`).

## Before deploying to a real server

- Put a TLS reverse proxy (Caddy/Traefik) in front of the API; keep it off plain HTTP.
- Publishing BitTorrent port 51413 improves speed; it is commented out in `docker-compose.yml`
  until the host firewall is reviewed.
- aria2 contacts the trackers and web seeds named inside each torrent. It runs on its own Docker
  network (`engine`) and cannot reach the storage service, but on a cloud VM also block the
  instance metadata endpoint for containers, e.g.
  `iptables -I DOCKER-USER -d 169.254.169.254 -j DROP`. aria2 still has normal egress (host LAN,
  and `host.docker.internal` on Docker Desktop); an egress rule blocking private and link-local
  ranges for the aria2 container closes that remaining gap.
- One shared API token = single user. Multi-user accounts/quotas are not implemented.
- Only download content you have the right to download.

## Status & handoff (2026-10-17)

| Area | State |
|---|---|
| API + worker + CLI | Working MVP; lint, type-check and build clean; server tests 26/26, CLI tests 4/4 |
| Docker stack | aria2 + API + SeaweedFS run locally; `npm run demo` passes |
| Real-world run | Big Buck Bunny torrent (420.9 MB) downloaded and linked |
| Security review | Done; fixed auth bypass via encoded paths, token redaction, partial-upload cleanup, aria2 network isolation |
| Not done | aria2 egress firewall, TLS/deploy guide, extra providers, multi-user |

First-time repo setup:

1. `refs/`, `.env`, `demo/out/`, `node_modules/` and `dist/` are git-ignored. Check `git status`
   before the first commit and never commit `.env`.
2. Set the commit identity required by the company (`@dssolution.jp` email) before committing.
3. Re-create secrets on a new machine with `npm run gen-env`.

Research notes, decisions, gotchas and next steps for maintainers (and Claude Code):
[`docs/CLAUDE.md`](docs/CLAUDE.md).

## License

MIT.
