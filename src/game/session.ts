import type { GeoPermissibleObjects } from 'd3-geo';
import { centroidOf } from '../map/geo';
import type { CoreData } from '../data/datasets';
import type {
  Admin1Feature,
  AreaFeature,
  City,
  CountryFeature,
  GameConfig,
  HomeView,
  Level,
  Target,
  Tier,
} from '../types';

/** Which difficulty tiers each level draws its questions from. */
export const LEVEL_TIERS: Record<Level, Tier[]> = {
  explorer: [1],
  traveller: [1, 2],
  globetrotter: [1, 2, 3],
};

export const LEVEL_INFO: Record<Level, { name: string; blurb: string; emoji: string }> = {
  explorer: {
    name: 'Explorer',
    blurb: 'The big, famous ones only. A gentle start.',
    emoji: '\u{1F9ED}',
  },
  traveller: {
    name: 'Traveller',
    blurb: 'Famous places plus a few you might have to think about.',
    emoji: '\u{1F9F3}',
  },
  globetrotter: {
    name: 'Globetrotter',
    blurb: 'Everything, including the tiny and the tricky.',
    emoji: '\u{1F30D}',
  },
};

export const MODE_INFO: Record<
  GameConfig['mode'],
  { name: string; blurb: string; emoji: string }
> = {
  continent: {
    name: 'Continents',
    blurb: 'Seven big pieces of the world. The best place to begin.',
    emoji: '\u{1F30E}',
  },
  country: {
    name: 'Countries',
    blurb: 'Find a whole country on the map.',
    emoji: '\u{1F6A9}',
  },
  admin1: {
    name: 'States & Counties',
    blurb: 'Zoom inside one country and find its regions.',
    emoji: '\u{1F5FA}\uFE0F',
  },
  city: {
    name: 'Cities',
    blurb: 'Pinpoint a single city. The toughest challenge.',
    emoji: '\u{1F3D9}\uFE0F',
  },
};

/* ------------------------------------------------------------------ utils */

const ALL_TIERS: Tier[] = [1, 2, 3];

/** A round this short stops feeling like a game, so we widen rather than serve it. */
const MIN_COMFORTABLE_POOL = 8;

/**
 * The tiers we'll actually draw from.
 *
 * A level is a preference, not a promise. "Explorer" cities in Oceania is only
 * three places, which would hand the player a three-question round with no
 * explanation. When the chosen level is too thin for the scope, quietly widen
 * to the next tier rather than serving a stub.
 */
function effectiveTiers<T extends { tier: Tier }>(
  pool: T[],
  level: Level,
  rounds: number,
): Tier[] {
  const want = Math.min(rounds, MIN_COMFORTABLE_POOL);
  let allowed = LEVEL_TIERS[level];
  const size = (ts: Tier[]) => pool.reduce((n, p) => n + (ts.includes(p.tier) ? 1 : 0), 0);
  while (size(allowed) < want && allowed.length < ALL_TIERS.length) {
    allowed = ALL_TIERS.slice(0, allowed.length + 1);
  }
  return allowed;
}

/** Choose the questions for a round from a fully-built candidate pool. */
function selectTargets<T extends Target & { tier: Tier }>(
  pool: T[],
  config: GameConfig,
): Target[] {
  const tiers = effectiveTiers(pool, config.level, config.rounds);
  const eligible = pool.filter((p) => tiers.includes(p.tier));
  return pickSpread(eligible, Math.min(config.rounds, eligible.length), tiers);
}

function shuffle<T>(items: T[]): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Pick `n` questions, spreading them across the allowed tiers so a Globetrotter
 * round isn't 20 obscure micro-states in a row. Easier items come first within
 * the picked set, which makes a session feel like it warms up.
 */
