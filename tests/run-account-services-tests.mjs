import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { DOMParser } from "@xmldom/xmldom";
import { AccountError, AccountSessionService } from "../js/account/account-session.js";
import { LibraryError, SupabaseLibraryRepository } from "../js/account/library-repository.js";
import { parseFdx } from "../js/fdx-parser.js";

globalThis.DOMParser = DOMParser;

function fakeAuthClient() {
  let callback = null;
  const calls = [];
  const auth = {
    async getSession() { calls.push(["getSession"]); return { data: { session: null }, error: null }; },
    onAuthStateChange(listener) { callback = listener; return { data: { subscription: { unsubscribe() { calls.push(["unsubscribe"]); } } } }; },
    async signUp(payload) { calls.push(["signUp", payload]); return { data: { user: { id: "user-1", email: payload.email }, session: null }, error: null }; },
    async signInWithPassword(payload) { calls.push(["signIn", payload]); return { data: { session: { user: { id: "user-1", email: payload.email } } }, error: null }; },
    async resetPasswordForEmail(email, options) { calls.push(["reset", email, options]); return { error: null }; },
    async updateUser(payload) { calls.push(["updateUser", payload]); return { error: null }; },
    async signOut() { calls.push(["signOut"]); return { error: null }; }
  };
  return { auth, calls, emit(event, session) { callback?.(event, session); } };
}

const fake = fakeAuthClient();
const sessions = new AccountSessionService(fake, { redirectUrl: "https://example.test/account" });
const observed = [];
const authEvents = [];
const unsubscribe = sessions.subscribe((state) => observed.push(state.status));
const unsubscribeEvents = sessions.subscribeEvents((event) => authEvents.push(event));
assert.equal((await sessions.initialize()).status, "guest");
assert.deepEqual(await sessions.signUp(" Roger@Example.com ", "long-enough-password"), { user: { id: "user-1", email: "roger@example.com" }, confirmationRequired: true });
assert.equal(fake.calls.find(([name]) => name === "signUp")[1].options.emailRedirectTo, "https://example.test/account");
assert.equal((await sessions.signIn("Roger@example.com", "long-enough-password")).status, "authenticated");
fake.emit("SIGNED_IN", { user: { id: "user-1", email: "roger@example.com" } });
fake.emit("PASSWORD_RECOVERY", { user: { id: "user-1", email: "roger@example.com" } });
await sessions.requestPasswordReset("roger@example.com");
await sessions.updatePassword("another-long-password");
await sessions.signOut();
assert.equal(sessions.snapshot().status, "guest");
unsubscribe(); unsubscribeEvents(); sessions.destroy();
assert(observed.includes("authenticated"));
assert(authEvents.includes("PASSWORD_RECOVERY"));
console.log("✓ account session supports signup, login, recovery, logout, and auth events");

await assert.rejects(() => sessions.signIn("not-an-email", "long-enough-password"), (error) => error instanceof AccountError && error.code === "invalid_email");
await assert.rejects(() => sessions.signUp("roger@example.com", "short"), (error) => error instanceof AccountError && error.code === "weak_password");
console.log("✓ account validation returns safe, useful errors before network requests");

const failingAuth = fakeAuthClient();
failingAuth.auth.signInWithPassword = async () => ({ data: null, error: { status: 400, message: "Invalid login credentials: internal detail" } });
const failingSessions = new AccountSessionService(failingAuth);
await assert.rejects(
  () => failingSessions.signIn("roger@example.com", "long-enough-password"),
  (error) => error instanceof AccountError && error.code === "invalid_credentials" && !error.message.includes("internal detail")
);
console.log("✓ account provider errors are converted to safe customer-facing messages");

const restrictedEmailAuth = fakeAuthClient();
restrictedEmailAuth.auth.signUp = async () => ({ data: null, error: { status: 400, message: "Email address not authorized by default SMTP" } });
await assert.rejects(
  () => new AccountSessionService(restrictedEmailAuth).signUp("reader@example.com", "long-enough-password"),
  (error) => error instanceof AccountError && error.code === "email_delivery_unavailable" && !/smtp/i.test(error.message)
);
console.log("✓ restricted email delivery is explained without exposing provider terminology");

class Query {
  constructor(client, table) { this.client = client; this.table = table; this.operation = {}; }
  select(columns) { this.operation.select = columns; return this; }
  eq(column, value) { (this.operation.filters ||= []).push([column, value]); return this; }
  order(column, options) { this.operation.order = [column, options]; this.client.calls.push([this.table, this.operation]); return Promise.resolve({ data: this.client.rows[this.table] || [], error: null }); }
  upsert(payload, options) { this.operation.upsert = payload; this.operation.options = options; this.client.calls.push([this.table, this.operation]); return this; }
  single() { return Promise.resolve({ data: { id: "screenplay-1", ...this.operation.upsert }, error: null }); }
  maybeSingle() { this.client.calls.push([this.table, this.operation]); return Promise.resolve({ data: this.client.rows[this.table]?.[0] || null, error: null }); }
  then(resolve, reject) { return Promise.resolve({ data: null, error: null }).then(resolve, reject); }
}

const database = {
  calls: [],
  rows: {
    screenplays: [{ id: "screenplay-1", title: "PASSENGER", playback_states: [{ progress_percent: 27, current_scene: "INT. CAR - NIGHT" }], screenplay_settings: [{ audio_quality: "standard" }] }],
    playback_states: [{ current_unit: 2, playback_speed: 1.25 }],
    screenplay_settings: [{ audio_quality: "standard", read_character_names: false, cast_assignments: {} }]
  },
  from(table) { return new Query(this, table); }
};
const signedInSession = { snapshot: () => ({ status: "authenticated", user: { id: "user-1", email: "roger@example.com" } }) };
const library = new SupabaseLibraryRepository(database, signedInSession);
const source = await fs.readFile(new URL("./fixtures/representative.fdx", import.meta.url), "utf8");
const record = { id: "0123456789abcdef0123456789abcdef", script: parseFdx(source, "PASSENGER"), preferences: { currentIndex: 2, rate: 1.25, provider: "browser" } };

const listed = (await library.listScreenplays())[0];
assert.equal(listed.title, "PASSENGER");
assert.equal(listed.playback.progress_percent, 27);
assert.equal(listed.settings.audio_quality, "standard");
const saved = await library.saveScreenplay(record);
assert.equal(saved.id, "screenplay-1");
const metadataCall = database.calls.find(([table, operation]) => table === "screenplays" && operation.upsert);
assert.equal(metadataCall[1].upsert.owner_user_id, "user-1");
assert.equal("script" in metadataCall[1].upsert, false);
assert(database.calls.some(([table]) => table === "playback_states"));
assert(database.calls.some(([table]) => table === "screenplay_settings"));
assert.equal((await library.loadPreferences("screenplay-1")).playback.current_unit, 2);
console.log("✓ library saves owner-scoped metadata, playback, and settings without screenplay content");

const guestLibrary = new SupabaseLibraryRepository(database, { snapshot: () => ({ status: "guest", user: null }) });
await assert.rejects(() => guestLibrary.listScreenplays(), (error) => error instanceof LibraryError && error.code === "sign_in_required");
console.log("✓ guest sessions cannot read or write the account library");
