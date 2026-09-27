import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { SPOKENFRAME_CONFIG } from "../js/config.js";
import { createSpokenFrameSupabaseClient, hasSupabaseConfig } from "../js/account/supabase-client.js";

assert.equal(hasSupabaseConfig(SPOKENFRAME_CONFIG), true);
assert.equal(hasSupabaseConfig({ supabaseUrl: SPOKENFRAME_CONFIG.supabaseUrl, supabasePublishableKey: "sb_secret_do-not-use" }), false);
assert.equal(hasSupabaseConfig({ supabaseUrl: `${SPOKENFRAME_CONFIG.supabaseUrl}/rest/v1/`, supabasePublishableKey: SPOKENFRAME_CONFIG.supabasePublishableKey }), false);

const calls = [];
const client = { auth: {}, from() {} };
const sdk = {
  createClient(url, key, options) {
    calls.push({ url, key, options });
    return client;
  }
};
assert.equal(createSpokenFrameSupabaseClient(SPOKENFRAME_CONFIG, sdk), client);
assert.equal(calls[0].url, "https://dzugojzwwjthiwqmmecf.supabase.co");
assert.match(calls[0].key, /^sb_publishable_/);
assert.equal(calls[0].options.auth.persistSession, true);
assert.equal(calls[0].options.auth.autoRefreshToken, true);
assert.equal(calls[0].options.auth.detectSessionInUrl, true);
console.log("✓ browser client uses only the public Supabase URL and publishable key");

const html = await fs.readFile(new URL("../index.html", import.meta.url), "utf8");
assert.match(html, /vendor\/supabase\/supabase\.js/);
assert.match(html, /id="account-modal"/);
assert.match(html, /id="library-section"/);
assert.doesNotMatch(html, /sb_secret_|service_role|ELEVENLABS_API_KEY/);

const configSource = await fs.readFile(new URL("../js/config.js", import.meta.url), "utf8");
assert.match(configSource, /sb_publishable_/);
assert.doesNotMatch(configSource, /sb_secret_|service_role|ELEVENLABS_API_KEY\s*:/);
console.log("✓ account UI and vendored client contain no server-side secret");
