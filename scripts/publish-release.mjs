import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export function validateRelease(metadata, manifest, notice, zip, base) {
  if (
    metadata.schemaVersion !== 1 ||
    !/^[a-z0-9][a-z0-9-]*$/.test(metadata.moduleId) ||
    !/^\d+\.\d+\.\d+$/.test(metadata.version)
  )
    throw new Error("Invalid release identity or schema.");
  const path = `${metadata.moduleId}/${metadata.version}/module.zip`;
  if (
    metadata.storagePath !== path ||
    manifest.id !== metadata.moduleId ||
    manifest.version !== metadata.version ||
    notice.id !== metadata.moduleId ||
    notice.version !== metadata.version
  )
    throw new Error("Release files do not share the same identity.");
  if (zip.length > 50 * 1024 * 1024)
    throw new Error(
      "This portal limits ZIPs to 50 MiB. Test larger delivery separately before changing this limit.",
    );
  if (
    zip.length !== metadata.bytes ||
    createHash("sha256").update(zip).digest("hex") !== metadata.sha256
  )
    throw new Error("ZIP integrity check failed.");
  const expected = `${base}/functions/v1/portal/public/${metadata.moduleId}/module.json`;
  if (
    metadata.manifestUrl !== expected ||
    manifest.manifest !== expected ||
    notice.manifest !== expected
  )
    throw new Error(
      `Configure AUTHENTICATED_SITE_MANIFEST_URL=${expected} and rebuild the release.`,
    );
  for (const value of [manifest, notice])
    if ("download" in value || value.protected || value.exclusive)
      throw new Error("Persistent manifests must not contain download links or premium flags.");
  const publicKeys = ["id", "title", "description", "version", "compatibility", "url", "manifest"];
  if (Object.keys(notice).some((key) => !publicKeys.includes(key)))
    throw new Error("Unexpected fields in public notification manifest.");
  return path;
}
async function main() {
  const directory = process.argv[2];
  const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!directory || !base || !key)
    throw new Error(
      "Usage: npm run publish:release -- /absolute/path/to/v1.2.3 (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your local environment).",
    );
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(base))
    throw new Error("Expected your hosted Supabase project URL.");
  const json = async (path) => JSON.parse(await readFile(resolve(directory, path), "utf8"));
  const [metadata, manifest, notice, zip] = await Promise.all([
    json("private/release.json"),
    json("private/module.json"),
    json("public/module.json"),
    readFile(resolve(directory, "private/module.zip")),
  ]);
  const path = validateRelease(metadata, manifest, notice, zip, base);
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const existing = await fetch(
    `${base}/rest/v1/portal_releases?module_id=eq.${metadata.moduleId}&version=eq.${metadata.version}&select=id`,
    { headers },
  );
  if (!existing.ok)
    throw new Error(
      `Catalog preflight failed (${existing.status}). Check backend deployment and credentials.`,
    );
  if ((await existing.json()).length)
    throw new Error(
      "That version is already published. Releases are immutable; choose a new version.",
    );
  // No upsert: a duplicate or orphaned object requires manual review, not silent replacement.
  const upload = await fetch(`${base}/storage/v1/object/module-releases/${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/zip", "x-upsert": "false" },
    body: zip,
  });
  if (!upload.ok)
    throw new Error(
      `Private upload failed (${upload.status}). Check the bucket and existing object; nothing was published.`,
    );
  const registration = await fetch(`${base}/rest/v1/rpc/portal_publish`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      p_manifest: manifest,
      p_public: notice,
      p_path: path,
      p_sha: metadata.sha256,
      p_bytes: metadata.bytes,
    }),
  });
  if (!registration.ok)
    throw new Error(
      `Catalog publication failed (${registration.status}). The private object ${path} remains for inspection; no automatic deletion or overwrite was performed.`,
    );
  console.log(`Published ${metadata.moduleId} v${metadata.version}.`);
  console.log(`Public notification manifest: ${metadata.manifestUrl}`);
  console.log(
    "Test a complete Foundry installation with an approved test account before announcing the release.",
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
