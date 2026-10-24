// The one function every request of `load-plans.mjs` goes through, on its own
// so that the two rules it enforces can be tested without a network.
//
// 1. CHECK MODE IS READ-ONLY BY CONSTRUCTION. With `checkOnly`, anything but a
//    GET is refused here, before `fetch` is called -- not merely skipped by the
//    order of the code that calls it. A check run is what people run against
//    production to see what a real run would do, so it must not be able to
//    write even if a later edit calls the wrong thing in the wrong place.
//
// 2. ONLY A REQUEST THAT NEVER ARRIVED IS RETRIED. A month of the workbook is
//    several hundred round trips, and against a deployment a connection drops
//    sooner or later: the 2026 import died twice on UND_ERR_CONNECT_TIMEOUT. A
//    connection that was never established carries no request, so sending it
//    again cannot record a second day's work. A socket that dies with the
//    request on its way might have been answered, and repeating a POST on that
//    guess is how an import doubles a figure -- so those fail loudly instead.
export const NEVER_ARRIVED = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

export function createCaller({ api, checkOnly = false, fetchImpl = fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = console.warn } = {}) {
  if (!api) throw new Error('createCaller needs the API base address');
  const base = String(api).replace(/\/$/, '');
  return async function call(method, path, body, token, attempt = 1) {
    if (checkOnly && method !== 'GET') {
      throw new Error(`--check refused to send ${method} ${path}: check mode writes nothing`);
    }
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (networkError) {
      const code = networkError.cause?.code || networkError.code;
      if (!NEVER_ARRIVED.has(code) || attempt >= 5) throw networkError;
      const pause = 500 * 2 ** (attempt - 1);
      log(`${method} ${path} never reached the server (${code}); trying again in ${pause}ms`);
      await wait(pause);
      return call(method, path, body, token, attempt + 1);
    }
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 300) }; }
    return { status: response.status, body: parsed };
  };
}
