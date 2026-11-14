// Toolbox registry for the extension engine.
//
// A manifest never carries runnable code. Instead it references a tool by name
// (e.g. "decrypt": "mega-aes"). The engine looks the name up here and calls it.
// If a tool is missing, the source that needs it is skipped — never a crash.
//
// Phase 1 only ships the tools that already exist in the codebase, re-exposed
// under stable names. New tools are added here; that is the only place that
// requires an app update.

export type ToolFn = (...args: any[]) => any;

import { decryptMegaEnc } from '../../crypto/mega-crypto';
import { anikotoVrf } from '../../crypto/anikoto-crypto';
import { decodeSourcesPayload } from '../filmu';
import { decodeZokoBlob } from '../zoko';
import { megaFlow, megaMatch } from './mega';
import { filmuFlow, filmuMatch } from './filmu';
import { anikotoFlow, anikotoMatch, anikotoEpisodes } from './anikoto';
import { zokoFlow, zokoMatch, zokoEpisodes } from './zoko';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64UrlToBytes(input: string): Uint8Array {
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
  let pad = 0;
  if (b64.endsWith('==')) pad = 2;
  else if (b64.endsWith('=')) pad = 1;
  return new Uint8Array(out.slice(0, out.length - pad));
}

export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i];
    if (b0 < 0x80) { out += String.fromCharCode(b0); i += 1; }
    else if ((b0 & 0xe0) === 0xc0) { out += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f)); i += 2; }
    else if ((b0 & 0xf0) === 0xe0) { out += String.fromCharCode(((b0 & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)); i += 3; }
    else {
      const cp = ((b0 & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      const v = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      i += 4;
    }
  }
  return out;
}

export function renderTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) =>
    vars[k] !== undefined ? String(vars[k]) : `{${k}}`
  );
}

export function regexExtract(text: string, pattern: string): string | null {
  try {
    const m = new RegExp(pattern).exec(text);
    return m ? (m[1] ?? m[0]) : null;
  } catch {
    return null;
  }
}

export function jsonPath(obj: any, path: string): any {
  if (!path || path === '$') return obj;
  const p = path.replace(/^\$\./, '').replace(/^\$/, '');
  if (!p) return obj;
  const tokens = p.match(/[^.[\]]+/g) ?? [];
  let cur: any = obj;
  for (const t of tokens) {
    if (cur == null) return undefined;
    cur = cur[t];
  }
  return cur;
}

export const cryptoTools: Record<string, ToolFn> = {
  'mega-aes': (enc: string) => decryptMegaEnc(enc),
  'bingr-keystream': (text: string) => decodeSourcesPayload(text),
  'anikoto-vrf': (input: string) => anikotoVrf(input),
  'zoko-xor': (blob: string) => decodeZokoBlob(blob),
  'mega-flow': (anilistId: number, ep: number, idMal?: number | null) => megaFlow(anilistId, ep, idMal),
  'mega-match': (anilistId: number, idMal?: number | null) => megaMatch(anilistId, idMal),
  'filmu-flow': (anilistId: number, ep: number, idMal?: number | null, hint?: any) => filmuFlow(anilistId, ep, idMal, hint),
  'filmu-match': (anilistId: number, idMal?: number | null, hint?: any) => filmuMatch(anilistId, idMal, hint),
  'anikoto-flow': (anilistId: number, ep: number, idMal?: number | null, hint?: any) => anikotoFlow(anilistId, ep, idMal, hint),
  'anikoto-match': (anilistId: number, idMal?: number | null, hint?: any) => anikotoMatch(anilistId, idMal, hint),
  'anikoto-episodes': (anilistId: number, idMal?: number | null, hint?: any) => anikotoEpisodes(anilistId, idMal, hint),
  'zoko-flow': (anilistId: number, ep: number, idMal?: number | null) => zokoFlow(anilistId, ep, idMal),
  'zoko-match': (anilistId: number, idMal?: number | null) => zokoMatch(anilistId, idMal),
  'zoko-episodes': (anilistId: number, idMal?: number | null) => zokoEpisodes(anilistId, idMal),
};

export const TOOLS: Record<string, ToolFn> = {
  ...cryptoTools,
  'base64url-to-bytes': base64UrlToBytes,
  'utf8-decode': utf8Decode,
  'render-template': renderTemplate,
  'regex-extract': regexExtract,
  'json-path': jsonPath,
};

export function getTool(name: string): ToolFn | undefined {
  return TOOLS[name];
}

export function hasTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOLS, name);
}