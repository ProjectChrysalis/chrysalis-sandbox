// Internet access for the guest. Nothing here opens a connection of its own:
// every request goes to the engine's proxy (a capability URL the host hands
// the session), which makes it server-side and refuses the user's machine and
// network. Requests are synchronous because the guest is a wasm stack frame
// below every call.
import { fetchSync } from "./loader.mjs";

const EMPTY = new Uint8Array(0);

// Headers a browser will not let a request set. They travel under a prefix
// and the engine's proxy puts them back on the real request; the ones that
// describe the hop itself (Host, Content-Length) are the proxy's to set.
const FORBIDDEN = new Set(["accept-charset", "accept-encoding", "access-control-request-headers", "access-control-request-method", "connection", "content-length", "cookie", "cookie2", "date", "dnt", "expect", "host", "keep-alive", "origin", "referer", "set-cookie", "te", "trailer", "transfer-encoding", "upgrade", "user-agent", "via"]);
const HOP = new Set(["host", "content-length", "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade", "expect"]);
const forwardable = (headers) => {
  const out = [];
  for (const [name, value] of headers ?? []) {
    const lower = String(name).toLowerCase();
    if (HOP.has(lower)) continue;
    if (FORBIDDEN.has(lower) || lower.startsWith("proxy-") || lower.startsWith("sec-")) out.push([`x-chrysalis-h-${lower}`, value]);
    else out.push([name, value]);
  }
  return out;
};

const parseHeaders = (raw) => {
  const out = [];
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at > 0) out.push([line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()]);
  }
  return out;
};

/** `proxy` is the prefix the target URL is appended to (encoded), or null
 *  when the user turned internet access off. */
export function makeNet({ proxy = null, offReason = "internet access is off (Settings, Agent)" } = {}) {
  return {
    enabled: Boolean(proxy),
    offReason,
    /** { status, headers: [[name, value]], body, error } — error is set when
     *  no HTTP answer came back from the target (refused, unreachable, off). */
    request({ url, method = "GET", headers = [], body = null }) {
      if (!proxy) return { status: 0, headers: [], body: EMPTY, error: offReason };
      if (!/^https?:\/\//i.test(url)) return { status: 0, headers: [], body: EMPTY, error: `unsupported URL: ${url}` };
      let res;
      try {
        res = fetchSync(proxy + encodeURIComponent(url), { method, headers: forwardable(headers), body });
      } catch (error) {
        return { status: 0, headers: [], body: EMPTY, error: (error && error.message) || String(error) };
      }
      const list = parseHeaders(res.headers);
      // The proxy marks answers it made itself (refusals, lookups that
      // failed) so they are never mistaken for the site's own response.
      if (list.some(([name]) => name === "x-chrysalis-proxy")) {
        return { status: 0, headers: [], body: EMPTY, error: new TextDecoder().decode(res.body).trim().replace(/^sandbox network: /, "") };
      }
      if (res.status === 0) return { status: 0, headers: [], body: EMPTY, error: "the request did not complete" };
      return { status: res.status, headers: list, body: res.body, error: null };
    },
  };
}
