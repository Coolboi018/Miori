/**
 * Learn more about Light and Dark modes:
 * https://docs.expo.io/guides/color-schemes/
 */
import {
  Text as DefaultText,
  View as DefaultView,
  // Strict TypeScript API (RN 0.88): host components no longer carry a
  // `.props` static — the props come from the exported prop types now.
  type TextProps as RNTextProps,
  type ViewProps as RNViewProps,
} from 'react-native';

import { useColorScheme } from './useColorScheme';

import Colors from '@/constants/Colors';
import { font } from '@/lib/ui/tokens';

type ThemeProps = {
  lightColor?: string;
  darkColor?: string;
};

export type TextProps = ThemeProps & RNTextProps;
export type ViewProps = ThemeProps & RNViewProps;

export function useThemeColor(
  props: { light?: string; dark?: string },
  colorName: keyof typeof Colors.light & keyof typeof Colors.dark
) {
  const theme = useColorScheme();
  const colorFromProps = props[theme];

  if (colorFromProps) {
    return colorFromProps;
  } else {
    return Colors[theme][colorName];
  }
}

export function Text(props: TextProps) {
  const { style, lightColor, darkColor, ...otherProps } = props;
  const color = useThemeColor({ light: lightColor, dark: darkColor }, 'text');

  // Montserrat is the app's typeface, but `fontFamily` does not inherit in
  // React Native, so every text node has to name a family. This is the
  // fallback for callers that don't set one — it comes first in the array, so
  // an explicit `fontFamily` in `style` still wins.
  return <DefaultText style={[{ fontFamily: font.regular, color }, style]} {...otherProps} />;
}

export function View(props: ViewProps) {
  const { style, lightColor, darkColor, ...otherProps } = props;
  const backgroundColor = useThemeColor({ light: lightColor, dark: darkColor }, 'background');

  return <DefaultView style={[{ backgroundColor }, style]} {...otherProps} />;
}