function pickSpread<T extends { tier: Tier }>(pool: T[], n: number, tiers: Tier[]): T[] {
  const buckets = new Map<Tier, T[]>();
  for (const tier of tiers) buckets.set(tier, []);
  for (const item of pool) buckets.get(item.tier)?.push(item);

  const picked: T[] = [];
  const order = tiers.slice().sort();
  const shuffled = new Map(order.map((t) => [t, shuffle(buckets.get(t) ?? [])]));

  // Round-robin across tiers until we have enough or everything is exhausted.
  let guard = 0;
  while (picked.length < n && guard++ < n * tiers.length + tiers.length) {
    let tookAny = false;
    for (const t of order) {
      if (picked.length >= n) break;
      const bucket = shuffled.get(t)!;
      if (bucket.length) {
        picked.push(bucket.pop()!);
        tookAny = true;
      }
    }
    if (!tookAny) break;
  }

  return shuffle(picked).sort((a, b) => a.tier - b.tier);
}

/* ------------------------------------------------------------ scope tools */

export function countriesInScope(core: CoreData, config: GameConfig): CountryFeature[] {
  const { scope } = config;
  if (scope.type === 'continent') {
    return core.countries.filter((c) => c.properties.continent === scope.id);
  }
  if (scope.type === 'country') {
    const c = core.countryById.get(scope.id);
    return c ? [c] : [];
  }
  return core.countries;
}

/** The geometry the map should frame when the round starts. */
export function focusFor(
  core: CoreData,
  config: GameConfig,
): GeoPermissibleObjects | null {
  const { scope } = config;
  // A continent is framed from its curated viewpoint, not its geometry.
  if (scope.type !== 'country') return null;
  const features = countriesInScope(core, config);
  if (!features.length) return null;
  return { type: 'FeatureCollection', features } as unknown as GeoPermissibleObjects;
}

/** The explicit viewpoint a round opens on, if it has one. */
export function homeFor(core: CoreData, config: GameConfig): HomeView | null {
  if (config.scope.type !== 'continent') return null;
  const continent = core.continentById.get(config.scope.id);
  if (!continent?.view) return null;
  return { center: continent.view.center, radiusDeg: continent.view.radius };
}

/* ------------------------------------------------------------- the pieces */

export interface Session {
  config: GameConfig;
  targets: Target[];
  /** Country polygons drawn as the base map. */
  countries: CountryFeature[];
  /** Sub-national polygons drawn on top (admin1 mode only). */
  areas: Admin1Feature[];
  /** Cities eligible to be clicked / drawn as dots (city mode only). */
  cities: City[];
  /** Everything a click can land on, in hit-test priority order. */
  hitAreas: AreaFeature[];
  /** Geometry to frame when no explicit home view is given. */
  focus: GeoPermissibleObjects | null;
  /** Explicit opening viewpoint, used for continents. Null = whole globe. */
  home: HomeView | null;
}

function continentTargets(core: CoreData, config: GameConfig): Target[] {
  const byContinent = new Map<string, CountryFeature[]>();
  for (const c of core.countries) {
    const key = c.properties.continent;
    if (!byContinent.has(key)) byContinent.set(key, []);
    byContinent.get(key)!.push(c);
  }

  const pool = core.continents
    .filter((c) => byContinent.has(c.id))
    .map<Target & { tier: Tier }>((c) => {
      const members = byContinent.get(c.id)!;
      return {
        id: c.id,
        kind: 'continent',
        tier: 1,
        name: c.name,
        subtitle:
          c.countries > 1 ? `Continent \u00b7 ${c.countries} countries` : 'Continent',
        point: centroidOf({
          type: 'FeatureCollection',
          features: members,
        } as unknown as GeoPermissibleObjects),
        memberIds: members.map((m) => m.properties.id),
      };
    });

  return pickSpread(pool, Math.min(config.rounds, pool.length), [1]);
}

