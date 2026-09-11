type Row = Record<string, any>;
type Config = { url: string; key: string; origin: string; fetcher?: typeof fetch };

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export async function hashTicket(ticket: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ticket));
  return [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, "0")).join("");
}
export function newTicket(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
const safeErrors = [
  "Allowance used; request a replacement",
  "Approval required",
  "Release unavailable",
  "Link expired or already used",
  "Approval revoked",
  "Account unavailable",
  "Please wait a minute before claiming again",
  "Daily request limit reached",
  "Claim the initial link first",
  "Request already resolved",
];
export function createHandler(config: Config) {
  const fetcher = config.fetcher ?? fetch;
  const base = config.url.replace(/\/$/, "");
  const endpoint = `${base}/functions/v1/portal`;
  const headers = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": config.origin,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    Vary: "Origin",
  };
  async function service(
    path: string,
    method = "GET",
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    const response = await fetcher(`${base}${path}`, {
      method,
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        "Content-Type": "application/json",
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const safe = safeErrors.find((message) => error.message === message);
      if (error.code === "23505")
        throw new HttpError(409, "A matching request or release already exists.");
      throw new HttpError(
        safe ? 403 : 500,
        safe || "The service could not complete that operation.",
      );
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  const rpc = (name: string, body: Row) => service(`/rest/v1/rpc/${name}`, "POST", body);
  const read = (name: string, query: string) =>
    service(`/rest/v1/portal_${name}?${query}`) as Promise<Row[]>;
  async function account(request: Request) {
    const authorization = request.headers.get("Authorization") || "";
    if (!authorization.startsWith("Bearer ")) throw new HttpError(401, "Sign in to continue.");
    const response = await fetcher(`${base}/auth/v1/user`, {
      headers: { apikey: config.key, Authorization: authorization },
    });
    if (!response.ok) throw new HttpError(401, "Your session expired. Sign in again.");
    const user = await response.json();
    if (!user.id || !user.email || !user.email_confirmed_at)
      throw new HttpError(403, "Confirm your email before continuing.");
    // No admin/allowance fields are taken from user metadata or request bodies.
    await service(
      "/rest/v1/portal_accounts?on_conflict=user_id",
      "POST",
      { user_id: user.id, email: user.email },
      { Prefer: "resolution=merge-duplicates,return=minimal" },
    );
    const [profile] = await read("accounts", `user_id=eq.${encodeURIComponent(user.id)}&select=*`);
    return profile;
  }
  async function dashboard(user: Row) {
    const uid = encodeURIComponent(user.user_id);
    const [modules, releases, approvals, grants, requests] = await Promise.all([
      read("modules", "select=id,title&order=title"),
      read(
        "releases",
        "select=id,module_id,version,created_at&published=eq.true&order=created_at.desc",
      ),
      read("approvals", `user_id=eq.${uid}&select=module_id,active`),
      read(
        "grants",
        `user_id=eq.${uid}&select=id,release_id,created_at,expires_at,consumed_at&order=created_at.desc`,
      ),
      read("requests", `user_id=eq.${uid}&select=*&order=created_at.desc`),
    ]);
    const result: Row = { account: user, modules, releases, approvals, grants, requests };
    if (user.is_admin) {
      const [accounts, queue, policies] = await Promise.all([
        read("accounts", "select=*&order=email"),
        read("requests", "status=eq.pending&select=*&order=created_at"),
        read("approvals", "select=*"),
      ]);
      result.admin = { accounts, queue, policies };
    }
    return result;
  }
  return async (request: Request): Promise<Response> => {
    const json = (body: unknown, status = 200) =>
      new Response(request.method === "HEAD" ? null : JSON.stringify(body), {
        status,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      const url = new URL(request.url);
      const segments = url.pathname.split("/").filter(Boolean);
      const portalIndex = segments.indexOf("portal");
      if (portalIndex < 0) throw new HttpError(404, "Not found.");
      const path = segments.slice(portalIndex + 1);
      if (["GET", "HEAD"].includes(request.method)) {
        if (path.length === 3 && path[0] === "public" && path[2] === "module.json") {
          if (!/^[a-z0-9][a-z0-9-]*$/.test(path[1])) throw new HttpError(404, "Module not found.");
          const [release] = await read(
            "releases",
            `module_id=eq.${path[1]}&published=eq.true&select=public_manifest&order=created_at.desc&limit=1`,
          );
          if (!release) throw new HttpError(404, "No release published.");
          return json(release.public_manifest);
        }
        if (
          path.length === 3 &&
          path[0] === "install" &&
          ["module.json", "module.zip"].includes(path[2])
        ) {
          if (!/^[a-f0-9]{64}$/.test(path[1]))
            throw new HttpError(410, "Invalid installation link.");
          // Do not consume HEAD, OPTIONS or manifest reads. Reject range requests before redeeming.
          if (request.headers.has("Range"))
            throw new HttpError(
              416,
              "Partial downloads are not supported. Request a replacement if needed.",
            );
          const consume = path[2] === "module.zip" && request.method === "GET";
          let release: Row;
          try {
            release = await rpc("portal_ticket", {
              p_hash: await hashTicket(path[1]),
              p_consume: consume,
            });
          } catch (error) {
            if (error instanceof HttpError && error.status === 403)
              throw new HttpError(410, error.message);
            throw error;
          }
          if (path[2] === "module.json")
            return json({
              ...release.manifest,
              download: `${endpoint}/install/${path[1]}/module.zip`,
            });
          const zipHeaders = {
            ...headers,
            "Content-Type": "application/zip",
            "Content-Length": String(release.bytes),
            "Content-Disposition": `attachment; filename="${release.module_id}-${release.version}.zip"`,
          };
          if (!consume) return new Response(null, { headers: zipHeaders });
          // Stream private bytes directly. A reusable Storage signed URL is never exposed.
          const storagePath = String(release.storage_path)
            .split("/")
            .map(encodeURIComponent)
            .join("/");
          const zip = await fetcher(
            `${base}/storage/v1/object/authenticated/module-releases/${storagePath}`,
            { headers: { apikey: config.key, Authorization: `Bearer ${config.key}` } },
          );
          if (!zip.ok || !zip.body)
            throw new HttpError(
              502,
              "Download failed and the link is used. Please request a replacement.",
            );
          return new Response(zip.body, { headers: zipHeaders });
        }
        if (path.length === 1 && path[0] === "dashboard" && request.method === "GET")
          return json(await dashboard(await account(request)));
        throw new HttpError(404, "Not found.");
      }
      if (request.method !== "POST") throw new HttpError(405, "Method not allowed.");
      if (request.headers.get("Origin") && request.headers.get("Origin") !== config.origin)
        throw new HttpError(403, "Origin not allowed.");
      if (!request.headers.get("Content-Type")?.startsWith("application/json"))
        throw new HttpError(415, "JSON required.");
      // Bound request bodies even when Content-Length is absent.
      const reader = request.body?.getReader();
      let raw = "";
      let bytes = 0;
      if (reader) {
        const decoder = new TextDecoder();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 8192) {
            await reader.cancel();
            throw new HttpError(413, "Request too large.");
          }
          raw += decoder.decode(chunk.value, { stream: true });
        }
        raw += decoder.decode();
      }
      let body: Row;
      try {
        body = JSON.parse(raw);
        if (!body || Array.isArray(body) || typeof body !== "object") throw new Error();
      } catch {
        throw new HttpError(400, "Invalid JSON.");
      }
      const user = await account(request);
      if (path.length === 1 && path[0] === "claim") {
        if (!isUuid(body.releaseId)) throw new HttpError(400, "Choose a release.");
        const ticket = newTicket();
        const grant = await rpc("portal_issue", {
          p_user: user.user_id,
          p_release: body.releaseId,
          p_hash: await hashTicket(ticket),
        });
        return json({
          manifestUrl: `${endpoint}/install/${ticket}/module.json`,
          expiresAt: grant.expires_at,
        });
      }
      if (path.length === 1 && path[0] === "request") {
        if (
          !["access", "replacement"].includes(body.kind) ||
          typeof body.moduleId !== "string" ||
          !/^[a-z0-9][a-z0-9-]*$/.test(body.moduleId) ||
          typeof body.reason !== "string" ||
          body.reason.trim().length < 10 ||
          body.reason.length > 2000 ||
          (body.kind === "replacement" && !isUuid(body.releaseId))
        )
          throw new HttpError(400, "Provide a module and a reason of 10–2000 characters.");
        await rpc("portal_request", {
          p_user: user.user_id,
          p_module: body.moduleId,
          p_release: body.kind === "replacement" ? body.releaseId : null,
          p_kind: body.kind,
          p_reason: body.reason.trim(),
        });
        return json({ ok: true });
      }
      if (path.length === 2 && path[0] === "admin") {
        if (!user.is_admin) throw new HttpError(403, "Administrator required.");
        if (path[1] === "decide") {
          if (!isUuid(body.requestId) || typeof body.approve !== "boolean")
            throw new HttpError(400, "Invalid decision.");
          await rpc("portal_decide", {
            p_admin: user.user_id,
            p_request: body.requestId,
            p_approve: body.approve,
          });
        } else if (path[1] === "policy") {
          if (!isUuid(body.userId)) throw new HttpError(400, "Choose an account.");
          const modulePolicy =
            typeof body.moduleId === "string" &&
            /^[a-z0-9][a-z0-9-]*$/.test(body.moduleId) &&
            typeof body.active === "boolean";
          if (!modulePolicy && typeof body.unlimited !== "boolean")
            throw new HttpError(400, "Choose a policy.");
          await rpc("portal_set_policy", {
            p_admin: user.user_id,
            p_user: body.userId,
            p_module: modulePolicy ? body.moduleId : null,
            p_active: modulePolicy ? body.active : null,
            p_unlimited: modulePolicy ? null : body.unlimited,
          });
        } else throw new HttpError(404, "Not found.");
        return json({ ok: true });
      }
      throw new HttpError(404, "Not found.");
    } catch (error) {
      // Never log request URLs, JWTs, ticket hashes, service keys, or private manifests.
      return json(
        { error: error instanceof HttpError ? error.message : "Unexpected service error." },
        error instanceof HttpError ? error.status : 500,
      );
    }
  };
}
function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
  );
}
