#!/usr/bin/env node
/**
 * Builds the Immich workflow that nudges the sync when a photo is tagged.
 *
 *   node tools/sync/immich-workflow.mjs                  # print the JSON
 *   node tools/sync/immich-workflow.mjs --create         # create it on the server
 *   node tools/sync/immich-workflow.mjs --list-methods   # show what this server offers
 *
 * Workflow plugin method keys are not fixed across Immich versions, so nothing
 * here is hardcoded: the script reads GET /plugins/methods off your own server
 * and picks the tag filter and webhook action out of it. If it cannot find
 * them, it prints what the server does offer rather than inventing a key.
 *
 * Needs IMMICH_URL, IMMICH_API_KEY, IMMICH_TAG, WEBHOOK_SECRET and
 * SYNC_WEBHOOK_URL (where the sync container is reachable from Immich, e.g.
 * http://gallery-sync:8080/hook).
 */

const env = process.env;
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);

const BASE = (env.IMMICH_URL ?? "http://immich-server:2283").replace(/\/$/, "");
const KEY = env.IMMICH_API_KEY;
const TAG = env.IMMICH_TAG ?? "tomelliot.net";
const HOOK = env.SYNC_WEBHOOK_URL ?? "http://gallery-sync:8080/hook";
const SECRET = env.WEBHOOK_SECRET;

if (!KEY) {
  console.error("IMMICH_API_KEY is required");
  process.exit(1);
}

async function api(endpoint, init = {}) {
  const res = await fetch(`${BASE}/api${endpoint}`, {
    ...init,
    headers: {
      accept: "application/json",
      "x-api-key": KEY,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${endpoint} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

const describe = (m) => `${m.key}  (${m.title ?? m.name ?? "untitled"})`;

const methods = await api("/plugins/methods");

if (has("list-methods")) {
  console.log(`${methods.length} workflow methods on ${BASE}:\n`);
  for (const m of methods) {
    console.log(describe(m));
    if (m.description) console.log(`    ${m.description}`);
  }
  process.exit(0);
}

/** Finds a method by scoring its key, title and description against terms. */
function findMethod(terms, label) {
  const hit = methods.find((m) => {
    const haystack = [m.key, m.name, m.title, m.description].filter(Boolean).join(" ").toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
  if (!hit) {
    console.error(`Could not find the ${label} method on this server. Available methods:\n`);
    for (const m of methods) console.error("  " + describe(m));
    console.error(`\nRe-run with --list-methods for descriptions, then set the key by hand.`);
    process.exit(1);
  }
  return hit;
}

const webhook = findMethod(["webhook"], "webhook action");
const tagFilter = findMethod(["tag"], "tag filter");

// The tag is referenced by id, so resolve the name the same way the build does.
const tags = await api("/tags");
const wanted = TAG.toLowerCase();
const tag =
  tags.find((t) => t.value?.toLowerCase() === wanted) ?? tags.find((t) => t.name?.toLowerCase() === wanted);
if (!tag) {
  console.error(`No Immich tag named "${TAG}". Create it first, or set IMMICH_TAG.`);
  console.error(`Tags on this server: ${tags.map((t) => t.value ?? t.name).join(", ") || "(none)"}`);
  process.exit(1);
}

const workflow = {
  name: `Publish to ${TAG}`,
  description:
    "Nudges the gallery sync when a photo is tagged. The sync reconciles the " +
    "whole tag, so this only affects how soon the site updates, never what it shows.",
  enabled: true,
  logging: true,
  // Immich fires this when a tag is added to an asset. There is no matching
  // event for a tag being removed, which is why the sync also runs on a timer.
  trigger: "AssetTagged",
  steps: [
    {
      method: tagFilter.key,
      enabled: true,
      config: { tagIds: [tag.id] },
    },
    {
      method: webhook.key,
      enabled: true,
      config: {
        url: HOOK,
        method: "POST",
        ...(SECRET ? { headerName: "x-webhook-secret", headerValue: SECRET } : {}),
      },
    },
  ],
};

if (!has("create")) {
  console.error(
    `# Matched tag filter : ${describe(tagFilter)}\n` +
      `# Matched webhook    : ${describe(webhook)}\n` +
      `# Tag "${TAG}" is ${tag.id}\n` +
      `#\n` +
      `# Check the two config blocks against each method's schema (--list-methods),\n` +
      `# then paste this into Immich → Administration → Workflows → JSON editor,\n` +
      `# or re-run with --create.\n`
  );
  console.log(JSON.stringify(workflow, null, 2));
  process.exit(0);
}

const created = await api("/workflows", { method: "POST", body: JSON.stringify(workflow) });
console.log(`Created workflow ${created.id}: ${created.name}`);
console.log(
  `\nIf the webhook step fails with a host error, add ${new URL(HOOK).host} to the ` +
    `webhook plugin's allowed hosts — Immich restricts which hosts a plugin may call.`
);
