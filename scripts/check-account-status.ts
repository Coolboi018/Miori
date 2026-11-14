/**
 * The Status selector (Settings → Accounts) must override the WHOLE Discord
 * account's status dot — not just this app's gateway session.
 *
 * Root cause of the "the selector does nothing" report: the OP3 presence
 * update only sets THIS session's status, and Discord computes the overall
 * dot from every live session, so the user's real Discord app simply merges
 * the override away. The account-level status is the user settings proto
 * (PreloadedUserSettings.status.status), so the fix PATCHes
 * /users/@me/settings-proto/1 with a minimal proto.
 *
 * These checks pin the encoded wire bytes against hand-derived expectations
 * from discord_protos.discord_users.v1.PreloadedUserSettings (field 11 →
 * field 1 → StringValue.value), independent of the encoder.
 *
 * Run with:  npx tsx scripts/check-account-status.ts
 */

type NodeRequire = {
  resolve(id: string): string;
  cache: Record<string, unknown>;
};
declare const require: NodeRequire;

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

const calls: CapturedCall[] = [];
let failNext = false;

// tsconfig has no Node types — decode the base64 payload with a minimal
// decoder instead of Buffer.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decodeBase64(text: string): number[] {
  const clean = text.replace(/=+$/, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error(`bad base64: ${text}`);
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return out;
}

function installStubs() {
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (failNext) throw new Error('network down');
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ''),
    });
    return { ok: true, status: 204 } as unknown as Response;
  }) as unknown as typeof fetch;
}

async function freshModule(): Promise<typeof import('../lib/presence/accountStatus')> {
  delete require.cache[require.resolve('../lib/presence/accountStatus')];
  return import('../lib/presence/accountStatus');
}

let failures = 0;
function check(name: string, pass: boolean, detail = '') {
  if (pass) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function lastCall(): CapturedCall {
  return calls[calls.length - 1];
}

function sentBytes(): number[] {
  const body = JSON.parse(lastCall().body) as { settings: string };
  return decodeBase64(body.settings);
}

async function main() {
  installStubs();
  const mod = await freshModule();

  console.log('\nforcing a status patches the settings proto');
  {
    calls.length = 0;
    await mod.applyAccountStatus('a-token', 'dnd');
    const call = lastCall();
    check(
      'patches the PRELOADED settings proto',
      call.url === 'https://discord.com/api/v9/users/@me/settings-proto/1' && call.method === 'PATCH',
      `${call.method} ${call.url}`
    );
    check('authorizes with the token', call.headers.Authorization === 'a-token');
    check(
      'carries only the status leaf',
      Object.keys(JSON.parse(call.body)).length === 1 && 'settings' in JSON.parse(call.body),
      call.body
    );
    // Hand-derived: PreloadedUserSettings.status(11) → StatusSettings.status(1)
    // → StringValue.value(1) = "dnd". Lengths include the nested tags:
    // StringValue = 1+1+3 = 5 bytes, StatusSettings = 1+1+5 = 7 bytes.
    check(
      'encodes field 11 → 1 → "dnd"',
      JSON.stringify(sentBytes()) === JSON.stringify([0x5a, 0x07, 0x0a, 0x05, 0x0a, 0x03, 0x64, 0x6e, 0x64]),
      JSON.stringify(sentBytes())
    );
  }

  console.log('\nauto hands the status back to Discord');
  {
    calls.length = 0;
    await mod.applyAccountStatus('a-token', 'auto');
    check(
      "writes the default 'unknown' so a previous override is undone",
      JSON.stringify(sentBytes()) ===
        JSON.stringify([0x5a, 0x0b, 0x0a, 0x09, 0x0a, 0x07, 0x75, 0x6e, 0x6b, 0x6e, 0x6f, 0x77, 0x6e]),
      JSON.stringify(sentBytes())
    );
    calls.length = 0;
    await mod.applyAccountStatus('a-token', null);
    check('a null status still patches once', calls.length === 1, String(calls.length));
    check(
      'null also writes unknown',
      JSON.stringify(sentBytes()) ===
        JSON.stringify([0x5a, 0x0b, 0x0a, 0x09, 0x0a, 0x07, 0x75, 0x6e, 0x6b, 0x6e, 0x6f, 0x77, 0x6e]),
      JSON.stringify(sentBytes())
    );
  }

  console.log('\nfailures are silent');
  {
    failNext = true;
    let threw = false;
    try {
      await mod.applyAccountStatus('a-token', 'idle');
    } catch {
      threw = true;
    }
    check('a dead network never throws (cosmetic override)', !threw);
    failNext = false;
  }

  console.log('');
  if (failures) {
    console.log(`FAILED: ${failures} check(s)`);
    process.exit(1);
  }
  console.log('all passed');
}

void main();
