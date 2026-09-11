import { feature as topoFeature } from 'topojson-client';
import type {
  FeatureCollection,
  GeoJsonProperties,
  MultiPolygon,
  Polygon,
} from 'geojson';
import type { GeometryCollection, Topology } from 'topojson-specification';
import type {
  Admin1Feature,
  Admin1IndexEntry,
  Admin1Props,
  City,
  Continent,
  CountryFeature,
  CountryProps,
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

/**
 * Polygons ship as TopoJSON and are decoded here.
 *
 * It is worth the decode step: shared borders are stored once instead of twice
 * and coordinates are quantised integers, which is what makes 50m-resolution
 * outlines affordable. The whole world costs about 260kb over the wire, less
 * than the plain 110m GeoJSON it replaced, at roughly eighteen times the detail.
 */
function decode<P extends GeoJsonProperties>(topo: Topology, layer: string) {
  const object = topo.objects[layer] as GeometryCollection<P>;
  if (!object) throw new Error(`TopoJSON is missing its "${layer}" layer`);
  // topoFeature is overloaded; a GeometryCollection always yields a collection.
  return topoFeature(topo, object) as unknown as FeatureCollection<
    Polygon | MultiPolygon,
    P
  >;
}

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
    const [countryTopo, continents, cities, admin1Index] = await Promise.all([
      getJSON<Topology>('countries.topo.json'),
      getJSON<Continent[]>('continents.json'),
      getJSON<City[]>('cities.json'),
      getJSON<Admin1IndexEntry[]>('admin1/index.json'),
    ]);

    const countries = decode<CountryProps>(countryTopo, 'countries')
      .features as CountryFeature[];
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
    p = getJSON<Topology>(`admin1/${countryId}.topo.json`)
      .then((topo) => decode<Admin1Props>(topo, 'admin1').features as Admin1Feature[])
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
