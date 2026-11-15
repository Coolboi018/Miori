import { useCallback, useEffect, useState } from 'react';
import { font, spacing } from '@/lib/ui/tokens';
import { Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { pushOnce } from '@/lib/nav/pushOnce';
import { useTheme } from '@/lib/ui/useTheme';
import { SettingRow, SettingSection, SettingSegments } from '@/components/ui/settings';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { completeSignOut } from '@/lib/auth/actions';
import { useSetting, useSetSetting } from '@/lib/settings/useSetting';
import { PRESENCE_STATUSES } from '@/lib/settings/store';
import { gatewayBadge, gatewayHint, gatewayStatus, subscribeGatewayStatus } from '@/lib/presence/gateway';

import { useViewer } from '@/lib/auth/queries';
import {
  clearDiscordToken,
  clearPresence,
  fetchDiscordUser,
  getDiscordToken,
  isPresenceEnabled,
  logoutDiscordSession,
  setPresenceEnabled,
  type DiscordUser,
} from '@/lib/presence/discord';

export default function AccountsSettings() {
  const { color } = useTheme();

  const [duser, setDuser] = useState<DiscordUser | null>(null);
  const [presenceOn, setPresenceOn] = useState(false);
  const [checking, setChecking] = useState(true);
  const presenceStatus = useSetting('presence.status');
  const setPresenceStatus = useSetSetting();
  const [gw, setGw] = useState(() => gatewayStatus());
  const gwBadge = gatewayBadge(gw);
  const gwTone = gwBadge.tone;
  /**
   * Why a sign-out did not happen.
   *
   * Required, not polish. `completeSignOut` throws when the keychain refuses to
   * drop the token — deliberately, so it cannot announce a sign-out that did not
   * occur — which means this screen now owns the failure. Without a `catch` here
   * it would surface as an unhandled rejection: no message, no state change, and
   * a tap that looks like it did nothing. Rejection is the one outcome worse than
   * the silent success it replaced.
   */
  const [msg, setMsg] = useState<string | null>(null);

  // The shared entry. This screen used to hold its own `viewer` state and fetch it on
  // mount, which meant opening it straight after the account modal fired a second
  // request for a name that modal had just fetched — and a sign-out performed here
  // could not be seen by anything else that was already open.
  const { viewer } = useViewer();

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const dtoken = await getDiscordToken();
      setDuser(dtoken ? await fetchDiscordUser(dtoken).catch(() => null) : null);
      if (dtoken) {
        let on = await isPresenceEnabled();
        if (!on) { await setPresenceEnabled(true); on = true; }
        setPresenceOn(on);
      } else {
        setPresenceOn(false);
      }
    } catch {
      setDuser(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh])
  );

  useEffect(() => {
    const unsub = subscribeGatewayStatus(setGw);
    return () => unsub();
  }, []);

  return (
    <SettingsPage title="Accounts">
      <SettingSection title="AniList">
        <SettingRow
          label={checking ? 'Checking…' : viewer ? viewer.name : 'Not logged in'}
          hint={viewer ? `ID ${viewer.id} — progress syncs to your list` : 'Log in to sync episode progress.'}
        >
          {viewer ? (
            <Text
              style={{ color: color.status.danger, fontSize: 15, fontFamily: font.semibold }}
              onPress={async () => {
                // No local `setViewer(null)`. `completeSignOut` drops the cache key
                // and publishes the change, so this screen's `useViewer` returns null
                // on the next render — which is also what makes every OTHER screen
                // showing this account update.
                try {
                  await completeSignOut();
                  setMsg(null);
                } catch (e) {
                  // Still signed in, and saying so is the whole point: the token is
                  // on the device whatever this screen's state says.
                  setMsg(e instanceof Error ? e.message : 'Sign out failed');
                }
              }}
              accessibilityRole="button"
            >
              Log out
            </Text>
          ) : (
            <Text
              style={{ color: color.accent.base, fontSize: 15, fontFamily: font.semibold }}
              onPress={() => pushOnce('/login')}
              accessibilityRole="button"
            >
              Log in
            </Text>
          )}
        </SettingRow>
      </SettingSection>

      <SettingSection title="Discord">
        <SettingRow
          label={duser ? (duser.global_name ?? duser.username) : 'Not logged in'}
          hint={duser ? 'Shows Watching status while you play.' : 'Log in to show what you watch.'}
        >
          {duser ? (
            <Text
              style={{ color: color.status.danger, fontSize: 15, fontFamily: font.semibold }}
              onPress={async () => {
                // The neutral presence frame is best-effort. It USED to be awaited
                // unguarded, so a Discord hiccup on that one network call threw,
                // `clearDiscordToken` never ran, and the screen reported nothing
                // while the user sat there still "logged in" with no feedback. A
                // stale presence is cosmetic; holding a token is not.
                await clearPresence(true).catch(() => {});
                await clearDiscordToken();
                await setPresenceEnabled(false);
                setDuser(null);
                setPresenceOn(false);
                setMsg(null);
              }}
              accessibilityRole="button"
            >
              Log out
            </Text>
          ) : (
            <Text
              style={{ color: color.accent.base, fontSize: 15, fontFamily: font.semibold }}
              onPress={() => pushOnce('/discord-login')}
              accessibilityRole="button"
            >
              Log in
            </Text>
          )}
        </SettingRow>
        {duser ? (
          <>
            <SettingRow
              label="Rich presence"
              hint="Update Discord while watching."
              // The ROW owns the switch, so the whole tile toggles — see
              // `components/ui/settings.tsx`.
              toggle={{
                value: presenceOn,
                onChange: (on) => {
                  setPresenceOn(on);
                  void (async () => {
                    await setPresenceEnabled(on);
                    if (!on) await clearPresence(true);
                  })();
                },
              }}
            />
            <SettingRow label="Status" hint="Overrides your whole Discord account while connected.">
              <SettingSegments
                value={presenceStatus}
                options={PRESENCE_STATUSES.map((s) => [s.key, s.label] as const)}
                onChange={(v) => setPresenceStatus('presence.status', v)}
              />
            </SettingRow>
            <SettingRow label="Gateway" hint={gatewayHint(gw)}>
              <Text
                style={{
                  color: gwTone === 'ready' ? '#4ade80' : gwTone === 'connecting' ? '#fbbf24' : '#f87171',
                  fontSize: 13,
                  fontFamily: font.semibold,
                }}
              >
                {gwBadge.label}
              </Text>
            </SettingRow>
            <SettingRow
              label="Switch account"
              hint="Wipe this account and log in as someone else."
            >
              <Text
                style={{ color: color.accent.base, fontSize: 15, fontFamily: font.semibold }}
                onPress={async () => {
                  try {
                    const t = await getDiscordToken();
                    if (t) await logoutDiscordSession(t);
                  } catch {
                    /* ignore */
                  }
                  await clearPresence(true).catch(() => {});
                  await clearDiscordToken();
                  await setPresenceEnabled(false);
                  setDuser(null);
                  setPresenceOn(false);
                  setMsg(null);
                  pushOnce('/discord-login', { fresh: '1' });
                }}
                accessibilityRole="button"
              >
                Switch
              </Text>
            </SettingRow>
          </>
        ) : null}
      </SettingSection>

      {msg ? (
        <View style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.sm }}>
          <Text style={{ color: color.text.muted, fontSize: 13, fontFamily: font.medium }}>
            {msg}
          </Text>
        </View>
      ) : null}
    </SettingsPage>
  );
}
