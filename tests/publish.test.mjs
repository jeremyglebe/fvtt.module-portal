import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { validateRelease } from "../scripts/publish-release.mjs";
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
