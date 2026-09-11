import assert from "node:assert/strict";
import test from "node:test";
import { readApiResponse } from "../src/api-response.js";

const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
const dashboard = {
  account: { email: "player@example.com", is_admin: false },
  modules: [],
  releases: [],
  approvals: [],
  grants: [],
  requests: [],
};

test("successful API responses require valid JSON and a route contract", async () => {
  for (const body of ["", "not json", "null", "[]", "{}", '{"ok":false}']) {
    await assert.rejects(readApiResponse(new Response(body), "admin/module"), /invalid response/);
  }
  for (const path of [
    "request",
    "admin/module",
    "admin/email-access",
    "admin/decide",
    "admin/policy",
  ])
    assert.deepEqual(await readApiResponse(response({ ok: true }), path), { ok: true });
  await assert.rejects(readApiResponse(response({ ok: true }), "unknown"), /invalid response/);
});

test("dashboard requires account and collections, including admin data when applicable", async () => {
  assert.deepEqual(await readApiResponse(response(dashboard), "dashboard"), dashboard);
  for (const invalid of [
    {},
    { ...dashboard, modules: null },
    { ...dashboard, grants: [null] },
    { ...dashboard, account: { ...dashboard.account, is_admin: true } },
  ]) {
    await assert.rejects(readApiResponse(response(invalid), "dashboard"), /invalid response/);
  }
  const admin = {
    ...dashboard,
    account: { ...dashboard.account, is_admin: true },
    admin: { accounts: [], queue: [], policies: [], emailAccess: [] },
  };
  assert.deepEqual(await readApiResponse(response(admin), "dashboard"), admin);
});

test("claim requires an HTTPS manifest URL and an expiry", async () => {
  const claim = {
    manifestUrl: "https://example.com/install/ticket/module.json",
    expiresAt: "2026-09-11T20:00:00Z",
  };
  assert.deepEqual(await readApiResponse(response(claim), "claim"), claim);
  for (const invalid of [
    {},
    { ...claim, expiresAt: "bad" },
    { ...claim, manifestUrl: "javascript:alert(1)" },
  ])
    await assert.rejects(readApiResponse(response(invalid), "claim"), /invalid response/);
});

test("error responses preserve useful errors but tolerate missing or malformed error bodies", async () => {
  await assert.rejects(
    readApiResponse(response({ error: "Approval required" }, 403), "claim"),
    /Approval required/,
  );
  for (const body of ["", "not json", "null", '{"error":{}}'])
    await assert.rejects(
      readApiResponse(new Response(body, { status: 500 }), "claim"),
      /temporarily unavailable/,
    );
});
