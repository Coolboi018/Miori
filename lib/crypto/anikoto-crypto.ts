// Pure-JS RC4 + standard base64 encode for the anikoto family's `vrf` param.
// No Node crypto, no Buffer, no TextEncoder — charCode loops only, so this
// runs on Hermes, Node, anywhere (same constraints as mega-crypto.ts).
//
// The site computes: vrf = btoa(rc4("simple-hash", input)) — found in their
// bundle (`O:function(t){return btoa(a("simple-hash",…))}`), verified live
// 12 Nov against ajax/episode/list + ajax/server/list (first-try 200s).
// The SAME function decrypts their `window.__cfg` blob, so the key is stable.

const VRF_KEY = 'simple-hash';
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** RC4-encrypt `data` under `key`, returning raw bytes (0-255). */
function rc4Bytes(key: string, data: string): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let n = 0;
  for (let i = 0; i < 256; i++) {
    n = (n + s[i] + key.charCodeAt(i % key.length)) % 256;
    const t = s[i];
    s[i] = s[n];
    s[n] = t;
  }
  const out = new Uint8Array(data.length);
  let a = 0;
  let b = 0;
  for (let r = 0; r < data.length; r++) {
    a = (a + 1) % 256;
    b = (b + s[a]) % 256;
    const t = s[a];
    s[a] = s[b];
    s[b] = t;
    out[r] = (data.charCodeAt(r) & 0xff) ^ s[(s[a] + s[b]) % 256];
  }
  return out;
}

function base64OfBytes(bytes: Uint8Array): string {
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

/**
 * The anikoto family's `vrf` anti-bot param:
 * standard-base64(RC4("simple-hash", input)).
 * Input is the raw value passed alongside it (show id for
 * ajax/episode/list, the RAW `data-ids` attribute for ajax/server/list).
 */
export function anikotoVrf(input: string): string {
  return base64OfBytes(rc4Bytes(VRF_KEY, input));
}
