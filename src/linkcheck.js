// Up/down status for saved links. A site that answers is alive, even with a
// login page or 401. Checks run on demand and are cached, so PROD sees at most
// one small request per link every few minutes.
const TTL_MS = 5 * 60000;
const CONCURRENCY = 6;
const NOT_IMPLEMENTED = 501; // Some servers refuse HEAD this way, but they are up.

function classify({ status, error }, vpnOff) {
  if (status !== undefined) {
    if (status >= 500 && status !== NOT_IMPLEMENTED) return { state: 'down', detail: `Server error ${status}` };
    return { state: 'up', detail: `Answered ${status}` };
  }
  // Redirects are not followed, so Electron reports them as an error.
  if (/Redirect was cancelled/.test(error)) return { state: 'up', detail: 'Answered with a redirect' };
  if (/ERR_CERT|ERR_SSL/.test(error)) return { state: 'up', detail: 'Answered, but its certificate is not trusted' };
  if (vpnOff) return { state: 'unknown', detail: 'No answer. The VPN is off, so this may be normal' };
  return { state: 'down', detail: 'No answer' };
}

// Only web links are ever requested.
function toRequestUrl(raw) {
  try {
    const url = new URL(/^www\./i.test(raw) ? `https://${raw}` : raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function createChecker({ probe, isVpnOff, onResult, ttlMs = TTL_MS, concurrency = CONCURRENCY, now = Date.now }) {
  const cache = new Map();
  let running = new Set();
  let generation = 0;

  async function checkOne(url, gen, inFlight) {
    const answer = await probe(toRequestUrl(url));
    inFlight.delete(url);
    if (gen !== generation) return; // Forgotten while running: the VPN changed.
    const result = { url, ...classify(answer, isVpnOff()) };
    cache.set(url, { result, at: now() });
    onResult(result);
  }

  // Returns what is already known. Everything else arrives through onResult.
  function check(urls, force = false) {
    const known = {};
    const queue = [];
    for (const url of new Set(urls)) {
      const hit = cache.get(url);
      if (running.has(url)) continue;
      if (hit && !force && now() - hit.at < ttlMs) known[url] = hit.result;
      else if (toRequestUrl(url)) queue.push(url);
    }
    const gen = generation;
    const inFlight = running;
    queue.forEach((url) => inFlight.add(url));
    const worker = async () => {
      while (queue.length) await checkOne(queue.shift(), gen, inFlight);
    };
    for (let i = 0; i < Math.min(concurrency, queue.length); i++) worker();
    return known;
  }

  function forget() {
    generation += 1;
    running = new Set();
    cache.clear();
  }

  return { check, forget };
}

module.exports = { classify, toRequestUrl, createChecker };
