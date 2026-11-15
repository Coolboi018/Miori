// Subtitle settings — language, size, position, background.
//
// Split out of `player.tsx` rather than added to it, because this is a
// different question from the one that page answers. Everything on the Player
// page configures a property of the exo-video pipeline: buffers, tolerance,
// audio mixing. Those have effects on playback and belong beside each other.
// Nothing here touches the pipeline at all — it changes how OUR overlay draws
// text we already fetched and parsed. Putting them together would suggest the
// subtitle size does something to the video, which is the exact kind of
// implication `player.tsx`'s own header rule ("every option maps to a property
// that EXISTS in the SDK and is read somewhere") exists to prevent.
//
// Every row below has a LIVE PREVIEW, for the same reason the overlay refuses
// to default its style: a setting you cannot see the effect of is a setting
// nobody changes. The preview is a real `SubtitleOverlay` fed a real cue and the
// real resolved style, so what you are shown is what plays — not a mock-up that
// can drift from it.

import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { SubtitleOverlay } from '@/components/player/SubtitleOverlay';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { AppIcon } from '@/components/ui/AppIcon';
import { SettingRow, SettingSection } from '@/components/ui/settings';
import {
  SUBTITLE_BACKGROUNDS,
  SUBTITLE_COLORS,
  SUBTITLE_DELAY_MARKS,
  SUBTITLE_DELAY_MAX,
  SUBTITLE_DELAY_MIN,
  SUBTITLE_DELAY_STEP,
  SUBTITLE_POSITIONS,
  SUBTITLE_SIZES,
  type SubtitleBackgroundKey,
  type SubtitleColorKey,
  type SubtitlePositionKey,
  type SubtitleSizeKey,
} from '@/lib/settings/store';
import { Slider } from '@/components/ui/Slider';
import { useSetting, useSetSetting } from '@/lib/settings/useSetting';
import { SUBTITLE_TYPEGRAPHY, resolveSubtitleStyle } from '@/lib/subtitles/style';
import { cueAt, formatSubtitleDelay, type Cue } from '@/lib/subtitles/vtt';
import { font, radii, spacing } from '@/lib/ui/tokens';
import { useTheme } from '@/lib/ui/useTheme';

/** Two seconds of a real-shaped cue — long enough to wrap, short enough to fit. */
const SAMPLE: Cue[] = [{ start: 0, end: 10, text: 'It was not the end of the world,\nand she knew it.' }];

const SUBTITLE_COLOR_HEX: Record<SubtitleColorKey, string> = {
  white: '#ffffff',
  yellow: '#facc15',
  green: '#4ade80',
  cyan: '#22d3ee',
  magenta: '#e879f9',
};

