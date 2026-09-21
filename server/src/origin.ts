/**
 * Whether a request comes from a page this server should answer.
 *
 * A browser names the page it is acting for in `Origin` on every cross-site
 * request it makes — a fetch, a form post, a WebSocket handshake — and the
 * page cannot change it. So a request whose origin is not this server's own
 * came from somebody else's page. That matters most for the socket: CORS
 * governs only what a page may *read*, and a WebSocket handshake is not
 * subject to it at all, so a socket opened from a hostile page — carrying
 * whatever cookies the browser holds for this host — would otherwise be
 * accepted and could start runs.
 *
 * Same-origin means the origin's host is the `Host` the request arrived with,
 * which holds wherever the server is reached from: `localhost:3001` directly,
 * or a public hostname in front of a tunnel that passes `Host` through. It
 * needs no hostname written down.
 *
 * A request with no `Origin` is allowed. Browsers leave it off only for
 * same-origin requests and for cross-site ones that cannot read the
 * response, and every non-browser client — the smoke scripts, a probe —
 * sends none.
 *
 * `extra` lists origins allowed besides this one: in development, the Vite
 * client on its own port.
 */
export function allowedOrigin(
  origin: string | undefined,
  host: string | undefined,
  extra: readonly string[] = []
): boolean {
  if (!origin) return true;
  if (extra.includes(origin)) return true;
  if (!host) return false;
  try {
    return new URL(origin).host === host.toLowerCase();
  } catch {
    // `Origin: null` — a sandboxed frame, a file:// page — is nobody's page.
    return false;
  }
}
