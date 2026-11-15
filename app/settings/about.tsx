import { Text } from 'react-native';
import { font } from '@/lib/ui/tokens';
import { pushOnce } from '@/lib/nav/pushOnce';
import { useTheme } from '@/lib/ui/useTheme';
import { resetSettings } from '@/lib/settings/useSetting';
import { SettingRow, SettingSection } from '@/components/ui/settings';
import { SettingsPage } from '@/components/settings/SettingsPage';
import {
  checkForUpdate,
  installedVersion,
  openUpdatePrompt,
  previewUpdateCard,
} from '@/lib/updates/store';
import { updateActionLabel, updateStatusLine } from '@/lib/updates/statusLine';
import { useUpdateState } from '@/lib/updates/useUpdate';

export default function AboutSettings() {
  const { color } = useTheme();

  const update = useUpdateState();

  const onPressUpdate = () => {
    // Already know about one → re-open the card; otherwise ask.
    if (update.status === 'available') openUpdatePrompt();
    else void checkForUpdate();
  };

  return (
    <SettingsPage title="About">
      <SettingSection title="About">
        <SettingRow label="Miori" hint="Expo SDK 58 · Android-first · no server, phone talks to sources directly.">
          <Text style={{ color: color.text.muted, fontSize: 13, fontFamily: font.medium }}>
            v{installedVersion()}
          </Text>
        </SettingRow>
        <SettingRow label="Check for updates" hint={updateStatusLine(update)} onPress={onPressUpdate}>
          <Text style={{ color: color.accent.base, fontSize: 15, fontFamily: font.semibold }}>
            {updateActionLabel(update)}
          </Text>
        </SettingRow>
        <SettingRow label="Diagnostics" hint="Legacy account + socket debug page.">
          <Text
            style={{ color: color.accent.base, fontSize: 15, fontFamily: font.semibold }}
            onPress={() => pushOnce('/modal')}
            accessibilityRole="button"
          >
            Open
          </Text>
        </SettingRow>
        {/* Dev only: the card without a published release or a build. Same
            parser, same component — only the payload is fake. */}
        {__DEV__ ? (
          <SettingRow
            label="Preview update card"
            hint="Debug only — renders the popup with a fake release, no network."
            onPress={() => previewUpdateCard()}
          >
            <Text style={{ color: color.accent.base, fontSize: 15, fontFamily: font.semibold }}>
              Preview
            </Text>
          </SettingRow>
        ) : null}
        {__DEV__ ? (
          <SettingRow
            label="Preview long release notes"
            hint="Debug only — a six-section changelog, to prove it scrolls instead of growing the card."
            onPress={() => previewUpdateCard('long')}
          >
            <Text style={{ color: color.accent.base, fontSize: 15, fontFamily: font.semibold }}>
              Preview
            </Text>
          </SettingRow>
        ) : null}
      </SettingSection>
      <SettingSection title="Reset">
        <SettingRow label="Restore defaults" hint="Puts every setting back to how it shipped.">
          <Text
            style={{ color: color.status.danger, fontSize: 15, fontFamily: font.semibold }}
            onPress={resetSettings}
            accessibilityRole="button"
          >
            Reset
          </Text>
        </SettingRow>
      </SettingSection>
    </SettingsPage>
  );
}
