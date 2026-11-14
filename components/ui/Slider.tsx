import { useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/lib/ui/useTheme';
import { font, spacing } from '@/lib/ui/tokens';

export function Slider({
  value,
  onValueChange,
  minimumValue = 0,
  maximumValue = 1,
  step = 0.01,
  label,
  marks,
}: {
  value: number;
  onValueChange: (v: number) => void;
  minimumValue?: number;
  maximumValue?: number;
  step?: number;
  label?: string;
  /** Tick labels. Defaults to position marks. */
  marks?: { frac: number; label: string }[];
}) {
  const { color } = useTheme();
  const [dragging, setDragging] = useState(false);
  const [trackWidth, setTrackWidth] = useState(280);

  const range = maximumValue - minimumValue;
  const clamped = Math.max(minimumValue, Math.min(maximumValue, value));
  const fraction = range > 0 ? (clamped - minimumValue) / range : 0;

  const trackWidthRef = useRef(280);
  trackWidthRef.current = trackWidth;
  const onValueChangeRef = useRef(onValueChange);
  onValueChangeRef.current = onValueChange;
  const originXRef = useRef(0);

  const snap = (f: number) => {
    const fClamped = Math.max(0, Math.min(1, f));
    const stepped = minimumValue + fClamped * range;
    const snapped = Math.round(stepped / step) * step;
    return Math.max(minimumValue, Math.min(maximumValue, snapped));
  };

  const fromLocalX = (x: number) => {
    const w = trackWidthRef.current;
    if (w <= 0) return;
    const f = x / w;
    onValueChangeRef.current(snap(f));
  };

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          originXRef.current = e.nativeEvent.pageX - e.nativeEvent.locationX;
          fromLocalX(e.nativeEvent.locationX);
          setDragging(true);
        },
        onPanResponderMove: (_e, g) => {
          const localX = g.moveX - originXRef.current;
          fromLocalX(localX);
        },
        onPanResponderRelease: () => setDragging(false),
        onPanResponderTerminate: () => setDragging(false),
        onPanResponderTerminationRequest: () => false,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const thumbSize = 24;
  const thumbX = fraction * (trackWidth - thumbSize);

  const tickMarks = marks ?? [
    { frac: 0, label: 'Bottom' },
    { frac: 0.25, label: '25%' },
    { frac: 0.5, label: '50%' },
    { frac: 0.75, label: '75%' },
    { frac: 1, label: 'Top' },
  ];

  return (
    <View>
      {label ? (
        <Text style={[styles.label, { color: color.text.muted }]}>{label}</Text>
      ) : null}
      <View
        {...pan.panHandlers}
        onLayout={(e) => {
          const w = e.nativeEvent.layout.width;
          trackWidthRef.current = w;
          setTrackWidth(w);
        }}
        accessibilityRole="adjustable"
        accessibilityValue={{ min: 0, max: 1, now: fraction }}
        accessibilityLabel={label ?? 'Slider'}
        style={[styles.trackWrap, { width: trackWidth }]}
      >
        <View
          style={[
            styles.track,
            {
              backgroundColor: color.bg.elevated,
              height: 6,
              borderRadius: 3,
            },
          ]}
        >
          <View
            style={[
              styles.trackFill,
              {
                backgroundColor: color.accent.base,
                width: fraction * (trackWidth - thumbSize),
                height: 6,
                borderRadius: 3,
              },
            ]}
          />
        </View>
        <View
          style={[
            styles.thumb,
            {
              left: thumbX,
              top: 8,
              backgroundColor: dragging ? color.accent.base : color.bg.surface,
              borderColor: color.accent.base,
              height: thumbSize,
              width: thumbSize,
              borderRadius: thumbSize / 2,
            },
          ]}
        />
      </View>
      <View style={styles.marks}>
        {tickMarks.map((m) => (
          <Text
            key={m.frac}
            numberOfLines={1}
            style={[
              styles.mark,
              {
                color:
                  Math.abs(fraction - m.frac) < 0.01
                    ? color.accent.base
                    : color.text.muted,
              },
            ]}
          >
            {m.label}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 13,
    fontFamily: font.semibold,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  trackWrap: {
    alignSelf: 'center',
    justifyContent: 'center',
    height: 40,
  },
  track: {
    position: 'relative',
    width: '100%',
  },
  trackFill: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
  thumb: {
    position: 'absolute',
    borderWidth: 2,
  },
  marks: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    marginTop: spacing.xs,
  },
  mark: {
    fontSize: 12,
    fontFamily: font.regular,
    flex: 1,
    textAlign: 'center',
  },
});