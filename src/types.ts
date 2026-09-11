import type { Feature, MultiPolygon, Polygon } from 'geojson';

/** How hard the questions are, independent of *what* we're asking about. */
export type Tier = 1 | 2 | 3;

/** The four things a player can be asked to find. */
export type Mode = 'continent' | 'country' | 'admin1' | 'city';

export type PlaceKind = Mode;

/* ------------------------------------------------------------- geo records */

export interface CountryProps {
  id: string;
  kind: 'country';
  name: string;
  continent: string;
  region: string;
  iso2: string | null;
  pop: number;
  tier: Tier;
  /**
   * Whether this is a place to ask about, as opposed to merely draw. Natural
   * Earth's 50m set includes dependencies and territories that belong on the
   * map but not in a quiz.
   */
  askable: boolean;
  /** A point guaranteed to lie inside the polygon (see scripts/build-data.mjs). */
  point: [number, number];
}

export interface Admin1Props {
  id: string;
  kind: 'admin1';
  name: string;
  country: string;
  countryName: string;
  continent: string | null;
  type: string;
  region: string | null;
  /** A point guaranteed to lie inside the polygon. */
  point: [number, number];
  tier: Tier;
}

export type CountryFeature = Feature<Polygon | MultiPolygon, CountryProps>;
export type Admin1Feature = Feature<Polygon | MultiPolygon, Admin1Props>;
export type AreaFeature = CountryFeature | Admin1Feature;

export interface City {
  id: string;
  kind: 'city';
  name: string;
  country: string;
  countryName: string;
  continent: string | null;
  adm1: string | null;
  capital: boolean;
  pop: number;
  tier: Tier;
  lon: number;
  lat: number;
}

export interface Continent {
  id: string;
  kind: 'continent';
  name: string;
  emoji: string;
  order: number;
  countries: number;
  pop: number;
  tier: Tier;
  /** Hand-set opening viewpoint; see scripts/build-data.mjs for why. */
  view: { center: [number, number]; radius: number };
}

export interface Admin1IndexEntry {
  country: string;
  countryName: string;
  continent: string | null;
  count: number;
  /** "States", "Counties", "Prefectures" — whatever this country calls them. */
  term: string;
  termSingular: string;
  bytes: number;
}

/* ----------------------------------------------------------- game settings */

/** Which slice of the world we play on. */
export type Scope =
  | { type: 'world' }
  | { type: 'continent'; id: string }
  | { type: 'country'; id: string };

export type Level = 'explorer' | 'traveller' | 'globetrotter';

export interface GameConfig {
  mode: Mode;
  scope: Scope;
  level: Level;
  /** Draw the dividing lines between countries / states. */
  showBorders: boolean;
  /** Print the names of places that aren't the answer (a big training-wheel). */
  showLabels: boolean;
  /** In city mode, mark every candidate city with a dot. */
  showCityDots: boolean;
  /** Highlight the country a target state/city sits inside. */
  narrowToParent: boolean;
  rounds: number;
  /** Per-round countdown in seconds, or null for "take your time". */
  timeLimit: number | null;
}

/* -------------------------------------------------------------- game state */

/** One question: a place to find, plus everything needed to judge a click. */
export interface Target {
  id: string;
  kind: PlaceKind;
  name: string;
  /** "State in the United States", "City in Japan" — shown under the prompt. */
  subtitle: string;
  /** Where it actually is, for hints, reveals and distance feedback. */
  point: [number, number];
  /** Area targets only: the polygon a click must land in. */
  feature?: AreaFeature;
  /** Continent targets: every country id that counts as a hit. */
  memberIds?: string[];
  /** Parent country id, used by the "narrow to parent" assist. */
  parentId?: string;
}

export type GuessVerdict = 'correct' | 'wrong' | 'revealed';

export interface Guess {
  verdict: GuessVerdict;
  /** What the player actually hit, if anything ("You tapped Spain"). */
  hitName: string | null;
  /** Great-circle km from the click to the target. */
  distanceKm: number;
  at: [number, number];
}

export interface RoundResult {
  target: Target;
  guesses: Guess[];
  points: number;
  solved: boolean;
  elapsedMs: number;
}

export type Phase = 'setup' | 'loading' | 'playing' | 'results';

/** Where the globe should be pointing when a round opens. */
export interface HomeView {
  center: [number, number];
  radiusDeg: number;
}