export default function SubtitleSettings() {
  const { color: themeColor } = useTheme();
  const setSetting = useSetSetting();
  const language = useSetting('subs.language');
  const size = useSetting('subs.size');
  const position = useSetting('subs.position');
  const background = useSetting('subs.background');
  const subsColor = useSetting('subs.color');
  const subsPositionFrac = useSetting('subs.positionFrac');
  const subsDelayMs = useSetting('subs.delayMs');

  const style = useMemo(
    () => resolveSubtitleStyle({ size, position, positionFrac: subsPositionFrac, background, color: subsColor }),
    [size, position, subsPositionFrac, background, subsColor]
  );

  // `cueAt` with a time inside the sample cue, so the preview renders through
  // the SAME lookup the player uses. It is the boundary behaviour that was
  // broken, and a preview that bypassed it would be a preview of a different
  // player than the one that ships.
  const cue = useMemo(() => cueAt(SAMPLE, 1), []);

  return (
    <SettingsPage title="Subtitles">
      {/* The same overlay the player draws, at the same measured-bar offset, so
          the box position a viewer sees here is the box position they get. */}
      <View style={[styles.preview, { backgroundColor: themeColor.bg.surface }]}>
        <Text style={[styles.previewLabel, { color: themeColor.text.muted }]}>PREVIEW</Text>
        <View style={styles.previewStage}>
          <SubtitleOverlay cue={cue} style={style} bottomOffset={PREVIEW_BAR} />
        </View>
      </View>

      <SettingSection title="Language">
        <SettingRow
          label="Default subtitles"
          hint={
            language === 'off'
              ? 'Off. Sources that ship subtitles will not show them.'
              : language === 'auto'
                ? 'English when a source offers it, otherwise whatever it ships first.'
                : `Prefers “${language}”, falling back to English when a source does not carry it.`
          }
        >
          <Text style={[styles.value, { color: themeColor.accent.base }]}>
            {language === 'auto' ? 'Auto' : language === 'off' ? 'Off' : language.toUpperCase()}
          </Text>
        </SettingRow>
        <SettingRow
          label="Change it while watching"
          hint="The subtitles button in the player overrides this for the episode you are in, and remembers the choice for the next one."
        >
          <AppIcon name="subtitles" size={18} color={themeColor.text.muted} />
        </SettingRow>
      </SettingSection>

      <SettingSection title="Text size">
        <View style={styles.sliderSection}>
          <Text style={[styles.sliderLabel, { color: themeColor.text.muted }]}>
            {SUBTITLE_SIZES.find((s) => s.key === size)?.label} · {SUBTITLE_TYPEGRAPHY[size].fontSize}pt
          </Text>
          <Slider
            value={SUBTITLE_SIZES.findIndex((s) => s.key === size)}
            onValueChange={(v) => {
              const idx = Math.round(v);
              const opt = SUBTITLE_SIZES[idx];
              if (opt) setSetting('subs.size', opt.key as SubtitleSizeKey);
            }}
            minimumValue={0}
            maximumValue={SUBTITLE_SIZES.length - 1}
            step={1}
            marks={SUBTITLE_SIZES.map((s, i) => ({ frac: i / (SUBTITLE_SIZES.length - 1), label: String(SUBTITLE_TYPEGRAPHY[s.key as SubtitleSizeKey].fontSize) }))}
          />
        </View>
      </SettingSection>

      <SettingSection title="Position">
        {SUBTITLE_POSITIONS.map((p) => (
          <SettingRow
            key={p.key}
            label={p.label}
            hint={p.hint}
            onPress={() => setSetting('subs.position', p.key as SubtitlePositionKey)}
          >
            <Radio
              active={position === p.key}
              onPress={() => setSetting('subs.position', p.key as SubtitlePositionKey)}
              label={`Subtitle position ${p.label}`}
            />
          </SettingRow>
        ))}
      </SettingSection>
      <View style={styles.sliderSection}>
        <Text style={[styles.sliderLabel, { color: themeColor.text.muted }]}>
          {/* The fraction only means something in 'custom' mode: 'default' is the
              bar's measured height, which no percentage describes. Printing
              "0% from bottom" there would be a label for a placement nothing
              uses. */}
          {position === 'default'
            ? 'Default — near the bottom edge'
            : `${Math.round(style.positionFrac * 100)}% from bottom`}
        </Text>
        <Slider
          value={style.positionFrac}
          onValueChange={(v) => {
            setSetting('subs.position', 'custom');
            setSetting('subs.positionFrac', v);
          }}
          minimumValue={0}
          maximumValue={1}
          step={0.01}
        />
      </View>

      <SettingSection title="Behind the text">
        {SUBTITLE_BACKGROUNDS.map((b) => (
          <SettingRow
            key={b.key}
            label={b.label}
            hint={b.hint}
            onPress={() => setSetting('subs.background', b.key as SubtitleBackgroundKey)}
          >
            <Radio
              active={background === b.key}
              onPress={() => setSetting('subs.background', b.key as SubtitleBackgroundKey)}
              label={`Subtitle background ${b.label}`}
            />
          </SettingRow>
        ))}
      </SettingSection>

      <SettingSection title="Text colour">
        {SUBTITLE_COLORS.map((c) => {
          const swatch = SUBTITLE_COLOR_HEX[c.key as SubtitleColorKey];
          const active = subsColor === c.key;
          return (
            <SettingRow
              key={c.key}
              label={c.label}
              hint={c.hint}
              onPress={() => setSetting('subs.color', c.key as SubtitleColorKey)}
            >
              <View
                style={[
                  styles.colorSwatch,
                  {
                    backgroundColor: swatch,
                    borderColor: active ? themeColor.text.primary : 'transparent',
                  },
                ]}
              >
                {active ? <AppIcon name="check" size={12} color="#000" strokeWidth={3} /> : null}
              </View>
            </SettingRow>
          );
        })}
      </SettingSection>

      {/* Sync is the one subtitle setting with no preview worth drawing: the
          effect is a line arriving a fraction of a second earlier or later,
          which a still image cannot show. What it CAN show is the direction in
          words, so the label says "0.50s earlier" rather than "−500" — no one
          has to work out which way the number points. */}
      <SettingSection title="Sync">
        <View style={styles.sliderSection}>
          <View style={styles.syncLabelRow}>
            {/* `sliderLabel`'s own bottom margin exists for the solo-label case;
                inside this row it would offset the text 4pt above the Reset chip,
                so it is cancelled here rather than removed there. */}
            <Text style={[styles.sliderLabel, styles.syncLabelText, { color: themeColor.text.muted }]}>
              {formatSubtitleDelay(subsDelayMs)}
            </Text>
            {subsDelayMs !== 0 ? (
              <Pressable
                onPress={() => setSetting('subs.delayMs', 0)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Reset subtitle sync"
                style={({ pressed }) => [
                  styles.resetBtn,
                  { backgroundColor: themeColor.bg.elevated },
                  pressed ? styles.resetPressed : null,
                ]}
              >
                <Text style={[styles.resetLabel, { color: themeColor.accent.base }]}>Reset</Text>
              </Pressable>
            ) : null}
          </View>
          <Slider
            value={subsDelayMs}
            onValueChange={(v) => setSetting('subs.delayMs', v)}
            minimumValue={SUBTITLE_DELAY_MIN}
            maximumValue={SUBTITLE_DELAY_MAX}
            step={SUBTITLE_DELAY_STEP}
            marks={SUBTITLE_DELAY_MARKS}
          />
          <Text style={[styles.syncHint, { color: themeColor.text.muted }]}>
            Slide left to bring subtitles earlier, right to push them later. Most tracks need
            nothing here — it is for a subtitle file authored against a different release.
            Adjustable while watching, from the player’s subtitle settings.
          </Text>
        </View>
      </SettingSection>

      {/* A standing answer to the question these rows create: why is there no
          "text colour" or "outline thickness"? Because both would be a second
          answer to the same question — legibility over arbitrary video — and
          the answer already has three levels with honest names. */}
      <Text style={[styles.footnote, { color: themeColor.text.muted }]}>
        Subtitles sit on whatever the video shows, so there is no single text colour that is
        always readable. The box, shadow and none options are the three answers, in order of how
        much of the picture they hide.
      </Text>
    </SettingsPage>
  );
}

/**
 * The one-frame fallback the preview's overlay answers with before its stage
 * measures itself — the same role the player's measured `barHeight` plays on
 * the real screen. It is NOT the 'Default' placement any more: the default is
 * a fraction (`SUBTITLE_DEFAULT_FRAC`) of the stage the overlay MEASURES, so a
 * custom cue at 0% sits at the bottom of this box and at 100% its top line is
 * at the top of it — the same relationship the player has, with no second
 * height to keep in sync.
 */
const PREVIEW_BAR = 48;
/** Height of the stage the cue lives in. Also the preview's own height. */
const PREVIEW_HEIGHT = 200;

function Radio({ active, onPress, label }: { active: boolean; onPress: () => void; label: string }) {
  const { color } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      hitSlop={8}
      style={styles.radioWrap}
    >
      <View
        style={[styles.radio, { borderColor: active ? color.accent.base : color.bg.elevated }]}
      >
        {active ? <View style={[styles.radioDot, { backgroundColor: color.accent.base }]} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  preview: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    borderRadius: radii.lg,
    overflow: 'hidden',
  },
  previewLabel: {
    fontSize: 11,
    fontFamily: font.semibold,
    letterSpacing: 0.8,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  previewStage: {
    // Tall enough for the highest position plus a two-line cue, so 100% is fully
    // visible here rather than clipped by the preview's own edge.
    height: PREVIEW_HEIGHT,
    justifyContent: 'flex-end',
  },
  value: {
    fontFamily: font.semibold,
    fontSize: 15,
  },
  radioWrap: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  colorSwatch: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footnote: {
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.lg,
  },
  sliderSection: {
    marginHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: 'rgba(128,128,128,0.2)',
  },
  sliderLabel: {
    fontSize: 13,
    fontFamily: font.semibold,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  sliderMarks: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    marginTop: spacing.xs,
  },
  sliderMark: {
    fontSize: 10,
  },
  /** Direction in words on the left, Reset on the right when there is one. */
  syncLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  /** A quiet chip rather than the accent: it undoes a correction, it is not a CTA. */
  resetBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.sm,
  },
  resetPressed: {
    opacity: 0.6,
  },
  resetLabel: {
    fontSize: 12,
    fontFamily: font.semibold,
  },
  syncLabelText: {
    marginBottom: 0,
    textAlign: 'left',
  },
  syncHint: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: spacing.xs,
  },
});