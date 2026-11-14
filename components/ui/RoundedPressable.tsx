// A Pressable whose press highlight is ROUNDED BY CONSTRUCTION.
//
// THE PROBLEM THIS SOLVES. `android_ripple` draws inside the view's rectangle
// and only follows the corner radius when the platform decides to clip its
// outline. This app has been adding `overflow: 'hidden'` to rounded buttons to
// get that clip, and it works in some places and not others — the navbar's
// plates, the pill rows and the search field's clear button were all reported
// as square highlights on a rounded control. Betting on a clipping rule that
// holds in one component and not the next is not a design, it is a lottery.
//
// So this does not rely on the platform at all: while the finger is down it
// paints ONE absolutely-positioned view with the same radius as the button,
// above the content. It is a rounded wash on every platform, including iOS,
// where a ripple does not exist and these controls used to have no press
// feedback at all.
//
// WHY THE WASH SITS ON TOP rather than behind the content: an avatar's image
// fills its plate, so a highlight painted underneath would be invisible on
// exactly the button that needs one most.
//
// The trade against a ripple is deliberate. A ripple is a moving circle that
// grows from the finger and can outrun a small control; a wash is the whole
// control acknowledging the touch at once, which on 40px chrome reads as
// crisper. Nothing here animates, so a press costs one extra View and no JS
// thread work beyond the re-render Pressable already does.

import type { ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

interface Props extends Omit<PressableProps, 'style' | 'children'> {
  children: ReactNode;
  /** Corner radius of the wash. Keep it equal to the container's own radius. */
  radius?: number;
  /**
   * Wash colour. The default is a neutral grey that reads as "pressed" on both
   * themes: it lightens a dark plate and darkens a white one.
   */
  tint?: string;
  style?: StyleProp<ViewStyle>;
}

const DEFAULT_TINT = 'rgba(140,140,140,0.26)';

export function RoundedPressable({
  children,
  style,
  radius = 9999,
  tint = DEFAULT_TINT,
  disabled,
  ...rest
}: Props) {
  return (
    <Pressable {...rest} disabled={disabled} style={style}>
      {({ pressed }) => (
        <>
          {children}
          {pressed && !disabled ? (
            <View
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, { borderRadius: radius, backgroundColor: tint }]}
            />
          ) : null}
        </>
      )}
    </Pressable>
  );
}
