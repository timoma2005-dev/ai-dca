// Run with the connected Cloudflare request adapter. No API token is stored.
// Preserve live source bytes and every binding; never rebuild the old Worker.
export async function deployFourETF({ request, accountId, entry, route, expectedVersion, dryRun = false }) {
  const base = `/accounts/${accountId}/workers/scripts/ai-dca-notify`;
  const [settingsResponse, deploymentsResponse, schedulesResponse, content] = await Promise.all([
    request({ method: 'GET', path: base + '/settings' }),
    request({ method: 'GET', path: base + '/deployments' }),
    request({ method: 'GET', path: base + '/schedules' }),
    request({ method: 'GET', path: base })
  ]);
  const settings = settingsResponse.result;
  const deployment = deploymentsResponse.result.deployments[0];
  if (deployment.versions.length !== 1 || deployment.versions[0].percentage !== 100 || deployment.versions[0].version_id !== expectedVersion) throw new Error('Live version changed; re-inspect before upload');
  if (typeof content !== 'string' || !content.startsWith('--')) throw new Error('Expected text-module multipart download');
  const boundary = content.slice(0, content.indexOf('\r\n'));
  const downloaded = content.split(boundary).slice(1, -1).map(part => {
    const at = part.indexOf('\r\n\r\n');
    const name = /name="([^"]+)"/.exec(part.slice(0, at))?.[1];
    if (at < 0 || !/^[\w.-]+\.(js|map)$/.test(name || '')) throw new Error('Unexpected live module');
    return { name, code: part.slice(at + 4, -2) };
  });
  const byName = Object.fromEntries(downloaded.map(m => [m.name, m.code]));
  if (!byName['relpriceEntry.js'] || !byName['relpriceSignalRoute.js'] || !byName['accountEntry.js']?.includes('export { deliverAccountNotification };')) throw new Error('Expected unchanged relprice wrapper and account export');
  if (Boolean(byName['fourETFEntry.js']) !== Boolean(byName['fourETFSignalRoute.js'])) throw new Error('Partial four-ETF ingress; inspect before update');
  // Only our two modules can be replaced during a guarded follow-up upload.
  const modules = downloaded.filter(m => !['fourETFEntry.js', 'fourETFSignalRoute.js'].includes(m.name));
  const sha = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), x => x.toString(16).padStart(2, '0')).join('');
  const manifest = async parts => Object.fromEntries(await Promise.all(parts.map(async p => [p.name, await sha(p.code)])));
  const oldHashes = await manifest(modules);
  const importLine = "import { deliverAccountNotification } from './accountDeliveryRoute.js';";
  if (route.split(importLine).length !== 2) throw new Error('Unexpected route import');
  const uploadedRoute = route.replace(importLine, "import { deliverAccountNotification } from './accountEntry.js';");
  modules.push({ name: 'fourETFEntry.js', code: entry }, { name: 'fourETFSignalRoute.js', code: uploadedRoute });
  const metadata = { main_module: 'fourETFEntry.js', keep_bindings: [...new Set(settings.bindings.map(b => b.type))],
    annotations: { 'workers/message': 'Four-ETF confirmed-switch email ingress; retain all relprice modules and settings' } };
  for (const key of ['compatibility_date', 'compatibility_flags', 'usage_model', 'placement', 'limits', 'observability', 'logpush', 'tail_consumers', 'tags']) {
    if (settings[key] !== undefined) metadata[key] = settings[key];
  }
  const allHashes = await manifest(modules);
  if (dryRun) return { dry_run: true, current_version: expectedVersion, original_modules: oldHashes, modules: allHashes, metadata, binding_count: settings.bindings.length };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  for (const part of modules) form.append(part.name, new Blob([part.code], { type: part.name.endsWith('.map') ? 'application/source-map' : 'application/javascript+module' }), part.name);
  const upload = await request({ method: 'PUT', path: base, body: form });
  if (!upload.success) throw new Error('Upload failed');
  const canonical = value => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',')}}`;
    return JSON.stringify(value);
  };
  const [afterSettings, afterDeployments, afterSchedules, afterContent] = await Promise.all([
    request({ method: 'GET', path: base + '/settings' }), request({ method: 'GET', path: base + '/deployments' }),
    request({ method: 'GET', path: base + '/schedules' }), request({ method: 'GET', path: base })
  ]);
  const afterBoundary = afterContent.slice(0, afterContent.indexOf('\r\n'));
  const afterModules = afterContent.split(afterBoundary).slice(1, -1).map(part => {
    const at = part.indexOf('\r\n\r\n');
    return { name: /name="([^"]+)"/.exec(part.slice(0, at))[1], code: part.slice(at + 4, -2) };
  });
  const hashesAfter = await manifest(afterModules);
  const originalPreserved = Object.entries(oldHashes).every(([name, hash]) => hashesAfter[name] === hash);
  const bindingsPreserved = canonical([...settings.bindings].sort((a, b) => a.name.localeCompare(b.name))) === canonical([...afterSettings.result.bindings].sort((a, b) => a.name.localeCompare(b.name)));
  const settingsPreserved = ['compatibility_date', 'compatibility_flags', 'usage_model', 'placement', 'limits', 'observability', 'logpush', 'tail_consumers', 'tags'].every(k => canonical(settings[k]) === canonical(afterSettings.result[k]));
  const schedulesPreserved = canonical(schedulesResponse.result) === canonical(afterSchedules.result);
  return { success: originalPreserved && bindingsPreserved && settingsPreserved && schedulesPreserved,
    rollback_version: expectedVersion, deployment: afterDeployments.result.deployments[0],
    original_modules_before: oldHashes, modules_after: hashesAfter, expected_modules: allHashes,
    original_modules_preserved: originalPreserved, bindings_preserved: bindingsPreserved,
    settings_preserved: settingsPreserved, schedules_preserved: schedulesPreserved, binding_count: settings.bindings.length,
    handlers: upload.result?.handlers, named_handlers: upload.result?.named_handlers };
}
