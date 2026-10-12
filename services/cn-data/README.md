# CN data service

Local primary storage for notification rules/configuration, account transactions/resources,
and encrypted sync backups. Uses only Node builtins, SQLite WAL, forward-only SQL
migrations, and a transactional outbox. The HTTP service never contacts Cloudflare;
a separate daemon sends committed changes to redundant Worker copies.

## Run

Requires Node >=22.5 with `node:sqlite` support (Node 22.5–22.12 may require
`NODE_OPTIONS=--experimental-sqlite`). No npm install is needed.

```sh
cd services/cn-data
CN_DATA_DB_PATH=./cn-data.db npm start
```

The server binds **127.0.0.1:8081**. Run the daemon as a separate process using the
same absolute database path:

```sh
export CN_DATA_DB_PATH=/absolute/path/cn-data.db
export SYNC_DAEMON_NOTIFY_URL=https://api.example.com
export SYNC_DAEMON_ACCOUNT_URL=https://api.example.com
export SYNC_DAEMON_SYNC_URL=https://api.example.com
export INTERNAL_SYNC_TOKEN='your-internal-token'
npm run sync
```

SIGINT/SIGTERM stop the HTTP server or wait for the active daemon batch before
closing SQLite. Configure nginx to preserve `/api/...` request paths.

## Environment

| Variable | Default / purpose |
| --- | --- |
| `CN_DATA_DB_PATH` | `/var/lib/ai-dca-cn-data/cn-data.db`; shared by both processes |
| `CN_DATA_PORT` | `8081`; loopback HTTP port |
| `SYNC_DAEMON_INTERVAL_MS` | `30000`; delay between completed batches |
| `SYNC_DAEMON_NOTIFY_URL` | Required daemon origin for notify Worker |
| `SYNC_DAEMON_ACCOUNT_URL` | Required daemon origin for account Worker |
| `SYNC_DAEMON_SYNC_URL` | Required daemon origin for sync Worker |
| `INTERNAL_SYNC_TOKEN` | Required daemon Bearer credential |

Daemon configuration is validated before claiming events. Destination URL paths
are fixed as listed below; environment URLs select their origins.

## HTTP API

Responses and bodies are JSON. Errors consistently use `{ "message": "..." }`.
CORS supports GET/POST/PUT/DELETE/OPTIONS. Bodies must be JSON objects and are
limited to 2 MiB; individual transaction payloads are limited to 64 KiB.

**Phase 1 identity contract:** `user_id` is required in query parameters for reads
and in the query or JSON body for writes. Conflicting query/body identities return
400. Identity is currently trusted; session verification through nginx/auth must
be implemented before public exposure. No auth service changes are included.

| Method/path | Parameters/body | Response |
| --- | --- | --- |
| `GET /health` | None | `{ok, outbox: {pending, processing, dead}}` |
| `GET /api/notify/rules` | `user_id`, optional `client_id` | `{rules: [...]}` |
| `POST /api/notify/rules` | `user_id`, `rule_id`, `rule_type`, `payload`, optional `client_id` (default `""`), `enabled` (default true) | `{rule: {...}}` |
| `DELETE /api/notify/rules/:rule_id` | `user_id`, optional `client_id` in query/body (default `""`) | `{ok: true}` |
| `GET /api/notify/configs` | `user_id`, optional `config_key` | `{configs: [...]}` |
| `POST /api/notify/configs` | `user_id`, `config_key`, `payload` | `{config: {...}}` |
| `GET /api/account/transactions` | `user_id` | `{transactions: [...]}` |
| `POST /api/account/transactions` | `user_id`, `transaction_id`, `payload`; optional account metadata below | `{transaction: {...}}` |
| `GET /api/account/resources` | `user_id` | `{resources: [...]}` |
| `POST /api/account/resources` | `user_id`, `resource`, `feature`, `payload`; optional account metadata below | `{resource: {...}}` |
| `GET /api/sync/backup` | `user_id` | `{backup: {...}}`, or `{backup: null}` if absent |
| `PUT /api/sync/backup` | `user_id`, `payload`, optional `expected_version` | `{backup: {...}}` |

Successful writes return 200. Read rows use SQLite snake_case column names with
`payload` decoded as JSON. Account schemas preserve the corresponding Worker
columns. This phase stores complete resource payloads in `account_resources`;
Worker record/history tables and existing frontend API compatibility belong to
later migration phases.

Account writes accept `updated_by_end_id`, `updated_by_end_type`, `deleted`, and
`expected_revision`; resources also accept a nonnegative `item_count` (defaults
to array length or 1). Revisions are generated locally, starting at 1 and
incrementing on each write. Backup versions follow the same rule. An optional
expected revision/version mismatch returns 409 without modifying data or outbox.
Hashes are SHA-256 of the stored JSON; bytes use UTF-8 byte length.
`deleted: true` writes a tombstone with null payload; account reads exclude
these rows. Rule deletes are scoped by user/client/rule and enqueue a deletion
even when the row is already absent, allowing the replica to converge.

```sh
curl http://127.0.0.1:8081/api/notify/rules \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"usr_1","client_id":"web","rule_id":"rule_1","rule_type":"holding-alert","payload":{"symbol":"600000"}}'
curl 'http://127.0.0.1:8081/api/notify/rules?user_id=usr_1&client_id=web'
```

## Replication

Each business write and its outbox insertion commit in the same `BEGIN IMMEDIATE`
transaction. Payloads contain the complete resulting row (with decoded JSON), or
rule deletion identity and timestamp. Targets and event types:

| Target | Event types | POST path |
| --- | --- | --- |
| `notify` | `upsert-rule`, `delete-rule`, `upsert-config` | `/api/notify/internal/sync-rules` |
| `account` | `upsert-transaction`, `upsert-resource` | `/api/account/internal/sync` |
| `sync` | `upsert-backup` | `/api/sync/internal/sync-backup` |

The daemon claims at most 20 due events per batch and sends sequentially, with a
15-second timeout covering response handling. Each POST has
`{eventId, eventType, payload}` and `Authorization: Bearer ...`. Successful events
are removed. Network failures, 429 and 5xx retry with exponential backoff and
±10% jitter (5-second base, exponent uses incremented retry count; first retry
approximately 10 seconds; nominal cap 30 minutes). Rate limits wait at least
60 seconds and respect longer `Retry-After` values. Other unsuccessful HTTP
responses become dead letters with a bounded `last_error`.

Processing claims older than 10 minutes are recovered for retry. Delivery is
at least once; Worker receivers must deduplicate event IDs and reject stale
revisions/timestamps because retries can arrive after newer changes. Run one
daemon per database. Dead letters remain available in SQLite for inspection;
there is no automatic dead-letter replay endpoint. Worker receiving endpoints,
nginx/frontend cutover, data import, and deployment are outside this change.

## Tests

```sh
node --test "test/*.test.mjs"
# or
npm test
```

Tests use in-memory SQLite for routes/outbox/daemon and a temporary database for
WAL and migration persistence. From the repository root also run
`npm run check:refactor`, `npm run lint -- --quiet`, and `git diff --check`.
