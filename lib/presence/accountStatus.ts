// Account-level Discord status override (Settings → Accounts → Status).
//
// The selector must change the status dot of the WHOLE account, not just this
// app's session. A gateway OP3 carries `d.status`, but that only sets THIS
// session's status — the account's overall status is computed by Discord from
// every live session (plus the synced profile status), so with the user's real
// Discord app also connected the OP3 value is simply merged away and the dot
// never moves. That is the "the selector does nothing" report.
//
// The account-level status lives in the user settings proto:
// `PreloadedUserSettings.status.status` — documented as "the overall status of
// the user, used to sync presence across clients". That is exactly what the
// official client writes when you pick a status in the profile sheet, so that
// is what we patch here:
//
//   PATCH /users/@me/settings-proto/1   {"settings": "<base64 proto>"}
//
// The patch is a partial update carrying ONLY the status leaf (field 11 →
// field 1 → StringValue.value), so the custom status text and every other
// setting are untouched. 'auto' writes the documented default 'unknown',
// handing the status back to Discord's own session handling.
//
// Wire shape (verified against discord_protos.discord_users.v1
// .PreloadedUserSettings): settings = 0x5A <len> { status = 0x0A <len> {
// value = 0x0A <len> <ascii> } }. All status strings are ASCII, so a byte at a
// time is enough — no protobuf library, no Buffer (Hermes has none).
const API = 'https://discord.com/api/v9';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Bounded like every other Discord request from the frame scheduler — a hung
// PATCH must never hold anything up. The result is cosmetic either way.
const REQ_TIMEOUT = 8000;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[b2 & 63] : '=';
  }
  return out;
}

/** Encode a minimal PreloadedUserSettings carrying only the status value. */
export function encodeStatusPatch(value: string): string {
  const text: number[] = [];
  for (let i = 0; i < value.length; i++) text.push(value.charCodeAt(i) & 0xff);
  const stringValue = [0x0a, text.length, ...text]; // StringValue.value (field 1)
  const statusSettings = [0x0a, stringValue.length, ...stringValue]; // StatusSettings.status (field 1)
  const settings = [0x5a, statusSettings.length, ...statusSettings]; // PreloadedUserSettings.status (field 11)
  return base64(settings);
}

/**
 * Write the account-wide status. `status` is the presence.status setting; the
 * sentinel 'auto' (or null) RESTORES Discord's control by writing the default
 * 'unknown' — it must undo a previously forced override, or switching back to
 * auto would leave the account stuck on whatever was forced last.
 * Best-effort: a failed patch costs the override, never the session.
 */
export async function applyAccountStatus(
  token: string,
  status: string | null
): Promise<void> {
  const value = status && status !== 'auto' ? status : 'unknown';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT);
  try {
    await fetch(`${API}/users/@me/settings-proto/1`, {
      method: 'PATCH',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
        'User-Agent': UA,
      },
      body: JSON.stringify({ settings: encodeStatusPatch(value) }),
      signal: ctrl.signal,
    });
  } catch {
    /* cosmetic — never surface */
  } finally {
    clearTimeout(timer);
  }
}
