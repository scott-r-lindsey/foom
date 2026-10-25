import type { ManifestChannel, ManifestSelector } from "../../../shared/agent-manifest-v2";

/** Fixed context-event plugin ABI. Manifests supply selectors and event names, never source. */
export function eventModule(channel: ManifestChannel): string {
  const selectors: ManifestSelector[] = [
    channel.mapping.session,
    channel.mapping.event,
    ...(channel.mapping.sessionAliases ?? []),
  ];
  if (channel.mapping.dedupe) selectors.push(channel.mapping.dedupe);
  for (const entry of channel.mapping.cases) {
    for (const test of [...(entry.when?.all ?? []), ...(entry.when?.any ?? [])])
      if (typeof test.field !== "string") selectors.push(test.field);
    selectors.push(
      ...entry.require.map((item) => item.field),
      ...entry.facts.map((item) => item.field),
    );
  }
  const paths = selectors.filter((item) => item.source === "payload").map((item) => item.path);
  return `import http from 'node:http';
const channel = ${JSON.stringify(channel.id)};
const events = ${JSON.stringify([...new Set(channel.mapping.cases.map((entry) => entry.event))])};
const eventPath = ${JSON.stringify(channel.mapping.event.path)};
const paths = ${JSON.stringify(paths)};
function select(value, path) {
  for (const key of path) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return;
    value = value[key];
  }
  return value;
}
function reduce(event) {
  const result = Object.create(null);
  for (const path of paths) {
    const value = select(event, path);
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'string' && value.length > 4096)) continue;
    let target = result;
    for (const key of path.slice(0, -1)) target = target[key] ??= Object.create(null);
    target[path.at(-1)] = value;
  }
  return result;
}
function send(payload, signal) {
  return new Promise(resolve => {
    const env = process.env;
    let url;
    try { url = new URL(env.FOOM_HOOK_URL); } catch { resolve(); return; }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/hooks' || url.username || url.password || url.search || url.hash || !/^[a-f0-9]{64}$/.test(env.FOOM_TOKEN ?? '') || !/^[a-f0-9-]{36}$/.test(env.FOOM_SESSION ?? '') || env.FOOM_HOOK_PROTOCOL !== '1') { resolve(); return; }
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 65536) { resolve(); return; }
    const request = http.request(url, {method:'POST', agent:new http.Agent({proxyEnv:{}}), signal, headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'X-Foom-Session':env.FOOM_SESSION,'X-Foom-Channel':channel,Authorization:env.FOOM_TOKEN}}, response => { response.resume(); response.on('end', resolve); response.on('error', resolve); });
    const deadline = setTimeout(() => request.destroy(), 1000);
    request.on('close', () => { clearTimeout(deadline); resolve(); });
    request.on('error', resolve);
    request.end(body);
  });
}
export default {
  id: 'foom-observer-' + channel,
  setup(context) {
    const abort = new AbortController();
    if (process.env.FOOM_HOOK_PROTOCOL !== '1' || !process.env.FOOM_TOKEN || !process.env.FOOM_SESSION || !process.env.FOOM_HOOK_URL) return () => abort.abort();
    void (async () => {
      try {
        for await (const event of context.event.subscribe({signal:abort.signal})) {
          if (events.includes(select(event, eventPath))) await send(reduce(event), abort.signal);
        }
      } catch {}
    })();
    return () => abort.abort();
  }
};
`;
}
