// Gradient-filled text.
//
// React Native has no way to fill text with a gradient: `color` is a flat
// value, and `expo-linear-gradient` paints a rectangle, not glyphs. The
// portable trick is to draw the text as SVG and fill the shape with an SVG
// gradient, which is what this does.
//
// Why SVG and not `@react-native-masked-view/masked-view`? Masked View is
// unmaintained — 0.3.2, last published Nov 2024, no codegen config — so it is
// a legacy view manager on a new-architecture React Native (0.86), and it has
// no web implementation either. react-native-svg is Fabric-native and works
// on web, which matters because this app is previewed in a browser.
//
// The cost of SVG is that it has no text layout engine, so there is no
// `numberOfLines`. The lines therefore have to be worked out here, and that
// has to work on BOTH platforms:
//
//   native — `onTextLayout` on a hidden <Text> reports the real line breaks
//   web    — react-native-web does NOT implement `onTextLayout` at all
//            (no reference to it anywhere in its dist), so the previous
//            version of this file never measured and silently rendered a
//            flat single-colour title. Web measures with a canvas
//            `measureText` instead, against the same @font-face that
//            expo-font injected, then wraps greedily.
//
// The measure pass is hidden and inert, and until it reports we render plain
// text in the first gradient stop, so the title never blanks out.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  PixelRatio,
  Platform,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type TextLayoutEvent,
  // Strict TypeScript API (RN 0.88): element refs are instance types.
  type TextInstance,
} from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Text as SvgText } from 'react-native-svg';

export interface GradientTextProps {
  children: string;
  /** Left stop -> right stop. */
  colors: readonly [string, string];
  fontSize: number;
  lineHeight: number;
  /** A registered family name, e.g. `font.bold`. */
  fontFamily: string;
  maxLines?: number;
  /** Where the text can wrap. Also constrains the gradient's extent. */
  style?: object;
}

type Measured = { lines: string[]; truncated: boolean; width: number };

/**
 * Greedy word wrap against a measuring function. Only used on web, where the
 * platform gives us no line-break information.
 */
function greedyWrap(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
  maxLines: number
): Measured {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return { lines: [''], truncated: false, width: 0 };

  const all: string[] = [];
  let cur = words[0];
  for (let i = 1; i < words.length; i++) {
    const candidate = `${cur} ${words[i]}`;
    if (measure(candidate) <= maxWidth) cur = candidate;
    else {
      all.push(cur);
      cur = words[i];
    }
  }
  all.push(cur);

  const ell = '…';
  // Trim the tail until the line plus the ellipsis fits — the same thing
  // `numberOfLines` + `ellipsizeMode="tail"` does. Also covers the case of a
  // single word that is too wide on its own (no space to break at), which
  // would otherwise overflow the card instead of being cut.
  const trimToFit = (lines: string[]) => {
    const i = lines.length - 1;
    let t = lines[i];
    while (measure(t + ell) > maxWidth && t.length > 1) t = t.slice(0, -1);
    lines[i] = `${t.trimEnd()}${ell}`;
    return lines;
  };

  if (all.length <= maxLines) {
    const last = all[all.length - 1];
    if (measure(last) <= maxWidth) {
      return { lines: all, truncated: false, width: measure(last) };
    }
    const lines = trimToFit(all);
    return { lines, truncated: true, width: measure(lines[lines.length - 1]) };
  }

  const lines = trimToFit(all.slice(0, maxLines));
  return { lines, truncated: true, width: measure(lines[lines.length - 1]) };
}

/**
 * Web only. Returns a function measuring the width the browser actually
 * renders for a prefix of the host element's text.
 *
 * Greedy wrapping only ever asks about strings that are prefixes of the full
 * string, so prefix widths are all that is needed — and a Range gives those
 * from the real, already-laid-out text rather than re-deriving them from font
 * metrics that may not have loaded yet.
 */
