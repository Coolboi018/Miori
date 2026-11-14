import aesjs from 'aes-js';

// Pure-JS AES-256-CBC decrypt for MegaPlay `enc` payloads.
// No Node crypto, no Buffer, no TextEncoder/TextDecoder — only charCode
// loops + aes-js block cipher, so this runs on Hermes, Node, anywhere.
// Key/IV extracted from their newclient.min.js SegmentDecrypt.

const KEY_SEED = 'i?LMTAx0Q6,:}50U'; // UTF-8 bytes, zero-padded to 32
const IV_STR = "W0;27ToaUpl_P%'c"; // 16 bytes as-is

function strToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64urlToBytes(input: string): Uint8Array {
  let b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const out: number[] = [];
  for (let i = 0; i < b64.length; i += 4) {
    const c0 = B64.indexOf(b64[i]);
    const c1 = B64.indexOf(b64[i + 1]);
    const c2 = b64[i + 2] === '=' ? 0 : B64.indexOf(b64[i + 2]);
    const c3 = b64[i + 3] === '=' ? 0 : B64.indexOf(b64[i + 3]);
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) throw new Error('bad base64');
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    out.push((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  // Strip padding bytes: '==' -> 2 bytes, '=' -> 1 byte
  let pad = 0;
  if (b64.endsWith('==')) pad = 2;
  else if (b64.endsWith('=')) pad = 1;
  return new Uint8Array(out.slice(0, out.length - pad));
}

function pkcs7Strip(data: Uint8Array): Uint8Array {
  if (!data.length) throw new Error('empty plaintext');
  const pad = data[data.length - 1];
  if (pad < 1 || pad > 16 || pad > data.length) throw new Error('bad padding');
  for (let i = data.length - pad; i < data.length; i++) {
    if (data[i] !== pad) throw new Error('bad padding');
  }
  return data.slice(0, data.length - pad);
}

function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
    } else if ((b0 & 0xe0) === 0xc0) {
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if ((b0 & 0xf0) === 0xe0) {
      out += String.fromCharCode(
        ((b0 & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
      );
      i += 3;
    } else {
      const cp =
        ((b0 & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      const v = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      i += 4;
    }
  }
  return out;
}

/** Decrypt MegaPlay `enc` -> JSON text like {"file":"https://.../master.m3u8"} */
export function decryptMegaEnc(enc: string): string {
  const key = new Uint8Array(32);
  key.set(strToBytes(KEY_SEED)); // zero-padded to 32 = AES-256
  const iv = strToBytes(IV_STR);
  if (iv.length !== 16) throw new Error('bad iv');
  const cipher = base64urlToBytes(enc);
  if (cipher.length === 0 || cipher.length % 16 !== 0) {
    throw new Error('bad enc length');
  }
  const cbc = new aesjs.ModeOfOperation.cbc(key, iv);
  const padded = cbc.decrypt(cipher);
  return utf8Decode(pkcs7Strip(padded));
}
