import { Text } from 'react-native';
import { font } from '@/lib/ui/tokens';
import { useRouter } from 'expo-router';
import { useTheme } from '@/lib/ui/useTheme';
import { resetSettings } from '@/lib/settings/useSetting';
import { SettingRow, SettingSection } from '@/components/ui/settings';
import { SettingsPage } from '@/components/settings/SettingsPage';

export default function AboutSettings() {
  const { color } = useTheme();
  const router = useRouter();

  return (
    <SettingsPage title="About">
      <SettingSection title="About">
        <SettingRow label="Miori" hint="Expo SDK 57 · Android-first · no server, phone talks to sources directly.">
          <Text style={{ color: color.text.muted, fontSize: 13, fontFamily: font.medium }}>v1.0.0</Text>
        </SettingRow>
        <SettingRow label="Diagnostics" hint="Legacy account + socket debug page.">
          <Text
            style={{ color: color.accent.base, fontSize: 15, fontFamily: font.semibold }}
            onPress={() => router.push('/modal')}
            accessibilityRole="button"
          >
            Open
          </Text>
        </SettingRow>
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
