// Styles for the fullscreen player screen.
//
// Split out of `PlayerScreen.tsx` (24 Nov) so the screen's render body and the
// decisions around it are readable without a hundred lines of layout between
// them. The overlay components that share these styles (`PlayerOverlays.tsx`)
// import this same object rather than keeping a second copy: one `skipButton`
// and one `unlockBtn` is what stops the floating button and the lock screen
// from drifting apart on the next tweak.

import { StyleSheet } from 'react-native';

import { font, radii } from '@/lib/ui/tokens';

export const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
  },
  scrim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  unlockBox: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  playPressed: {
    opacity: 0.6,
  },
  unlockBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  skipButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radii.full,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  skipPressed: {
    opacity: 0.65,
  },
  /**
   * The floating skip button's seat. `right`/`bottom` are set inline
   * (`insets.right + 12`, `barHeight + ABOVE_BAR_GAP`) because both are measured — the
   * same rule the toast obeys: the offset names the real bar, not a guess of
   * it, so the button sits just above the bar in every state and does not
   * move when the chrome hides.
   */
  skipFloat: {
    position: 'absolute',
    alignItems: 'flex-end',
  },
  skipForward: {
    // The +85s variant carries one digit-group more than "Skip opening"; a
    // touch more horizontal padding keeps the pill's proportions calm.
    paddingHorizontal: 14,
  },
  skipLabel: {
    color: '#fff',
    fontFamily: font.semibold,
    fontSize: 13,
    lineHeight: 16,
  },
  customSpeedCard: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: [{ translateX: -120 }, { translateY: -90 }],
    width: 240,
    padding: 18,
    borderRadius: 16,
    backgroundColor: 'rgba(20, 20, 27, 0.97)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.12)',
    elevation: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 22,
  },
  customSpeedTitle: {
    color: '#fff',
    fontFamily: font.semibold,
    fontSize: 16,
    marginBottom: 4,
  },
  customSpeedHint: {
    color: 'rgba(255,255,255,0.5)',
    fontFamily: font.regular,
    fontSize: 12,
    marginBottom: 12,
  },
  customSpeedInput: {
    height: 44,
    borderRadius: 10,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(255,255,255,0.08)',
    color: '#fff',
    fontFamily: font.semibold,
    fontSize: 18,
    marginBottom: 14,
  },
  customSpeedActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  customSpeedBtn: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  customSpeedBtnPrimary: {
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  customSpeedBtnText: {
    color: 'rgba(255,255,255,0.85)',
    fontFamily: font.medium,
    fontSize: 13,
  },
  customSpeedBtnTextPrimary: {
    color: '#fff',
    fontFamily: font.semibold,
    fontSize: 13,
  },
});
