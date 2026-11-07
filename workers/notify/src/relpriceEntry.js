/* global URL */
// Independent signal ingress; preserve the existing fetch/queue/cron handlers.
import notifyWorker from './accountEntry.js';
import { handleRelpriceSignal } from './relpriceSignalRoute.js';
export { WsHub, stripDeviceIdentityFromAccountTestRequest } from './accountEntry.js';

export default {
  ...notifyWorker,
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/api/notify/internal/relprice-signal') {
      return handleRelpriceSignal(request, env);
    }
    return notifyWorker.fetch(request, env, ctx);
  }
};
