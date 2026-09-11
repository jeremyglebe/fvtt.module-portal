import assert from "node:assert/strict";
import test from "node:test";
import { registerModule } from "../scripts/publish-release.mjs";

const env = { SUPABASE_URL: "https://test.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "test-secret" };
const module = { id: "hidden-game", title: "Hidden Game", description: "For our game" };
const row = { id: module.id, visibility: "secret", manifest_url: null };

test("initial registration inserts secret atomically and confirms it without publishing a release", async () => {
  const calls = [];
  const result = await registerModule({
    module,
    visibility: "secret",
    env,
    fetcher: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.headers.apikey, env.SUPABASE_SERVICE_ROLE_KEY);
      assert.equal(options.headers.Authorization, `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
      assert.equal(options.redirect, "error");
      assert.ok(options.signal);
      assert.ok(!url.includes(env.SUPABASE_SERVICE_ROLE_KEY));
      return calls.length === 1 ? new Response(null, { status: 201 }) : Response.json([row]);
    },
  });
  assert.deepEqual(result, { moduleId: module.id, visibility: "secret" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, "POST");
  assert.match(calls[0].options.headers.Prefer, /ignore-duplicates/);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    ...module,
    visibility: "secret",
    manifest_url: null,
  });
  assert.match(
    calls[1].url,
    /portal_modules\?id=eq.hidden-game&select=id,visibility,manifest_url$/,
  );
});

test("matching registrations can be retried; a conflicting module is never overwritten", async () => {
  for (const visibility of ["private", "secret", "public"]) {
    const calls = [];
    const operation = registerModule({
      module,
      visibility: "secret",
      env,
      fetcher: async (url, options) => {
        calls.push(options);
        return options.method === "POST"
          ? new Response(null, { status: 204 })
          : Response.json([{ ...row, visibility }]);
      },
    });
    if (visibility === "secret") assert.equal((await operation).visibility, "secret");
    else await assert.rejects(operation, /already has different portal visibility/);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers.Prefer, "resolution=ignore-duplicates,return=minimal");
    assert.ok(!calls.some((c) => c.method === "PATCH" || c.method === "DELETE"));
  }
});

test("registration rejects invalid configuration before any network request", async () => {
  const fetcher = () => assert.fail("No network call expected");
  for (const input of [
    { visibility: "public" },
    { visibility: "" },
    { module: { ...module, id: "bad&id=eq.other" } },
    { module: { ...module, title: "" } },
    { module: { ...module, description: "x".repeat(2001) } },
    { env: { ...env, SUPABASE_SERVICE_ROLE_KEY: "" } },
    { env: { ...env, SUPABASE_URL: "https://example.com" } },
  ])
    await assert.rejects(registerModule({ module, visibility: "secret", env, fetcher, ...input }));
});

test("registration fails visibly for backend errors, missing rows, or invalid confirmation without leaking bodies", async () => {
  for (const confirmation of [
    new Response("sensitive detail", { status: 500 }),
    new Response("sensitive detail"),
    Response.json(null),
    Response.json([]),
    Response.json([null]),
    Response.json([{ ...row, id: "other" }]),
    Response.json([row, row]),
    Response.json([{ ...row, visibility: "unknown" }]),
  ]) {
    await assert.rejects(
      registerModule({
        module,
        visibility: "secret",
        env,
        fetcher: async (url, options) =>
          options.method === "POST" ? new Response(null, { status: 201 }) : confirmation,
      }),
      (error) => !error.message.includes("sensitive detail") && /registration/i.test(error.message),
    );
  }
  await assert.rejects(
    registerModule({
      module,
      visibility: "secret",
      env,
      fetcher: async () => new Response("sensitive detail", { status: 401 }),
    }),
    /registration failed \(401\)/,
  );
  await assert.rejects(
    registerModule({
      module,
      visibility: "secret",
      env,
      fetcher: async () => {
        throw new Error("sensitive detail");
      },
    }),
    /Portal request failed or timed out/,
  );
});
