import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publishRelease,
  publishingSettings,
  validateRelease,
} from "../scripts/publish-release.mjs";
test("publisher accepts matching artifacts and rejects tampering or public content leakage", () => {
  const base = "https://test.supabase.co";
  const zip = Buffer.from("a test ZIP payload");
  const manifest = {
    id: "test",
    version: "1.0.0",
    title: "Test",
    manifest: `${base}/functions/v1/portal/public/test/module.json`,
  };
  const metadata = {
    schemaVersion: 1,
    moduleId: "test",
    version: "1.0.0",
    storagePath: "test/1.0.0/module.zip",
    sha256: createHash("sha256").update(zip).digest("hex"),
    bytes: zip.length,
    manifestUrl: manifest.manifest,
  };
  assert.equal(validateRelease(metadata, manifest, manifest, zip, base), metadata.storagePath);
  assert.throws(
    () => validateRelease(metadata, manifest, manifest, Buffer.from("tampered"), base),
    /integrity/,
  );
  assert.throws(
    () =>
      validateRelease(metadata, manifest, { ...manifest, packs: [{ path: "secret" }] }, zip, base),
    /Unexpected fields/,
  );
  assert.throws(
    () =>
      validateRelease(metadata, { ...manifest, download: "https://private" }, manifest, zip, base),
    /download links/,
  );
  assert.throws(
    () => validateRelease({ ...metadata, moduleId: "../bad" }, manifest, manifest, zip, base),
    /identity/,
  );
  assert.throws(
    () => validateRelease(metadata, manifest, manifest, zip, "https://other.supabase.co"),
    /Configure/,
  );
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "portal-publish-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = "https://test.supabase.co";
  const env = { SUPABASE_URL: base, SUPABASE_SERVICE_ROLE_KEY: "test-private-key" };
  const zip = Buffer.from("private test ZIP");
  const manifest = {
    id: "test",
    version: "1.0.0",
    title: "Test",
    manifest: `${base}/functions/v1/portal/public/test/module.json`,
  };
  const metadata = {
    schemaVersion: 1,
    moduleId: "test",
    version: "1.0.0",
    storagePath: "test/1.0.0/module.zip",
    sha256: createHash("sha256").update(zip).digest("hex"),
    bytes: zip.length,
    manifestUrl: manifest.manifest,
  };
  await mkdir(join(directory, "private"));
  await mkdir(join(directory, "public"));
  for (const [file, value] of [
    ["private/release.json", metadata],
    ["private/module.json", manifest],
    ["public/module.json", manifest],
  ])
    await writeFile(join(directory, file), JSON.stringify(value));
  await writeFile(join(directory, "private/module.zip"), zip);
  const row = {
    storage_path: metadata.storagePath,
    sha256: metadata.sha256,
    bytes: metadata.bytes,
    manifest,
    public_manifest: manifest,
    published: true,
  };
  return { directory, env, zip, manifest, metadata, row };
}

function responses(items, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    assert.ok(items.length, "Unexpected network request");
    return items.shift();
  };
}

test("publishes private ZIP before catalog, with credentials only in headers", async (t) => {
  const f = await fixture(t);
  const calls = [];
  const result = await publishRelease({
    ...f,
    fetcher: responses([Response.json([]), Response.json({}), Response.json("release-id")], calls),
  });
  assert.equal(result.alreadyPublished, false);
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /portal_releases/);
  assert.match(calls[1].url, /storage\/v1\/object\/module-releases\/test\/1.0.0\/module.zip$/);
  assert.equal(calls[1].options.headers["x-upsert"], "false");
  assert.deepEqual(calls[1].options.body, f.zip);
  assert.match(calls[2].url, /rpc\/portal_publish$/);
  assert.deepEqual(JSON.parse(calls[2].options.body).p_public, f.manifest);
  for (const call of calls) {
    assert.equal(call.options.headers.apikey, f.env.SUPABASE_SERVICE_ROLE_KEY);
    assert.ok(!call.url.includes(f.env.SUPABASE_SERVICE_ROLE_KEY));
  }
});

