// Settings copy for the updater — ONE source.
//
// Two screens show this state now: the root Settings list (a quick row that
// also runs the check) and Settings → About (the version, the details). Copy
// written twice is copy that drifts, and the drift here would be a row that
// says "check" while the other says "install". Pure strings over a state
// object, so this module imports nothing but the type.

import type { UpdateState } from './store';

/** The sentence under the row. */
export function updateStatusLine(state: UpdateState): string {
  switch (state.status) {
    case 'checking':
      return 'Asking GitHub for the newest release…';
    case 'available':
      return state.release ? `v${state.release.version} is ready to install.` : 'An update is ready.';
    case 'current':
      return 'You are on the newest build.';
    case 'error':
      return state.error ?? 'Could not check for updates.';
    default:
      // Nothing checked yet this session: say where updates come FROM, which is
      // the question a sideloaded app always raises.
      return 'Downloads come straight from the GitHub release — no store needed.';
  }
}

/** The right-hand action word. `Install` once there is something to install. */
export function updateActionLabel(state: UpdateState): string {
  if (state.status === 'checking') return 'Checking…';
  if (state.status === 'available') return 'Install';
  return 'Check';
}
