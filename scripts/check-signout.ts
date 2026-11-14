/**
 * Signing out must not be able to report success while the token is still there.
 *
 * `logout()` used to `catch {}` and resolve, so `completeSignOut` ran to the end
 * regardless: the account cache was dropped and `setUserId(null)` published a
 * signed-out app while a valid full-access token sat in the keychain. The screen
 * said logged out, the guest rails came up, and the next launch found the token
 * and signed itself back in.
 *
 * That is the one failure in this area with a security shape to it — the user's
 * belief that they signed out is the only thing standing between them and a
 * signed-in account on a shared phone — and it is completely invisible, because
 * the symptom is the screen doing exactly what it was asked.
 *
 * `expo-secure-store` cannot be loaded outside a native runtime, so it is stubbed
 * through the CommonJS module cache and the failure is injected from there. Only
 * `logout()` is under test: whether a rejected token delete reaches the caller as
 * a thrown error, and whether the user-id key — a cached label, not a credential —
 * is correctly NOT treated as the thing that decides whether a logout worked.
 *
 * Run with:  npx tsx scripts/check-signout.ts
 */

/**
 * `require` is declared locally rather than imported from `module`, because this
 * project does not put `@types/node` in `types` and the other scripts are
 * pure-DOM and need none. `package.json` has no `"type": "module"`, so tsx emits
 * CommonJS and this is the real `require` — the same cache the stub writes into.
 */
type NodeRequire = {
  resolve(id: string): string;
  cache: Record<string, unknown>;
};
declare const require: NodeRequire;

type Deleter = (key: string) => Promise<void>;

const KEYCHAIN = new Map<string, string>([
  ['miori_anilist_token', 'a-valid-full-access-token'],
  ['miori_anilist_user', '20920'],
]);

/** Keys whose delete should throw, set by each case below. */
let failing = new Set<string>();

function installStubs() {
  const stub = (id: string, exports: unknown) => {
    const path = require.resolve(id);
    require.cache[path] = {
      id: path,
      filename: path,
      path,
      exports,
      loaded: true,
      children: [],
      paths: [],
    };
  };

  const deleteItemAsync: Deleter = async (key: string) => {
    if (failing.has(key)) throw new Error(`keychain refused to delete ${key}`);
    KEYCHAIN.delete(key);
  };

  stub('expo-secure-store', {
    deleteItemAsync,
    getItemAsync: async (key: string) => KEYCHAIN.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
      KEYCHAIN.set(key, value);
    },
  });
  // Imported at module scope by auth.ts but only used by `login()`, which this
  // never calls. They still have to resolve.
  stub('expo-web-browser', { openAuthSessionAsync: async () => ({ type: 'cancel' }) });
  stub('expo-linking', { createURL: (p: string) => `miori://${p}` });
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

async function attempt(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function main() {
  installStubs();
  const auth = (await import('../lib/anilist/auth')) as typeof import('../lib/anilist/auth');

  console.log('\nsign out');
  // --- the reported bug ---------------------------------------------------
  // A keychain that refuses to drop the token must NOT produce a clean sign-out.
  failing = new Set(['miori_anilist_token']);
  let msg = await attempt(() => auth.logout());
  check(
    'a refused token delete is reported, not swallowed',
    msg !== '',
    'logout() resolved — the caller would announce a sign-out that did not happen'
  );
  check(
    '…and says the token is still on the device',
    /still signed in/i.test(msg),
    msg
  );
  check(
    'the token really is still in the keychain',
    KEYCHAIN.get('miori_anilist_token') !== undefined,
    'nothing to protect — the fake should not have deleted it'
  );

  // The user-id key must still have been attempted, so a later success does not
  // leave a stale id behind.
  check(
    'the cached user id is still cleared even when the token delete failed',
    KEYCHAIN.get('miori_anilist_user') === undefined,
    'stale label left behind'
  );

  // --- the ordinary path --------------------------------------------------
  failing = new Set();
  KEYCHAIN.set('miori_anilist_token', 'a-valid-full-access-token');
  KEYCHAIN.set('miori_anilist_user', '20920');
  msg = await attempt(() => auth.logout());
  check('a normal sign-out resolves', msg === '', msg);
  check(
    'and the token is gone',
    KEYCHAIN.get('miori_anilist_token') === undefined,
    'token survived'
  );

  // --- and the label is not what decides ----------------------------------
  // A failed USER delete is not a failed logout. Reporting one as the other
  // would send the caller into a retry that can never succeed, and would tell the
  // user they are still signed in when the credential is already gone.
  failing = new Set(['miori_anilist_user']);
  KEYCHAIN.set('miori_anilist_token', 'a-valid-full-access-token');
  KEYCHAIN.set('miori_anilist_user', '20920');
  msg = await attempt(() => auth.logout());
  check(
    'a failed USER delete alone still counts as signed out',
    msg === '',
    msg || ''
  );
  check(
    '…because the token was removed',
    KEYCHAIN.get('miori_anilist_token') === undefined,
    'token survived'
  );
  check(
    '…even though the stale label remains',
    KEYCHAIN.get('miori_anilist_user') === '20920',
    'label was removed, so this case did not test what it claims'
  );

  console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
  process.exit(failures ? 1 : 0);
}

void main();

