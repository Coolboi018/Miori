// The search field — one component, two screens.
//
// It was born inline on the anime detail page ("Jump to episode #") and the
// search tab grew its own, worse one: no icon, no clear button, no focus
// feedback, and a hardcoded `#15151d` for a background the palette already
// names. Two text fields that are supposed to look like the same control is
// how an app stops feeling like one thing.
//
// THE DESIGN, and why each piece is here:
//
//   [ ( ) Search anime                              (×) ]
//    ↑                                               ↑
//   icon, so the field is identifiable when empty  clear, so undoing a
//   AND the row is not three floating glyphs      twenty characters is one
//
// - FULL-RADIUS, 42px. A search field is a pill everywhere the user has ever
//   met one; a rounded rectangle reads as a form input.
// - A HAIRLINE FRAME, not a fill-only field. The frame is what changes on
//   focus, which is the entire focus affordance on both platforms — a border
//   colour that steps from `border.muted` to `text.secondary` is visible in a
//   glance and costs nothing.
// - `paddingVertical: 0`. Android gives single-line inputs its own vertical
//   padding and the glyph then sits below the text's optical centre. This is
//   the long-standing RN text-input alignment bug; the zero is the fix.
//
// PERFORMANCE: one TextInput, one icon, one Pressable. No blur, no shadow, no
// animated border — the focus ring is a colour swap, so it lands on the frame
// without waiting on the JS thread.

import { forwardRef, memo, useCallback, useState } from 'react';
import {
  StyleSheet,
  TextInput,
  View,
  // Strict TypeScript API (RN 0.88): element refs are instance types.
  type TextInputInstance,
} from 'react-native';
import { useTheme } from '@/lib/ui/useTheme';
import { font, radii, spacing } from '@/lib/ui/tokens';
import { AppIcon } from './AppIcon';
import { RoundedPressable } from './RoundedPressable';

export interface SearchFieldProps {
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  /** Fired on the keyboard's search/return key. */
  onSubmit?: () => void;
  autoFocus?: boolean;
  /** Defaults to the detail page's episode jumper. */
  keyboardType?: 'default' | 'number-pad';
  /** Marks the field as having produced a real, submitted query. */
  onFocusChange?: (focused: boolean) => void;
}

export const SearchField = memo(
  forwardRef<TextInputInstance, SearchFieldProps>(function SearchField(
    {
      value,
      onChangeText,
      placeholder = 'Search anime',
      onSubmit,
      autoFocus = false,
      keyboardType = 'default',
      onFocusChange,
    },
    ref
  ) {
    const { color } = useTheme();
    const [focused, setFocused] = useState(false);

    // One handler for both, so the internal ring and the caller's `focused`
    // flag can never disagree about whether the field is focused.
    const setFocus = useCallback(
      (next: boolean) => {
        setFocused(next);
        onFocusChange?.(next);
      },
      [onFocusChange]
    );

    return (
      <View
        style={[
          styles.field,
          {
            backgroundColor: focused ? color.bg.surfaceHover : color.bg.surface,
            // THE focus ring, and the whole of it: a border colour step plus a
            // one-step fill step. Both are plain style props, so the field
            // acknowledges the tap on the same frame the native view does.
            borderColor: focused ? color.text.secondary : color.border.muted,
          },
        ]}
      >
        <AppIcon name="search" size={16} color={focused ? color.text.secondary : color.text.muted} />

        <TextInput
          ref={ref}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={color.text.muted}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus={autoFocus}
          keyboardType={keyboardType}
          returnKeyType="search"
          onSubmitEditing={onSubmit}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          accessibilityLabel={placeholder}
          style={[styles.input, { color: color.text.primary }]}
        />

        {/* The clear button only exists when there is something to clear —
            otherwise it is a target sitting where your thumb lands, waiting to
            do nothing. */}
        {value.length > 0 ? (
          // A borderless ripple here was a circle that ignored the field's own
          // radius and could spill past its edge; the wash is clipped to the
          // button instead.
          <RoundedPressable
            onPress={() => onChangeText('')}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            hitSlop={10}
            radius={9999}
            style={styles.clear}
          >
            <AppIcon name="close" size={16} color={color.text.muted} />
          </RoundedPressable>
        ) : null}
      </View>
    );
  })
);

const styles = StyleSheet.create({
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    height: 42,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    fontSize: 14,
    fontFamily: font.regular,
    // Android's own vertical padding misaligns a single-line field; zeroing it
    // is what puts the text on the icon's centre line.
    paddingVertical: 0,
  },
  clear: {
    // Circular hit target without a visible plate, so the field keeps its
    // clean silhouette while the target stays thumb-sized.
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
});