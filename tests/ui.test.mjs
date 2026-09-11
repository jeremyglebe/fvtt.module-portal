import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("simplified page retains every account, request, and download control", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "HTML IDs must remain unique");
  for (const match of script.matchAll(/\$\("([^"]+)"\)/g)) {
    assert.ok(ids.includes(match[1]), `Missing control: ${match[1]}`);
  }
  assert.match(html, /<h1>Foundry modules<\/h1>/);
  assert.match(html, /Game Systems → Install System/);
  assert.match(script, /Systems: Game Systems → Install System/);
  assert.match(script, /Modules: Add-on Modules → Install Module/);
  assert.match(script, /notify\(`Manifest URL copied\. \$\{installationHint\}`\)/);
  assert.match(
    script.slice(script.indexOf('$("copy-ticket").addEventListener')),
    /notify\(`Link copied\. \$\{installationHint\}`\)/,
  );
  assert.doesNotMatch(script, /Paste it into Foundry’s Install Module dialog/);
  assert.match(html, /aria-labelledby="ticket-title"/);
  assert.match(html, /aria-labelledby="request-title"/);
  assert.doesNotMatch(
    html,
    /shared adventure|roll initiative|library card|access desk|private shelves/i,
  );
  assert.doesNotMatch(script, /↗|All caught up/);
});
