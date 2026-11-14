// Manifest validation for the extension loader (Phase 2).
//
// Hand-rolled on purpose: no zod/ajv dependency, and the rules here are small.
// A manifest that fails validation is skipped with a logged reason — never
// crashes the app, and never partially applies.

export interface ManifestV1 {
  contractVersion: number;
  id: string;
  label: string;
  version: string;
  capabilities?: Record<string, boolean>;
  match?: unknown;
  episodes?: unknown;
  resolve?: unknown;
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  manifest?: ManifestV1;
}

const MAX_CONTRACT = 1;

export function validateManifest(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not an object' };
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id.trim()) return { ok: false, reason: 'missing id' };
  if (typeof o.label !== 'string' || !o.label.trim()) return { ok: false, reason: 'missing label' };
  if (typeof o.version !== 'string' || !o.version.trim()) return { ok: false, reason: 'missing version' };
  const cv = o.contractVersion;
  if (typeof cv !== 'number' || !Number.isInteger(cv) || cv < 1) {
    return { ok: false, reason: 'bad contractVersion' };
  }
  if (cv > MAX_CONTRACT) {
    return { ok: false, reason: `contractVersion ${cv} > supported ${MAX_CONTRACT}` };
  }
  return { ok: true, manifest: o as unknown as ManifestV1 };
}

export function validateIndex(
  raw: unknown
): { version: number; manifests: string[]; changelog?: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.version !== 'number') return null;
  if (!Array.isArray(o.manifests)) return null;
  if (!o.manifests.every((m) => typeof m === 'string')) return null;
  // `changelog` is display-only (the repo card's subtitle) — optional, and a
  // non-string value is dropped rather than failing the whole index.
  return {
    version: o.version as number,
    manifests: o.manifests as string[],
    changelog: typeof o.changelog === 'string' ? o.changelog : undefined,
  };
}