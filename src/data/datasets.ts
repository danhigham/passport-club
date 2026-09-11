import type {
  Admin1Feature,
  Admin1IndexEntry,
  City,
  Continent,
  CountryFeature,
} from '../types';

/**
 * Everything the game knows about the world.
 *
 * The three "core" files (countries, continents, cities) total under 500kb and
 * are fetched once on first load. The state/province polygons are far bigger
 * (20mb across 171 countries) so they're fetched one country at a time, only
 * when a player actually picks that country, and cached for the session.
 */

const BASE = import.meta.env.BASE_URL + 'data/';

export interface CoreData {
  countries: CountryFeature[];
  countryById: Map<string, CountryFeature>;
  continents: Continent[];
  continentById: Map<string, Continent>;
  cities: City[];
  admin1Index: Admin1IndexEntry[];
  admin1ByCountry: Map<string, Admin1IndexEntry>;
}

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
  return res.json() as Promise<T>;
}

let corePromise: Promise<CoreData> | null = null;

/** Load (once) the datasets every mode needs. */
export function loadCore(): Promise<CoreData> {
  if (corePromise) return corePromise;
  corePromise = (async () => {
    const [countryFC, continents, cities, admin1Index] = await Promise.all([
      getJSON<{ features: CountryFeature[] }>('countries.json'),
      getJSON<Continent[]>('continents.json'),
      getJSON<City[]>('cities.json'),
      getJSON<Admin1IndexEntry[]>('admin1/index.json'),
    ]);

    const countries = countryFC.features;
    return {
      countries,
      countryById: new Map(countries.map((c) => [c.properties.id, c])),
      continents,
      continentById: new Map(continents.map((c) => [c.id, c])),
      cities,
      admin1Index,
      admin1ByCountry: new Map(admin1Index.map((e) => [e.country, e])),
    };
  })().catch((err) => {
    corePromise = null; // let a retry work
    throw err;
  });
  return corePromise;
}

const admin1Cache = new Map<string, Promise<Admin1Feature[]>>();

/** Load one country's states / provinces / counties. */
export function loadAdmin1(countryId: string): Promise<Admin1Feature[]> {
  let p = admin1Cache.get(countryId);
  if (!p) {
    p = getJSON<{ features: Admin1Feature[] }>(`admin1/${countryId}.json`)
      .then((fc) => fc.features)
      .catch((err) => {
        admin1Cache.delete(countryId);
        throw err;
      });
    admin1Cache.set(countryId, p);
  }
  return p;
}

/** Warm the cache in the background; failures are irrelevant here. */
export function prefetchAdmin1(countryId: string): void {
  void loadAdmin1(countryId).catch(() => {});
}
