# Cloudflare → cn one-time migration

Run export on **your local machine** using your existing Wrangler login. The
Cloudflare connector is blocked (authd 403); these scripts never use it.

## Prerequisites

- A checkout of this repository, including `services/cn-data` and Worker configs.
- Node >= 22.13 (the `node:sqlite` API is required), Bash, npm/npx.
- A current Wrangler CLI with `kv bulk get`, logged in with `npx wrangler login`.
- SSH/SCP access to the cn host and permission to write the service database.

The three Worker configs currently reference the same D1 `ai-dca-sync-db`.
Export discovers and deduplicates actual database IDs from their TOML files.
It also discovers NOTIFY_STATE (`d3d7cf8351b24070a156649fdd50790d`) and
SYNC_BACKUPS (`34af9b7435a84b5290e179875d272f27`). It never uses preview IDs.

## Procedure

1. Put browser writes into maintenance mode and stop other writers to these
   CF datasets. Wait at least 60 seconds for KV propagation. Keep writes frozen
   until verification/cutover; D1 and KV exports are not a joint snapshot.
2. On your local machine, from the repository root:

   ```bash
   bash scripts/migrate-cf-to-cn/export-cf.sh
   # Optional explicit destination (must not already exist):
   bash scripts/migrate-cf-to-cn/export-cf.sh /secure/path/cf-export-20261012
   ```

   Output is `cf-export-YYYYMMDD/`: full D1 SQL recovery dumps, selected D1 table
   JSONL files, KV JSONL files, and a manifest written only after success.
   JSONL means one JSON object per line. Retain the whole directory.
   Failed exports have no manifest: fix the error and retry into a new directory.
   Wrangler's `kv key list` internally follows API pagination and returns the
   complete key array; do not manually truncate that array. Values are retrieved
   sequentially in batches of at most 100 with `kv bulk get`.
   Export includes the three NOTIFY_STATE prefixes `holdings-rule:`,
   `switch:config:`, `switch:snapshot:` and all SYNC_BACKUPS keys (including
   historical versions). No additional credentials are required.
3. Copy the directory to the cn host (substitute your SSH host/path):

   ```bash
   scp -r cf-export-20261012 CN_HOST:/secure/migration/
   ```

4. On cn, stop cn-data **and its sync daemon**, and back up the existing SQLite
   database before import. With all processes stopped, copy the database and
   any existing `-wal`/`-shm` sidecars together into a protected backup directory.
   Use a checkout containing the same scripts and Phase 1 service schema:

   ```bash
   export CN_DATA_DB_PATH=/var/lib/ai-dca-cn-data/cn-data.db
   node scripts/migrate-cf-to-cn/import-to-cn.mjs /secure/migration/cf-export-20261012
   node scripts/migrate-cf-to-cn/verify.mjs /secure/migration/cf-export-20261012
   ```

   Both commands also accept an explicit database path as their second argument.
   Import stages and validates the entire export first, then writes all five
   target tables in one SQLite transaction using INSERT OR REPLACE. Re-running
   overwrites matching keys with identical rows. It does not remove unrelated cn
   rows or enqueue sync events. Verification requires exact mapped total and
   per-user counts and compares up to five random payload SHA-256 hashes plus
   all columns per table. Extra cn rows cause FAIL; reconcile them explicitly.
   Any malformed/incomplete data or key collision aborts import without writing
   target rows. Errors return nonzero; fix the source issue, never ignore FAIL.
5. Save the verification output as your report. Restart the service, perform
   your cutover procedure, then reopen writes. Initial full redundant sync is a
   separate operation: the importer intentionally leaves `sync_outbox` alone.

## Mapping and preserved data

- The plan's `notify_features`/`notify_links` names differ from current code:
  current tables are `notify_user_feature_items`/`notify_registration_links`.
  Both names are supported. Active feature rows map owner/client/item/feature
  to user/client/rule/type, preserving payload and timestamps. Deleted feature
  and link rows are counted as skipped. Feature names (`plans`, `dca`, etc.)
  remain supported cn rule types. Duplicate item IDs across features abort
  because the cn primary key lacks a feature dimension.
- Links have no cn rule equivalent; preserve whole rows in notify_configs under
  `registration-link:<JSON [registration_id,client_id]>`.
- `holdings-rule:account:<user>` maps to config_key `holdings-rule`;
  `switch:config:account:<user>` maps to `switch-config`; snapshots preserve the
  original full key. Other clients use `legacy:<client>` as their user identity.
  Never guess an account owner. KV timestamps use payload timestamps or the
  manifest export timestamp. Two configurations colliding on a target key fail.
- Account main rows retain all schema columns, revisions and tombstones. Active
  `account_resource_records` are assembled with the Worker's own codec into
  `account_resources` payloads; derived bytes and hash are recomputed. History,
  metadata and migration tables remain in exports, with skipped counts reported,
  because Phase 1 has no corresponding tables.
- D1 `backups.envelope` is preferred; empty envelopes fall back to the exact
  `kv_key` in SYNC_BACKUPS. Ciphertext checksums are checked when present.
  Encrypted JSON is preserved without decryption; version/timestamp are retained.
  `sync_events` and historical backup versions are retained in exports only;
  they are **not** converted to pending cn sync_outbox work.
- notify_user_records remain archived. Only the explicitly requested KV prefixes
  are imported; D1-only notification channel/settings/state records are outside
  this migration's scope. Review the skipped summary before cutover.

JSONL import/verification stages source and expected rows on disk, streams rows,
and holds at most one reconstructed resource in memory. Temporary disk space
must accommodate two SQLite staging databases. Export loads a complete D1 SQL
file and each namespace prefix's key list in memory, and warns accordingly:
use a machine with RAM for the largest dump/list. A resource's complete payload
must also fit RAM. SQL is executed only in an isolated local staging database;
use exports you trust. Export dumps contain account/auth data and channel
secrets: keep directory permissions private and transfer over SSH.

## Rollback

Before cutover, failure requires no CF rollback: export/import never change CF.
Stop cn-data and its daemon, restore the saved cn database and its matching
sidecars (remove migration-created sidecars first), then restart using the old
routing. If no cn database existed before import, remove the newly created
cn database and sidecars while stopped.

After cutover, freeze writes first. Preserve a fresh backup of cn before restoring
anything; changes made after migration are not present in the CF export. Revert
your frontend/nginx routing using the deployment's actual rollback procedure
(the planned environment switch is not implemented by these scripts). Reconcile
post-cutover writes before reopening CF writes. Retain SQL/JSONL exports for
recovery; do not blindly replay the full D1 SQL over a live database, since it
includes users/sessions and unrelated operational data.
