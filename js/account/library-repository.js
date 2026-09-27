import { playbackStateRow, screenplayLibraryRow, screenplaySettingsRow } from "./library-model.js";

export class LibraryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LibraryError";
    this.code = code;
  }
}

function libraryError(error) {
  if (error instanceof LibraryError) return error;
  if (/jwt|session|auth/i.test(error?.message || "") || [401, 403].includes(Number(error?.status))) {
    return new LibraryError("session_expired", "Your session has expired. Sign in again to continue.");
  }
  if (/network|fetch|connection/i.test(error?.message || "")) {
    return new LibraryError("network", "Your library couldn’t connect. Check your connection and try again.");
  }
  return new LibraryError("library_error", "SpokenFrame couldn’t update your library.");
}

export class SupabaseLibraryRepository {
  constructor(client, sessionService) {
    if (!client?.from || !sessionService?.snapshot) throw new Error("A database client and account session are required.");
    this.client = client;
    this.sessionService = sessionService;
  }

  #ownerId() {
    const state = this.sessionService.snapshot();
    if (state.status !== "authenticated" || !state.user?.id) {
      throw new LibraryError("sign_in_required", "Create a free account or sign in to save this screenplay.");
    }
    return state.user.id;
  }

  async listScreenplays() {
    const ownerId = this.#ownerId();
    try {
      const { data, error } = await this.client
        .from("screenplays")
        .select("id,client_fingerprint,title,source_format,page_count,page_count_method,spoken_character_count,created_at,updated_at,playback_states(current_unit,progress_percent,playback_speed,current_scene,updated_at),screenplay_settings(audio_quality,read_character_names,updated_at)")
        .eq("owner_user_id", ownerId)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return (data || []).map((item) => ({
        ...item,
        playback: Array.isArray(item.playback_states) ? (item.playback_states[0] || {}) : (item.playback_states || {}),
        settings: Array.isArray(item.screenplay_settings) ? (item.screenplay_settings[0] || {}) : (item.screenplay_settings || {})
      }));
    } catch (error) { throw libraryError(error); }
  }

  async saveScreenplay(record, pageDetails = {}) {
    const ownerId = this.#ownerId();
    try {
      const metadata = screenplayLibraryRow(record, ownerId, pageDetails);
      const { data: screenplay, error } = await this.client
        .from("screenplays")
        .upsert(metadata, { onConflict: "owner_user_id,client_fingerprint" })
        .select("id,title,source_format,page_count,page_count_method,spoken_character_count,created_at,updated_at")
        .single();
      if (error) throw error;
      await this.savePlayback(record, screenplay.id);
      await this.saveSettings(record, screenplay.id);
      return screenplay;
    } catch (error) { throw libraryError(error); }
  }

  async savePlayback(record, screenplayId) {
    const ownerId = this.#ownerId();
    try {
      const { error } = await this.client
        .from("playback_states")
        .upsert(playbackStateRow(record, ownerId, screenplayId), { onConflict: "screenplay_id,owner_user_id" });
      if (error) throw error;
      return true;
    } catch (error) { throw libraryError(error); }
  }

  async saveSettings(record, screenplayId) {
    const ownerId = this.#ownerId();
    try {
      const { error } = await this.client
        .from("screenplay_settings")
        .upsert(screenplaySettingsRow(record, ownerId, screenplayId), { onConflict: "screenplay_id,owner_user_id" });
      if (error) throw error;
      return true;
    } catch (error) { throw libraryError(error); }
  }

  async loadPreferences(screenplayId) {
    const ownerId = this.#ownerId();
    try {
      const [playbackResult, settingsResult] = await Promise.all([
        this.client.from("playback_states").select("current_unit,current_chunk,chunk_position_seconds,progress_percent,playback_speed,current_scene,updated_at").eq("screenplay_id", screenplayId).eq("owner_user_id", ownerId).maybeSingle(),
        this.client.from("screenplay_settings").select("audio_quality,read_character_names,cast_assignments,updated_at").eq("screenplay_id", screenplayId).eq("owner_user_id", ownerId).maybeSingle()
      ]);
      if (playbackResult.error) throw playbackResult.error;
      if (settingsResult.error) throw settingsResult.error;
      return { playback: playbackResult.data || {}, settings: settingsResult.data || {} };
    } catch (error) { throw libraryError(error); }
  }
}