test("identical publication is idempotent; differing or unpublished releases are never overwritten", async (t) => {
  const f = await fixture(t);
  const result = await publishRelease({ ...f, fetcher: responses([Response.json([f.row])]) });
  assert.equal(result.alreadyPublished, true);
  for (const change of [
    { sha256: "different" },
    { published: false },
    { public_manifest: { ...f.manifest, title: "Changed" } },
  ]) {
    await assert.rejects(
      publishRelease({ ...f, fetcher: responses([Response.json([{ ...f.row, ...change }])]) }),
      /immutable/,
    );
  }
});

test("resumes catalog failure using an integrity-verified uploaded object", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    publishRelease({
      ...f,
      fetcher: responses([
        Response.json([]),
        Response.json({}),
        new Response("sensitive server details", { status: 500 }),
      ]),
    }),
    /Catalog publication failed \(500\).*Retry/,
  );
  const calls = [];
  await publishRelease({
    ...f,
    fetcher: responses(
      [
        Response.json([]),
        new Response("duplicate", { status: 400 }),
        new Response(f.zip),
        Response.json("release-id"),
      ],
      calls,
    ),
  });
  assert.match(calls[2].url, /object\/authenticated\/module-releases/);
  assert.match(calls[3].url, /portal_publish$/);
  await assert.rejects(
    publishRelease({
      ...f,
      fetcher: responses([
        Response.json([]),
        new Response("duplicate", { status: 409 }),
        new Response("wrong bytes"),
      ]),
    }),
    /different content/,
  );
});

test("missing and placeholder credentials explain retrieval, storage, and reuse", () => {
  for (const key of [undefined, "", "   ", "YOUR_SERVICE_ROLE_KEY"]) {
    assert.throws(
      () =>
        publishingSettings({
          SUPABASE_URL: "https://test.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: key,
        }),
      (error) => {
        assert.match(
          error.message,
          /https:\/\/supabase.com\/dashboard\/project\/test\/settings\/api-keys/,
        );
        assert.match(error.message, /Legacy anon, service_role API keys/);
        assert.match(error.message, /SUPABASE_SERVICE_ROLE_KEY=<copied value>/);
        assert.match(error.message, /\.env.local/);
        assert.match(error.message, /NOT a single-use key/);
        assert.match(error.message, /Reuse it for every release/);
        assert.match(error.message, /Never commit/);
        assert.match(error.message, /docs\/releases\/Authenticated Site.md/);
        return true;
      },
    );
  }
  assert.throws(() => publishingSettings({}), /select your project, then Settings > API Keys/);
  assert.throws(
    () => publishingSettings({ SUPABASE_URL: "https://do-not-print.example/?private=value" }),
    (error) => !error.message.includes("do-not-print") && !error.message.includes("private=value"),
  );
});

test("invalid credentials/configuration, artifact tampering, and network failures stop safely", async (t) => {
  const f = await fixture(t);
  assert.throws(() => publishingSettings({ SUPABASE_URL: f.env.SUPABASE_URL }), /SERVICE_ROLE_KEY/);
  assert.throws(
    () => publishingSettings({ ...f.env, SUPABASE_URL: "https://other.example.com" }),
    /hosted Supabase/,
  );
  await assert.rejects(
    publishRelease({
      ...f,
      fetcher: responses([new Response("private error details", { status: 401 })]),
    }),
    /Catalog preflight failed \(401\)/,
  );
  await assert.rejects(
    publishRelease({
      ...f,
      fetcher: responses([Response.json([]), new Response("private error", { status: 403 })]),
    }),
    /Private upload failed \(403\)/,
  );
  await assert.rejects(
    publishRelease({
      ...f,
      fetcher: async () => {
        throw new Error(f.env.SUPABASE_SERVICE_ROLE_KEY);
      },
    }),
    (error) =>
      !error.message.includes(f.env.SUPABASE_SERVICE_ROLE_KEY) &&
      /request failed/.test(error.message),
  );
  await writeFile(join(f.directory, "private/module.zip"), "tampered");
  await assert.rejects(publishRelease({ ...f, fetcher: responses([]) }), /integrity/);
});
