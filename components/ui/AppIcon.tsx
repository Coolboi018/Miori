// App icons — Lucide, same family as the website (@lucide/svelte).
//
// One wrapper so screens never import lucide directly: pass a semantic name,
// get the glyph. Adding an icon = one line here, never a new import elsewhere.
//
// These are SVGs, not text, which matters: the app's typeface (Montserrat)
// only covers 968 codepoints and has no ★, ✓, ✕ or ❚, so a text glyph for an
// icon renders as an empty box. Anything icon-shaped goes through here.
//
// Deep per-icon imports (`lucide-react-native/icons/<name>`) on purpose:
// importing from the package root pulls all ~1500 icons into the Metro
// bundle and roughly triples dev reload time. This keeps ~20 modules.

import type { LucideIcon } from 'lucide-react-native';
import House from 'lucide-react-native/icons/house';
import Search from 'lucide-react-native/icons/search';
import CalendarDays from 'lucide-react-native/icons/calendar-days';
import FlaskConical from 'lucide-react-native/icons/flask-conical';
import Bell from 'lucide-react-native/icons/bell';
import Settings from 'lucide-react-native/icons/settings';
import ChevronLeft from 'lucide-react-native/icons/chevron-left';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import User from 'lucide-react-native/icons/user';
import CircleUserRound from 'lucide-react-native/icons/circle-user-round';
import Database from 'lucide-react-native/icons/database';
import Info from 'lucide-react-native/icons/info';
import Play from 'lucide-react-native/icons/play';
import Pause from 'lucide-react-native/icons/pause';
import Star from 'lucide-react-native/icons/star';
import X from 'lucide-react-native/icons/x';
import Pencil from 'lucide-react-native/icons/pencil';
import Share2 from 'lucide-react-native/icons/share-2';
import Bookmark from 'lucide-react-native/icons/bookmark';
import BookmarkCheck from 'lucide-react-native/icons/bookmark-check';
import Tv from 'lucide-react-native/icons/tv';
import Globe from 'lucide-react-native/icons/globe';
import Heart from 'lucide-react-native/icons/heart';
import Users from 'lucide-react-native/icons/users';
import Clapperboard from 'lucide-react-native/icons/clapperboard';
import Sparkles from 'lucide-react-native/icons/sparkles';
import Compass from 'lucide-react-native/icons/compass';

