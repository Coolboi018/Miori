// Player chrome atoms.
//
// This file used to carry the whole settings popover; the popover has grown up
// into the full right-hand settings panel (`SettingsPanel.tsx`, the episode
// panel's sibling) — what stays here is the shared vocabulary the chrome and
// the panel both speak:
//
//  - `MenuRow` — one option row. `hint` is the right-side annotation (a
//    resolution, a source index, the current value of a drill-in entry), `to`
//    marks a NAVIGATION row (drill into that panel view), `selected`/
//    `disabled` are the row states the panel paints.
//  - `Trigger` — the bottom-bar chip. Its width is its own business and never
//    the row's (see Chrome.tsx's four-slots comment for why the column, not
//    the chip, owns geometry).

import { memo } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { AppIcon } from '@/components/ui/AppIcon';
import { font, radii } from '@/lib/ui/tokens';

export interface MenuRow {
  key: string;
  label: string;
  /** Right-side annotation, e.g. "(current)" or a resolution hint. */
  hint?: string;
  /** A drill-in target — pressing this row opens that panel view. */
  to?: string;
  /**
   * Domain caption for the root drill-in list — consecutive rows sharing a
   * `group` render as one captioned box ("Playback", "Subtitles").
   */
  group?: string;
  selected?: boolean;
  disabled?: boolean;
}

export const Trigger = memo(function Trigger({
  icon,
  label,
  active,
  disabled,
  onPress,
}: {
  icon: 'speed' | 'quality' | 'layers' | 'subtitles' | 'subtitlesOff' | 'volumeOn' | 'volumeOff';
  label: string;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      hitSlop={6}
      style={({ pressed }) => [
        styles.trigger,
        active ? styles.triggerActive : null,
        disabled ? styles.triggerDisabled : null,
        pressed && !disabled ? styles.triggerPressed : null,
      ]}
    >
      <AppIcon
        name={icon}
        size={18}
        color={disabled ? 'rgba(255,255,255,0.35)' : '#fff'}
        strokeWidth={2}
      />
      <Text style={styles.triggerLabel} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: radii.full,
    backgroundColor: 'rgba(255,255,255,0.1)',
    maxWidth: '100%',
    alignSelf: 'center',
  },
  triggerActive: {
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  triggerDisabled: {
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  triggerPressed: {
    opacity: 0.7,
  },
  triggerLabel: {
    flexShrink: 1,
    color: '#fff',
    fontFamily: font.semibold,
    fontSize: 13,
    lineHeight: 16,
    letterSpacing: 0.3,
  },
});
