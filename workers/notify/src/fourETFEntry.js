/* global URL */
// Four-ETF ingress wraps the unchanged relprice/notify handlers.
import notifyWorker from './relpriceEntry.js';
import { handleFourETFSignal } from './fourETFSignalRoute.js';
export { WsHub, stripDeviceIdentityFromAccountTestRequest } from './relpriceEntry.js';

export default {
  ...notifyWorker,
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/api/notify/internal/four-etf-signal') {
      return handleFourETFSignal(request, env);
    }
    return notifyWorker.fetch(request, env, ctx);
  }
};
