const protocolError = "The portal returned an invalid response. Refresh and try again.";
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasRows = (value, fields) =>
  isRecord(value) &&
  fields.every((field) => Array.isArray(value[field]) && value[field].every(isRecord));
const mutations = new Set([
  "request",
  "admin/module",
  "admin/email-access",
  "admin/decide",
  "admin/policy",
]);

function validResult(path, result) {
  if (!isRecord(result)) return false;
  if (mutations.has(path)) return result.ok === true;
  if (path === "dashboard") {
    return (
      isRecord(result.account) &&
      typeof result.account.email === "string" &&
      typeof result.account.is_admin === "boolean" &&
      hasRows(result, ["modules", "releases", "approvals", "grants", "requests"]) &&
      (result.account.is_admin
        ? hasRows(result.admin, ["accounts", "queue", "policies", "emailAccess"])
        : result.admin === undefined)
    );
  }
  if (path === "claim") {
    if (typeof result.expiresAt !== "string" || !Number.isFinite(Date.parse(result.expiresAt)))
      return false;
    if (typeof result.manifestUrl !== "string") return false;
    try {
      const link = new URL(result.manifestUrl);
      return link.protocol === "https:" && !link.username && !link.password && !link.hash;
    } catch {
      return false;
    }
  }
  return false;
}

export async function readApiResponse(response, path) {
  let result;
  try {
    result = await response.json();
  } catch {
    if (response.ok) throw new Error(protocolError);
  }
  if (!response.ok) {
    const message = isRecord(result) && typeof result.error === "string" && result.error.trim();
    throw new Error(message || "The portal is temporarily unavailable. Try again later.");
  }
  if (!validResult(path, result)) throw new Error(protocolError);
  return result;
}