// --- Explore -------------------------------------------------------------
// Every one of these is a DEEP import for the reason in the header: the
// package root is ~1850 icons and costs minutes of Metro time. This is the
// set the explore screen's filters, genre pills and category tiles need — a
// genre with a glyph next to it is scannable in a way a wall of words is not.
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import Check from 'lucide-react-native/icons/check';
import RotateCcw from 'lucide-react-native/icons/rotate-ccw';
import Grid2x2 from 'lucide-react-native/icons/grid-2x2';
import Rows3 from 'lucide-react-native/icons/rows-3';
import SlidersHorizontal from 'lucide-react-native/icons/sliders-horizontal';
import ArrowUpDown from 'lucide-react-native/icons/arrow-up-down';
import CalendarRange from 'lucide-react-native/icons/calendar-range';
import Gauge from 'lucide-react-native/icons/gauge';
import TrendingUp from 'lucide-react-native/icons/trending-up';
import Flame from 'lucide-react-native/icons/flame';
import Award from 'lucide-react-native/icons/award';
import HeartCrack from 'lucide-react-native/icons/heart-crack';
import Film from 'lucide-react-native/icons/film';
import Radio from 'lucide-react-native/icons/radio';
import Mic from 'lucide-react-native/icons/mic';
import ScrollText from 'lucide-react-native/icons/scroll-text';
import Rocket from 'lucide-react-native/icons/rocket';
import Swords from 'lucide-react-native/icons/swords';
import Mountain from 'lucide-react-native/icons/mountain';
import WandSparkles from 'lucide-react-native/icons/wand-sparkles';
import Drama from 'lucide-react-native/icons/drama';
import MessageSquare from 'lucide-react-native/icons/message-square';
import HeartHandshake from 'lucide-react-native/icons/heart-handshake';
import Ghost from 'lucide-react-native/icons/ghost';
import SearchCode from 'lucide-react-native/icons/search-code';
import UtensilsCrossed from 'lucide-react-native/icons/utensils-crossed';
import Bot from 'lucide-react-native/icons/bot';
import Dumbbell from 'lucide-react-native/icons/dumbbell';
import Brain from 'lucide-react-native/icons/brain';
import Skull from 'lucide-react-native/icons/skull';
import Sparkle from 'lucide-react-native/icons/sparkle';
import Hourglass from 'lucide-react-native/icons/hourglass';
import Ban from 'lucide-react-native/icons/ban';
import Crosshair from 'lucide-react-native/icons/crosshair';
import ChevronUp from 'lucide-react-native/icons/chevron-up';
import Captions from 'lucide-react-native/icons/captions';
import CaptionsOff from 'lucide-react-native/icons/captions-off';
import Layers from 'lucide-react-native/icons/layers';
import MonitorPlay from 'lucide-react-native/icons/monitor-play';
import SkipBack from 'lucide-react-native/icons/skip-back';
import SkipForward from 'lucide-react-native/icons/skip-forward';
import RotateCw from 'lucide-react-native/icons/rotate-cw';
// Landscape player transport + overlay chrome. All verified present in lucide
// 1.48's `dist/esm/icons/` — `alert-triangle` is NOT (renamed `triangle-alert`
// in this version), which is why that name does not appear below.
import Lock from 'lucide-react-native/icons/lock';
import LockOpen from 'lucide-react-native/icons/lock-open';
import PictureInPicture from 'lucide-react-native/icons/picture-in-picture-2';
import ListVideo from 'lucide-react-native/icons/list-video';
import Volume2 from 'lucide-react-native/icons/volume-2';
import VolumeX from 'lucide-react-native/icons/volume-x';
import Maximize2 from 'lucide-react-native/icons/maximize-2';
import TriangleAlert from 'lucide-react-native/icons/triangle-alert';
import LoaderCircle from 'lucide-react-native/icons/loader-circle';
import FastForward from 'lucide-react-native/icons/fast-forward';
import ExternalLink from 'lucide-react-native/icons/external-link';

