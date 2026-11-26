import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const source = read("src/app/oldSiteMove.js");

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
}

async function loadModule() {
  return import(path.join(root, "src/app/oldSiteMove.js"));
}

test("old site move only accepts app data keys and never credentials or caches", async () => {
  const { isOldSiteMoveKey } = await loadModule();
  for (const key of ["aiDcaFundHoldingsLedger", "markets:watchlist:v1", "holdings:lastTransaction", "react-fund-holdings-ledger"]) {
    assert.equal(isOldSiteMoveKey(key), true, key);
  }
  for (const key of ["aiDcaCloudSyncSession", "aiDcaSecureSyncRememberedKey", "aiDcaAnalyticsVisitorId_v1", "markets:direct-quotes:v1", "site:region", "token"]) {
    assert.equal(isOldSiteMoveKey(key), false, key);
  }
});

test("old site import never overwrites data already on the new site", async () => {
  const { importOldSiteEntries } = await loadModule();
  const storage = memoryStorage({ aiDcaPlanStore: "new" });
  const result = importOldSiteEntries({ aiDcaPlanStore: "old", aiDcaTradeLedger: "[1]", aiDcaCloudSyncSession: "x", aiDcaDcaStore: 5 }, storage);
  assert.deepEqual(result.imported, ["aiDcaTradeLedger"]);
  assert.equal(storage.getItem("aiDcaPlanStore"), "new");
  assert.equal(storage.getItem("aiDcaCloudSyncSession"), null);
});

test("receiver only trusts the old site origin and is wired into the entry", async () => {
  const { isOldSiteMoveRequest } = await loadModule();
  assert.equal(isOldSiteMoveRequest({ search: "?from=old-site" }), true);
  assert.equal(isOldSiteMoveRequest({ search: "?from=other" }), false);
  assert.match(source, /event\.origin !== OLD_SITE_ORIGIN/);
  assert.match(source, /OLD_SITE_ORIGIN = 'https:\/\/freebacktrack\.tech'/);
  assert.match(source, /isRemoteAccountSessionActive\(\)/);
  const entry = read("src/entry-screen.jsx");
  assert.match(entry, /startOldSiteMoveReceiver\(\);/);
});

test("legacy encrypted backup migration notice also shows on the fast site", () => {
  const modal = read("src/components/account-data-migration-modal.jsx");
  assert.match(modal, /host === 'fast\.freebacktrack\.tech'/);
});