function countryTargets(core: CoreData, config: GameConfig): Target[] {
  const pool = countriesInScope(core, config)
    // Antarctica is a continent, not a country anyone should be asked to find.
    .filter((c) => c.properties.continent !== 'Antarctica')
    // Dependencies and territories are drawn, but never asked about.
    .filter((c) => c.properties.askable)
    .map<Target & { tier: Tier }>((c) => ({
      id: c.properties.id,
      kind: 'country',
      tier: c.properties.tier,
      name: c.properties.name,
      subtitle: `Country in ${c.properties.continent}`,
      point: c.properties.point,
      feature: c,
    }));

  return selectTargets(pool, config);
}

function admin1Targets(
  core: CoreData,
  config: GameConfig,
  admin1: Admin1Feature[],
): Target[] {
  const entry =
    config.scope.type === 'country' ? core.admin1ByCountry.get(config.scope.id) : undefined;
  const singular = entry?.termSingular ?? 'Region';

  const pool = admin1.map<Target & { tier: Tier }>((f) => {
      const p = f.properties;
      // NE sometimes bakes the type into the name ("Gunma Prefecture").
      const type = p.type && !p.name.includes(p.type) ? p.type : singular;
      return {
        id: p.id,
        kind: 'admin1',
        tier: p.tier,
        name: p.name,
        subtitle: `${type} in ${p.countryName}`,
        point: p.point,
        feature: f,
        parentId: p.country,
      };
  });

  return selectTargets(pool, config);
}

function cityTargets(config: GameConfig, cities: City[]): Target[] {
  const pool = cities
    .map<Target & { tier: Tier }>((c) => ({
      id: c.id,
      kind: 'city',
      tier: c.tier,
      name: c.name,
      subtitle: c.capital ? `Capital city of ${c.countryName}` : `City in ${c.countryName}`,
      point: [c.lon, c.lat] as [number, number],
      parentId: c.country,
    }));

  return selectTargets(pool, config);
}

export function citiesInScope(core: CoreData, config: GameConfig): City[] {
  const { scope } = config;
  if (scope.type === 'continent') return core.cities.filter((c) => c.continent === scope.id);
  if (scope.type === 'country') return core.cities.filter((c) => c.country === scope.id);
  return core.cities;
}

/** Assemble everything a playable round needs. */
export function buildSession(
  core: CoreData,
  config: GameConfig,
  admin1: Admin1Feature[] = [],
): Session {
  const cities = citiesInScope(core, config);
  const focus = focusFor(core, config);

  let targets: Target[];
  switch (config.mode) {
    case 'continent':
      targets = continentTargets(core, config);
      break;
    case 'country':
      targets = countryTargets(core, config);
      break;
    case 'admin1':
      targets = admin1Targets(core, config, admin1);
      break;
    case 'city':
      targets = cityTargets(config, cities);
      break;
  }

  return {
    config,
    targets,
    countries: core.countries,
    areas: config.mode === 'admin1' ? admin1 : [],
    cities,
    // In admin1 mode a click should resolve to a state before a country.
    hitAreas: config.mode === 'admin1' ? admin1 : core.countries,
    focus,
    home: homeFor(core, config),
  };
}

/**
 * How many questions can this configuration actually produce? Used to stop the
 * setup screen offering a 20-question round of a 7-item pool.
 */
export function poolSize(
  core: CoreData,
  config: GameConfig,
  admin1Count?: number,
): number {
  const count = (pool: { tier: Tier }[]) =>
    pool.filter((p) => effectiveTiers(pool, config.level, config.rounds).includes(p.tier))
      .length;

  switch (config.mode) {
    case 'continent':
      return core.continents.length;
    case 'country':
      return count(
        countriesInScope(core, config)
          .filter((c) => c.properties.continent !== 'Antarctica' && c.properties.askable)
          .map((c) => ({ tier: c.properties.tier })),
      );
    case 'admin1':
      // The divisions aren't loaded until the round starts, so the setup screen
      // can only report the country's total.
      return admin1Count ?? 0;
    case 'city':
      return count(citiesInScope(core, config));
  }
}