const ICONS = {
  home: House,
  search: Search,
  schedule: CalendarDays,
  sources: FlaskConical,
  bell: Bell,
  settings: Settings,
  back: ChevronLeft,
  chevron: ChevronRight,
  user: User,
  account: CircleUserRound,
  database: Database,
  info: Info,
  play: Play,
  pause: Pause,
  star: Star,
  close: X,
  share: Share2,
  /** "This opens outside the app" — every link out to the browser. */
  external: ExternalLink,
  /** Filled/outline pair for the "save to list" toggle. */
  saved: BookmarkCheck,
  unsaved: Bookmark,
  tv: Tv,
  globe: Globe,
  heart: Heart,
  users: Users,
  clapper: Clapperboard,
  sparkles: Sparkles,
  compass: Compass,

  // --- Explore: filter chrome -------------------------------------------
  /** The caret inside every dropdown pill. */
  chevronDown: ChevronDown,
  /** Its partner, for disclosure controls that open upward. */
  chevronUp: ChevronUp,
  /** The selected tick inside the filter sheet. */
  check: Check,
  /** Marks a value in the list editor as one you can type over, not just tap. */
  edit: Pencil,
  /** "On hold" in the list editor — a bookmark reads as "set aside". */
  bookmark: Bookmark,
  /** "Reset", next to the filter pills. */
  reset: RotateCcw,
  /** Browse layout: 3-up tiles. */
  layoutThree: Grid2x2,
  /** Browse layout: rows. */
  layoutList: Rows3,
  /** The generic filter affordance (settings, section headers). */
  filters: SlidersHorizontal,
  /** Sort dropdown. */
  sort: ArrowUpDown,
  /** Year dropdown. */
  year: CalendarRange,
  /** Score-floor dropdown. */
  score: Gauge,
  // --- Player chrome -----------------------------------------------------
  /** Playback speed button. */
  speed: Gauge,
  /** Subtitle picker button. */
  subtitles: Captions,
  /** Subtitles-off state (icon exists in this lucide version; 'subtitles' does not). */
  subtitlesOff: CaptionsOff,
  /** Source switcher button. */
  layers: Layers,
  /** Quality picker button. */
  quality: MonitorPlay,
  /** Episode-back transport button in the player. */
  skipBack: SkipBack,
  /** Episode-forward transport button in the player. */
  skipForward: SkipForward,
  /**
   * ±10s seek buttons in the player. Two names for the SAME pair of glyphs
   * (`RotateCcw` is already imported for the explore filter's "reset") because
   * reaching into another section's semantic name for a transport control is how
   * a rename in one screen silently moves an icon out from under another.
   */
  rewind: RotateCcw,
  fastForward: RotateCw,

  // --- Landscape player chrome --------------------------------------------
  // Separate names from the pairs above where the SAME glyph serves two
  // meanings, for the same reason as `rewind`/`reset`: a rename in one screen
  // must not be able to move an icon out from under another.
  /** Lock-controls engaged: the video is tappable, the chrome is not. */
  lock: Lock,
  /** Lock-controls released. */
  unlock: LockOpen,
  /** Enter picture-in-picture. */
  pip: PictureInPicture,
  /** Slide-in episode panel. */
  episodes: ListVideo,
  /** Unmuted. */
  volumeOn: Volume2,
  /** Muted. */
  volumeOff: VolumeX,
  /** "Fit / Fill / Stretch" cycle. */
  expand: Maximize2,
  /** Playback failure state. */
  alert: TriangleAlert,
  /** Buffering + resolving spinner. */
  spinner: LoaderCircle,
  /**
   * The held-press speed boost glyph. Deliberately NOT `fastForward`: that one
   * is a paired transport control meaning "skip forward", and a speed boost that
   * borrows it reads as a seek. Boosting is a rate, so it gets a rate glyph.
   */
  boost: FastForward,

  // --- Explore: category glyphs ----------------------------------------
  trending: TrendingUp,
  hot: Flame,
  topRated: Award,
  favourites: HeartCrack,
  films: Film,
  airing: Radio,
  music: Mic,
  ona: ScrollText,
  sciFi: Rocket,
  hourglass: Hourglass,
  ban: Ban,
  crosshair: Crosshair,

  // --- Explore: genre glyphs --------------------------------------------
  genreAction: Swords,
  genreAdventure: Mountain,
  genreFantasy: WandSparkles,
  genreComedy: MessageSquare,
  genreDrama: Drama,
  genreRomance: HeartHandshake,
  genreSliceOfLife: UtensilsCrossed,
  genreSupernatural: Ghost,
  genreMystery: SearchCode,
  genreThriller: Crosshair,
  genreMecha: Bot,
  genreSports: Dumbbell,
  genrePsychological: Brain,
  genreHorror: Skull,
  genreMahouShoujo: Sparkle,
  genreEcchi: Heart,
} as const satisfies Record<string, LucideIcon>;

export type AppIconName = keyof typeof ICONS;

export function AppIcon({
  name,
  size = 22,
  color,
  strokeWidth = 2,
  fill,
}: {
  name: AppIconName;
  size?: number;
  color: string;
  strokeWidth?: number;
  /**
   * Fills the glyph, for the outline/solid pair an "on" state needs — lucide
   * ships only outlines, so a filled heart has to be asked for here.
   *
   * SPREAD CONDITIONALLY, and that is not a style preference. `lucide-react-native`
   * puts `fill: "none"` on both the `<Svg>` and each child path as a DEFAULT, and
   * any prop it is handed overrides that default — including one whose value is
   * `undefined`. Passing `fill={undefined}` therefore does not restore "none", it
   * erases the key, and react-native-svg falls back to `black`: every icon on
   * screen turns into a black blob. Omitting the prop entirely is the only
   * version of this that is safe.
   */
  fill?: string;
}) {
  const C = ICONS[name];
  return <C size={size} color={color} strokeWidth={strokeWidth} {...(fill ? { fill } : null)} />;
}
