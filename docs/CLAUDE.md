# Torrent Cloud — notes for Claude / maintainers

Context, decisions and lessons from the first build session (2026-10-17). Read this before
changing the project. Plan and verification table: [`PLAN.md`](PLAN.md). User docs: [`../README.md`](../README.md).

## What it is

`tc add <magnet | .torrent | https://…/x.torrent> --wait` → a worker downloads the torrent with
aria2, uploads the files to S3-compatible storage and prints expiring presigned download links.
Locally the "cloud" is Docker Compose; the same images run on any VPS.

## Layout

```
aria2/            aria2c image (Alpine, aria2 1.37), entrypoint writes secrets into a private conf
storage/          SeaweedFS entrypoint (creates one S3 identity from env)
server/           API + worker (Node 22, TypeScript, Fastify 5, node:sqlite, AWS SDK v3)
  src/app.ts        routes, auth hook, log redaction
  src/worker.ts     polls aria2, job lifecycle, upload, zip, cleanup
  src/aria2.ts      minimal JSON-RPC client
  src/storage/      s3.ts (presigned links), local.ts (HMAC-signed links served by the API)
  src/sources.ts    magnet / .torrent validation
  src/paths.ts      path containment + object key sanitising
  public/index.html tiny status page (token kept in sessionStorage)
  test/             Vitest: units, full flow with fake aria2, upload failure
cli/              `tc` CLI, zero runtime deps, node --test
demo/seeder/      offline demo: bittorrent-tracker + aria2 seeder of a random file
scripts/          gen-env.mjs (random secrets → .env), demo.mjs (end-to-end check)
```

## Commands

```bash
npm install
npm run gen-env                     # never commit .env
npm run lint && npm run typecheck && npm test && npm run build
docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d --build
npm run demo                        # expects "DEMO PASSED"
docker compose -f docker-compose.yml -f docker-compose.demo.yml down
```

The CLI needs `TC_API_TOKEN` (from `.env`) and optionally `TC_API_URL` (default `http://127.0.0.1:8080`).

## Verified facts and decisions

| Topic | Finding | How verified |
|---|---|---|
| Engine | aria2 1.37.0 from Alpine; magnet → metadata gid, real download continues in `followedBy[0]` | docker run; `refs/mirror-leech-telegram-bot` aria2_listener.py |
| Seeding | `seed-time=0` stops seeding at completion (`SEED_TIME_MIN` env) | aria2 docs, `refs/aria2.conf` |
| Restart safety | aria2 `input-file` + `save-session` in `/downloads/.aria2.session` | entrypoint |
| Storage | `minio/minio` no longer exists on Docker Hub and quay.io needs auth → **SeaweedFS `chrislusf/seaweedfs:4.48`** (Apache-2.0) | `docker pull` |
| Job store | `node:sqlite` works on `node:22-alpine` (experimental warning only) | docker run |
| Links | Presigned with a second S3 client whose endpoint is `S3_PUBLIC_ENDPOINT`; re-signed on every `GET /v1/jobs/:id` | demo + manual 403 checks |
| Real swarm | Big Buck Bunny (archive.org, CC-BY) 420.9 MB in ~5 min, 13 links OK | manual run |

## Gotchas learned (do not regress)

- **Auth must use the matched route.** find-my-way percent-decodes paths, so `/%761/jobs` reached
  `/v1/jobs` while the hook only checked `req.url.startsWith('/v1/')`. The hook now checks
  `req.routeOptions.url` too. Test: `flow.test.ts` "cannot bypass auth".
- **Log redaction** must decode the URL first (`/%66iles/<token>` is the same route as `/files/<token>`).
- **Fastify `maxParamLength` defaults to 100**; signed link tokens are longer, so the route silently
  fell through to @fastify/static's wildcard (404). Set to 2048 in `app.ts`.
- **No SSRF from the API**: it accepts only magnet URIs and raw `.torrent` bytes; the CLI downloads
  `.torrent` URLs itself. aria2 still contacts trackers/web seeds named in torrents, so it lives on
  the `engine` network and cannot reach `storage`. Residual: normal egress (host LAN,
  `host.docker.internal`, cloud metadata) → block with firewall rules when deploying.
- **Upload failure cleanup**: objects are registered before each `put`, and the zip step is inside the
  same `try`, so `discard()` removes partial uploads and local files.
- Files reported by aria2 must pass `resolveInside(jobDir, path)`; otherwise the job fails.
- Windows/Git Bash: `/tmp` in bash and in Node are different folders; keep temp files inside the
  repo or the scratch dir when mixing both. `npx tsc` without a local `typescript` dependency
  installs the wrong `tsc` package (each workspace declares `typescript`).

## Conventions and rules

- English only in code, comments, logs, UI text and docs.
- Secrets only via `.env` (generated, git-ignored); `.env.example` holds placeholders. Never log
  tokens, Authorization headers or presigned URLs.
- Ports are published on `127.0.0.1` only. The BitTorrent port stays commented out until the host
  firewall is reviewed.
- Company rule: commits must use a `@dssolution.jp` author/committer email. Auth, infra/compose and
  security changes need human review before merge.

## Open items / next steps

1. Egress firewall for the aria2 container (private + link-local ranges) for cloud deployment.
2. TLS reverse proxy (Caddy/Traefik) and a deploy guide for a VPS.
3. More providers: rclone (Google Drive/OneDrive), Telegram, gofile.
4. Multi-user accounts/quotas; currently one shared token.
5. Optional: retry failed uploads instead of failing the job; streaming while downloading.

## Reference repos (git-ignored `refs/`, re-clone if needed; read-only, no code copied)

```bash
mkdir -p refs && cd refs
git clone --depth 1 https://github.com/jpillora/cloud-torrent.git              # AGPL-3.0, concept
git clone --depth 1 https://github.com/anasty17/mirror-leech-telegram-bot.git  # GPL-3.0, aria2 → upload flow
git clone --depth 1 https://github.com/P3TERX/aria2.conf.git                    # aria2 tuning
git clone --depth 1 https://github.com/webtorrent/bittorrent-tracker.git        # MIT, demo tracker
```