function prefixMeasurer(host: HTMLElement): ((s: string) => number) | null {
  const walker = document.createTreeWalker(host, 4 /* NodeFilter.SHOW_TEXT */);
  const node = walker.nextNode() as globalThis.Text | null;
  if (!node) return null;
  const data = node.data;
  // The hidden text always ends with the ellipsis, so a Range over its last
  // character gives the true glyph width. Without this, asking for
  // `line + "…"` would clamp onto the *next character of the title* instead
  // and silently report that character's advance as the ellipsis's.
  const tail = document.createRange();
  tail.setStart(node, Math.max(0, data.length - 1));
  tail.setEnd(node, data.length);
  const ellipsisWidth = data.endsWith('…') ? tail.getBoundingClientRect().width : 0;

  const prefix = (n: number) => {
    if (n <= 0) return 0;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min(n, data.length));
    return range.getBoundingClientRect().width;
  };

  return (s: string) =>
    s.endsWith('…') ? prefix(s.length - 1) + ellipsisWidth : prefix(s.length);
}

export function GradientText({
  children,
  colors,
  fontSize,
  lineHeight,
  fontFamily,
  maxLines = 2,
  style,
}: GradientTextProps) {
  // Gradient ids must be unique per instance, or two titles cross-reference
  // each other's <Defs> and one wins.
  const rawId = useId();
  const gradientId = `gt${rawId.replace(/[^a-zA-Z0-9]/g, '')}`;

  const [measured, setMeasured] = useState<Measured | null>(null);
  const [width, setWidth] = useState(0);
  const measureRef = useRef<TextInstance>(null);

  const apply = (next: Measured) => {
    setMeasured((prev) =>
      prev &&
      prev.truncated === next.truncated &&
      prev.width === next.width &&
      prev.lines.length === next.lines.length &&
      prev.lines.every((l, i) => l === next.lines[i])
        ? prev
        : next
    );
  };

  // --- native: the platform reports the real line breaks -----------------
  const onNativeLayout = (e: TextLayoutEvent) => {
    if (Platform.OS === 'web') return;
    const all = e.nativeEvent.lines;
    if (!all?.length) return;
    const clipped = all.slice(0, maxLines);
    const truncated = all.length > maxLines;
    apply({
      lines: clipped.map((l, i) =>
        truncated && i === clipped.length - 1 ? `${l.text.trimEnd()}…` : l.text
      ),
      truncated,
      // Widest drawn line. On a single-line title this is the title's own
      // width, so the gradient spans the text rather than the empty column.
      width: Math.round(clipped[clipped.length - 1]?.width ?? 0),
    });
  };

  // --- web: measure the browser's own layout of the real text -----------
  //
  // Deliberately NOT canvas `measureText`. expo-font's loadAsync resolves once
  // it has appended the @font-face rule, NOT once the browser has finished
  // downloading the font file, so a canvas measurement taken at that moment
  // is really measuring the fallback font. `apply()` keeps an unchanged
  // result, so that wrong measurement sticks and titles truncate early at
  // whatever width the fallback happened to be.
  //
  // A Range over the hidden <Text>'s own text node reports the width the
  // browser actually laid out, so measurement and rendering cannot disagree.
  // It also re-runs on `document.fonts.ready`, which is when the real
  // metrics arrive.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (!width) return;

    // Re-derive the measurer on every run instead of capturing one: React
    // may have swapped the text node between the first measure and the
    // re-measure that follows the webfont swap.
    const recompute = () => {
      const host = measureRef.current as unknown as HTMLElement | null;
      const measure = host ? prefixMeasurer(host) : null;
      if (!measure) return;
      apply(greedyWrap(children, width, measure, maxLines));
    };

    recompute();

    let cancelled = false;
    const once = () => {
      if (!cancelled) recompute();
    };
    // The hidden text is what triggers the webfont download, and
    // FontDisplay.AUTO means it renders in the fallback until the swap.
    // Re-measure after the swap so the cut point uses the real metrics.
    const fonts = (document as Document & {
      fonts?: { ready?: Promise<unknown>; load?: (f: string) => Promise<unknown> };
    }).fonts;
    try {
      fonts?.load?.(`${fontSize}px "${fontFamily}"`)?.then(once, once);
    } catch {
      /* no Font Loading API: fonts.ready below is the fallback */
    }
    fonts?.ready?.then(once, once);
    return () => {
      cancelled = true;
    };
  }, [children, width, fontSize, fontFamily, maxLines]);

  const onWidth = (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    setWidth((prev) => (prev === w ? prev : w));
  };

  // The measuring <Text> keeps RN's default allowFontScaling, so it honours
  // the OS font-size setting. SVG text does NOT scale, so the drawing has to
  // be scaled by the same factor or the two disagree: on a device with a
  // large accessibility font size the title would be measured at, say, 28px
  // but drawn at 23px, and truncate far earlier than it needs to. Scaling the
  // drawing keeps measure == draw on every device while still respecting the
  // user's setting. Web reports a font scale of 1, so this is a no-op there.
  const fontScale = PixelRatio.getFontScale();
  const drawFontSize = fontSize * fontScale;
  const drawLineHeight = lineHeight * fontScale;

  const height = measured ? measured.lines.length * drawLineHeight : maxLines * drawLineHeight;

  // The gradient spans the text that was actually drawn, not the whole
  // column. With a full-width gradient a short title would only ever show the
  // first few percent of the fade and never reach white.
  const gradientWidth = Math.max(measured?.width ?? 0, 1);

  // userSpaceOnUse, not the SVG default objectBoundingBox: the gradient must
  // span the whole title block once, so the second line continues the fade
  // instead of restarting from the accent colour.
  const defs = useMemo(
    () => (
      <Defs>
        <LinearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1={0}
          y1={0}
          x2={gradientWidth}
          y2={0}
        >
          <Stop offset="0" stopColor={colors[0]} />
          <Stop offset="1" stopColor={colors[1]} />
        </LinearGradient>
      </Defs>
    ),
    [gradientId, gradientWidth, colors]
  );

  return (
    <View style={style} onLayout={onWidth}>
      {/* Measurement pass only: identical family/size to the drawn text, so
          its metrics are the ones the SVG reproduces.

          On web this element must NOT be width-constrained. A Range over a
          selection that has wrapped onto a second line returns the union
          bounding box of both lines, not the width of the text — so every
          prefix long enough to wrap measured far too wide and truncated
          early, while short titles (which never wrapped) measured exactly
          and reached the right edge. `nowrap` keeps it one line so prefix
          widths are true single-line widths.

          Native keeps left/right 0, because `onTextLayout` there needs the
          real container width in order to report the real line breaks.

          The trailing ellipsis is web-only and never drawn: prefix
          measurement needs `line + "…"`, and the hidden text is the only
          element a Range can measure. */}
      <Text
        ref={measureRef}
        style={[
          Platform.OS === 'web' ? styles.hiddenWeb : styles.hiddenNative,
          { fontFamily, fontSize, lineHeight },
        ]}
        onTextLayout={onNativeLayout}
        numberOfLines={maxLines}
        ellipsizeMode="tail"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {Platform.OS === 'web' ? `${children}…` : children}
      </Text>

      {measured && width > 0 ? (
        <Svg width={width} height={height}>
          {defs}
          {measured.lines.map((line, i) => (
            <SvgText
              key={i}
              x={0}
              // SVG's y is the baseline, not the box top.
              y={drawLineHeight * i + drawFontSize * 0.82}
              fill={`url(#${gradientId})`}
              fontFamily={fontFamily}
              fontSize={drawFontSize}
            >
              {line}
            </SvgText>
          ))}
        </Svg>
      ) : (
        // Pre-measure frame: flat text in the first stop, never invisible.
        <Text style={{ fontFamily, fontSize, lineHeight, color: colors[0] }} numberOfLines={maxLines}>
          {children}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  /** Web: shrink-to-fit and never wrap, so Range widths stay single-line. */
  hiddenWeb: {
    position: 'absolute',
    left: 0,
    top: 0,
    opacity: 0,
    // Not part of RN's style types, but react-native-web honours it and it
    // is the whole point: a wrapped selection measures wrong.
    whiteSpace: 'nowrap',
  } as object,
  /** Native: full container width, so onTextLayout wraps like a real Text. */
  hiddenNative: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    opacity: 0,
  },
});
