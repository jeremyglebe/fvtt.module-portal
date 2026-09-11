import test from "node:test";
import assert from "node:assert/strict";
import { createHandler, hashTicket, newTicket } from "../supabase/functions/portal/core.ts";
const base = "https://test.supabase.co";
const origin = "https://jeremyglebe.com";
const ticket = "a".repeat(64);
const release = {
  module_id: "test",
  version: "1.0.0",
  bytes: 3,
  storage_path: "test/1.0.0/module.zip",
  manifest: { id: "test", manifest: "https://public.example/module.json" },
};
function fixture(options = {}) {
  const calls = [];
  const handler = createHandler({
    url: base,
    key: "SERVER_SECRET",
    origin,
    fetcher: async (url, init) => {
      calls.push({ url, ...init });
      if (url.endsWith("/auth/v1/user"))
        return Response.json(options.user || {}, { status: options.user ? 200 : 401 });
      if (url.includes("/portal_accounts?on_conflict")) return new Response(null, { status: 201 });
      if (url.includes("/portal_accounts?"))
        return Response.json([
          {
            user_id: "11111111-1111-4111-8111-111111111111",
            email: "friend@example.com",
            is_admin: false,
          },
        ]);
      if (url.includes("/rpc/portal_ticket"))
        return options.invalid
          ? Response.json({ message: "Approval revoked" }, { status: 400 })
          : Response.json(release);
      if (url.includes("/rpc/portal_issue"))
        return Response.json({ expires_at: "2030-01-01T00:00:00Z" });
      if (url.includes("/storage/")) return new Response(new Uint8Array([1, 2, 3]));
      if (url.includes("select=public_manifest"))
        return Response.json([{ public_manifest: { id: "test", version: "1.0.0" } }]);
      return Response.json([]);
    },
  });
  return {
    calls,
    handler,
    request: (path, method = "GET", body, headers = {}) =>
      handler(
        new Request(`${base}/functions/v1/portal/${path}`, {
          method,
          body: body && JSON.stringify(body),
          headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
        }),
      ),
  };
}
test("ticket hashes are 256-bit and random values are not stored in plain text", async () => {
  const value = newTicket();
  assert.match(value, /^[a-f0-9]{64}$/);
  assert.notEqual(value, newTicket());
  assert.notEqual(await hashTicket(value), value);
  assert.equal((await hashTicket(value)).length, 64);
});
test("manifest, HEAD and preflight do not consume a download", async () => {
  const f = fixture();
  const response = await f.request(`install/${ticket}/module.json`);
  const manifest = await response.json();
  assert.equal(manifest.manifest, release.manifest.manifest);
  assert.equal(manifest.download, `${base}/functions/v1/portal/install/${ticket}/module.zip`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await f.request(`install/${ticket}/module.zip`, "HEAD")).status, 200);
  assert.equal((await f.request(`install/${ticket}/module.zip`, "OPTIONS")).status, 204);
  assert.equal(f.calls.filter((c) => c.url.includes("/storage/")).length, 0);
  for (const call of f.calls) assert.equal(JSON.parse(call.body).p_consume, false);
});
test("ZIP streams bytes after one atomic redemption without redirect or signed URL", async () => {
  const f = fixture();
  const response = await f.request(`install/${ticket}/module.zip`);
  assert.equal(JSON.parse(f.calls[0].body).p_consume, true);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.ok(!JSON.stringify([...response.headers]).includes("SERVER_SECRET"));
});
test("invalid tickets, revocation and range requests do not expose content", async () => {
  const f = fixture({ invalid: true });
  assert.equal((await f.request("install/bad/module.zip")).status, 410);
  assert.equal(
    (await f.request(`install/${ticket}/module.zip`, "GET", null, { Range: "bytes=0-1" })).status,
    416,
  );
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request(`install/${ticket}/module.json`)).status, 410);
  assert.equal(f.calls.length, 1);
});
test("public manifest has no private content; authenticated routes require verified sessions", async () => {
  const f = fixture();
  assert.deepEqual(await (await f.request("public/test/module.json")).json(), {
    id: "test",
    version: "1.0.0",
  });
  assert.equal((await f.request("dashboard")).status, 401);
  const unverified = fixture({ user: { id: "id", email: "friend@example.com" } });
  assert.equal(
    (
      await unverified.request(
        "claim",
        "POST",
        { releaseId: "x" },
        { Authorization: "Bearer valid" },
      )
    ).status,
    403,
  );
  assert.equal(unverified.calls.length, 1);
});
test("claim ignores caller user identity; non-admin cannot change approvals", async () => {
  const f = fixture({
    user: {
      id: "11111111-1111-4111-8111-111111111111",
      email: "friend@example.com",
      email_confirmed_at: "2026-01-01",
    },
  });
  const headers = { Authorization: "Bearer valid", Origin: origin };
  const body = {
    releaseId: "22222222-2222-4222-8222-222222222222",
    userId: "someone-else",
    unlimited: true,
  };
  const response = await f.request("claim", "POST", body, headers);
  assert.equal(response.status, 200);
  const call = f.calls.find((c) => c.url.includes("/rpc/portal_issue"));
  assert.equal(JSON.parse(call.body).p_user, "11111111-1111-4111-8111-111111111111");
  const result = await response.json();
  assert.match(result.manifestUrl, /install\/[a-f0-9]{64}\/module.json$/);
  assert.ok(!call.body.includes(result.manifestUrl.split("/").at(-2)));
  assert.equal((await f.request("admin/policy", "POST", body, headers)).status, 403);
  assert.equal(
    (await f.request("claim", "POST", body, { ...headers, Origin: "https://bad.example" })).status,
    403,
  );
});
