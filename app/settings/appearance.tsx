// Appearance settings — split out of the settings index so the index is a
// pure category list. Adding a design to TILE_STYLES needs no change here:
// SettingSegments renders whatever the registry holds.

import { Pressable, StyleSheet, View } from 'react-native';
import { SettingRow, SettingSection, SettingSegments } from '@/components/ui/settings';
import { SettingsPage } from '@/components/settings/SettingsPage';
import {
  APP_THEMES,
  SEGMENTED_COLORS,
  TAB_BAR_STYLES,
  TILE_STYLES,
  type AppThemeKey,
  type SegmentedColor,
} from '@/lib/settings/store';
import { useSetSetting, useSetting } from '@/lib/settings/useSetting';
import { useTheme } from '@/lib/ui/useTheme';
import { radii } from '@/lib/ui/tokens';

/** Colour swatches for the Segmented pill — circles, checked ring on the pick. */
function ColorSwatches({
  value,
  onChange,
}: {
  value: SegmentedColor;
  onChange: (v: SegmentedColor) => void;
}) {
  const { color } = useTheme();
  return (
    <View style={styles.swatchRow}>
      {SEGMENTED_COLORS.map((c) => {
        const active = c.key === value;
        return (
          <Pressable
            key={c.key}
            onPress={() => onChange(c.key)}
            accessibilityRole="radio"
            accessibilityLabel={`${c.label} pill`}
            accessibilityState={{ selected: active }}
            hitSlop={6}
            style={[
              styles.swatch,
              { backgroundColor: c.key, borderColor: active ? color.text.primary : 'transparent' },
            ]}
          />
        );
      })}
    </View>
  );
}

export default function AppearanceSettings() {
  const theme = useSetting('app.theme');
  const tileStyle = useSetting('home.tileStyle');
  const tabBarStyle = useSetting('tabs.style');
  const segColor = useSetting('tabs.segmentedColor');
  const set = useSetSetting();

  return (
    <SettingsPage title="Appearance">
      <SettingSection title="Theme">
        <SettingRow
          label="App colour"
          hint={APP_THEMES.find((t) => t.key === theme)?.hint}
        >
          <SettingSegments
            value={theme}
            options={APP_THEMES.map((t) => [t.key, t.label] as const)}
            onChange={(v) => set('app.theme', v as AppThemeKey)}
          />
        </SettingRow>
      </SettingSection>
      <SettingSection title="Home screen">
        <SettingRow
          label="Poster tile design"
          hint={TILE_STYLES.find((t) => t.key === tileStyle)?.hint}
        >
          <SettingSegments
            value={tileStyle}
            options={TILE_STYLES.map((t) => [t.key, t.label] as const)}
            onChange={(v) => set('home.tileStyle', v)}
          />
        </SettingRow>
      </SettingSection>
      <SettingSection title="Tab bar">
        <SettingRow
          label="Tab bar style"
          hint={TAB_BAR_STYLES.find((t) => t.key === tabBarStyle)?.hint}
        >
          <SettingSegments
            value={tabBarStyle}
            options={TAB_BAR_STYLES.map((t) => [t.key, t.label] as const)}
            onChange={(v) => set('tabs.style', v)}
          />
        </SettingRow>
        {/* Colour only applies to the Segmented pill — hidden otherwise. */}
        {tabBarStyle === 'segmented' ? (
          <SettingRow label="Pill colour">
            <ColorSwatches
              value={segColor}
              onChange={(v) => set('tabs.segmentedColor', v)}
            />
          </SettingRow>
        ) : null}
      </SettingSection>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  swatchRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  swatch: {
    width: 26,
    height: 26,
    borderRadius: radii.full,
    borderWidth: 2,
  },
});
