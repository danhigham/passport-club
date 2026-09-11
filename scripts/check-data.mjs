#!/usr/bin/env node
/**
 * Sanity checks on the baked data.
 *
 * The game points at places in two different ways: clicks are judged with
 * `geoContains` against the polygon, but hints, reveal pins and distance
 * feedback all use a single representative point. If that point falls outside
 * its own shape (very possible for crescents, archipelagos and Natural Earth's
 * hand-placed label anchors) the game tells the player the wrong thing.
 *
 *   node scripts/check-data.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { geoArea, geoContains, geoOrthographic, geoPath } from 'd3-geo';
import topojsonClient from 'topojson-client';

const { feature: topoFeature } = topojsonClient;

/** Decode a packed layer the same way the game does. */
function decode(topo, layer) {
  return topoFeature(topo, topo.objects[layer]).features;
}

const ringsOf = (geometry) => {
  if (!geometry) return [];
  return geometry.type === 'Polygon'
    ? geometry.coordinates
    : geometry.coordinates.flat();
};

/**
 * Rings that enclose no area at all: collapsed to a point or a line.
 *
 * These are invisible, which is why they survived every other check here, and
 * they are the reason the oceans occasionally flashed the colour of the land.
 * d3's clipping is spherical, so it asks whether a ring contains the centre of
 * the view; for a degenerate ring the answer is arbitrary, and when it comes
 * back "yes" the clipper decides the shape covers the whole visible hemisphere
 * and fills the entire disc. Simplification is what creates them — at 15% of
 * vertices a small island becomes two points — so the coarse copies are where
 * they turn up.
 */
function degenerateRings(features) {
  const bad = [];
  for (const f of features) {
    if (!f.geometry) continue;
    for (const ring of ringsOf(f.geometry)) {
      const distinct = new Set(ring.map((p) => `${p[0]},${p[1]}`)).size;
      let shoelace = 0;
      for (let i = 0, n = ring.length - 1; i < n; i++) {
        shoelace += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
      }
      if (distinct < 3 || Math.abs(shoelace) === 0) {
        bad.push(`${f.properties.name} (${distinct} distinct pts)`);
        break;
      }
    }
  }
  return bad;
}

/**
 * Spin the globe past a grid of orientations and check that no single shape
 * ever paints most of the disc. This is the behavioural counterpart to the
 * check above: it tests the thing the player actually sees, at the angles where
 * clipping goes wrong.
 */
function swallowsTheView(features, label) {
  const W = 1280;
  const H = 700;
  const scale = Math.min(W, H) / 2 - 10;
  const disc = Math.PI * scale * scale;
  const bad = [];

  for (let lon = -180; lon < 180; lon += 15) {
    for (let lat = -75; lat <= 75; lat += 15) {
      const projection = geoOrthographic()
        .translate([W / 2, H / 2])
        .clipAngle(90)
        .precision(0.4)
        .rotate([-lon, -lat, 0])
        .scale(scale);
      const generator = geoPath(projection);
      for (const f of features) {
        if (generator.area(f) > disc * 0.5) {
          bad.push(`${f.properties.name} at ${lon},${lat} (${label})`);
        }
      }
    }
  }
  return bad;
}

/**
 * A polygon wound the wrong way is still valid GeoJSON — it just means the
 * complement of what you intended, so it swallows every click on the map.
 * Anything covering more than a fifth of the planet is certainly inverted.
 */
const INVERTED_AREA = (4 * Math.PI) / 5;

/** Does any sibling shape also contain this shape's own point? */
function shadowedBy(features, feature) {
  for (const other of features) {
    if (other === feature) continue;
    if (geoContains(other, feature.properties.point)) return other;
  }
  return null;
}

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');
const read = (p) => JSON.parse(fs.readFileSync(path.join(OUT, p), 'utf8'));

let failures = 0;
const report = (label, bad, total, sample) => {
  const ok = bad === 0;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(42)} ${total - bad}/${total}` +
      (sample.length ? `\n        e.g. ${sample.slice(0, 6).join(', ')}` : ''),
  );
};

/* ---- countries -------------------------------------------------------- */

const countries = decode(read('countries.topo.json'), 'countries');
const countriesCoarse = decode(read('countries-coarse.topo.json'), 'countries');

{
  // The two levels must stay index-aligned and carry the same ids; the coarse
  // copy may legitimately have no geometry for a shape too small to draw there.
  const mismatched = countries.filter(
    (f, i) => countriesCoarse[i]?.properties.id !== f.properties.id,
  );
  report('coarse countries align with detailed', mismatched.length, countries.length,
    mismatched.slice(0, 5).map((f) => f.properties.name));

  const dropped = countriesCoarse.filter((f) => !f.geometry);
  console.log(
    `      note: ${dropped.length} shape(s) too small to draw coarse` +
      (dropped.length ? ` (${dropped.map((f) => f.properties.name).slice(0, 6).join(', ')})` : ''),
  );
}
for (const [label, set] of [['countries', countries], ['coarse', countriesCoarse]]) {
  const bad = degenerateRings(set);
  report(`no degenerate rings (${label})`, bad.length, set.length, bad);
}
for (const [label, set] of [['countries', countries], ['coarse', countriesCoarse]]) {
  const bad = swallowsTheView(set, label);
  report(`no shape swallows the view (${label})`, bad.length ? 1 : 0, 1, bad);
}
{
  const bad = [];
  for (const f of countries) {
    if (!geoContains(f, f.properties.point)) bad.push(f.properties.name);
  }
  report('country point lies inside its polygon', bad.length, countries.length, bad);
}
{
  const bad = countries.filter((f) => !f.properties.name || !f.properties.id);
  report('country has id and name', bad.length, countries.length, bad.map((f) => f.id));
}
{
  const bad = countries.filter((f) => geoArea(f) > INVERTED_AREA);
  report('no country polygon is inverted', bad.length, countries.length,
    bad.map((f) => `${f.properties.name} (${(geoArea(f) / Math.PI).toFixed(2)}\u03c0 sr)`));
}
{
  const bad = [];
  for (const f of countries) {
    const other = shadowedBy(countries, f);
    if (other) bad.push(`${f.properties.name} inside ${other.properties.name}`);
  }
  report('no country swallows another country', bad.length, countries.length, bad);
}

/* ---- continents ------------------------------------------------------- */

const continents = read('continents.json');
{
  const used = new Set(countries.map((c) => c.properties.continent));
  const missing = [...used].filter((c) => !continents.some((k) => k.id === c));
  report('every country maps to a known continent', missing.length, used.size, missing);
}

/* ---- cities ----------------------------------------------------------- */

const cities = read('cities.json');
{
  const byId = new Map(countries.map((c) => [c.properties.id, c]));
  const orphan = cities.filter((c) => !byId.has(c.country));
  report('city scopes to a country we render', orphan.length, cities.length,
    orphan.map((c) => `${c.name} (${c.country})`));

  const mislabelled = cities.filter((c) => {
    const host = byId.get(c.country);
    return host && host.properties.continent !== c.continent;
  });
  report('city continent agrees with its host country', mislabelled.length, cities.length,
    mislabelled.map((c) => c.name));

  const noContinent = cities.filter((c) => !c.continent);
  report('city has a continent', noContinent.length, cities.length,
    noContinent.map((c) => c.name));
}
{
  // Cities are clicked by proximity, so two same-named cities sitting almost on
  // top of each other inside one scope would make a round unwinnable.
  const seen = new Map();
  const clashes = [];
  for (const c of cities) {
    const key = `${c.name}|${c.country}`;
    if (seen.has(key)) clashes.push(key);
    seen.set(key, c);
  }
  report('no duplicate city name within a country', clashes.length, cities.length, clashes);
}

/* ---- admin 1 ---------------------------------------------------------- */

const index = read('admin1/index.json');
{
  let bad = 0;
  let total = 0;
  const sample = [];
  for (const entry of index) {
    const features = decode(read(`admin1/${entry.country}.topo.json`), 'admin1');
    for (const f of features) {
      total++;
      if (!geoContains(f, f.properties.point)) {
        bad++;
        if (sample.length < 6) sample.push(`${f.properties.name} (${entry.country})`);
      }
    }
    if (features.length !== entry.count) {
      console.log(`      ! index count mismatch for ${entry.country}`);
      failures++;
    }
  }
  report('admin1 point lies inside its polygon', bad, total, sample);
}
{
  let bad = 0;
  let total = 0;
  const sample = [];
  for (const entry of index) {
    const features = decode(read(`admin1/${entry.country}.topo.json`), 'admin1');
    for (const f of features) {
      total++;
      if (geoArea(f) > INVERTED_AREA) {
        bad++;
        if (sample.length < 6) sample.push(`${f.properties.name} (${entry.country})`);
      }
    }
  }
  report('no admin1 polygon is inverted', bad, total, sample);
}
{
  // The killer bug this catches: one state covering the whole country, so every
  // click resolves to it and no other question can ever be answered.
  let bad = 0;
  let total = 0;
  const sample = [];
  for (const entry of index) {
    const features = decode(read(`admin1/${entry.country}.topo.json`), 'admin1');
    for (const f of features) {
      total++;
      const other = shadowedBy(features, f);
      if (other) {
        bad++;
        if (sample.length < 6) {
          sample.push(`${f.properties.name} inside ${other.properties.name} (${entry.country})`);
        }
      }
    }
  }
  report('no admin1 region swallows a sibling', bad, total, sample);
}
{
  let bad = 0;
  let total = 0;
  const sample = [];
  for (const entry of index) {
    for (const suffix of ['', '.coarse']) {
      const features = decode(
        read(`admin1/${entry.country}${suffix}.topo.json`),
        'admin1',
      );
      total += features.length;
      const found = degenerateRings(features);
      bad += found.length;
      if (found.length && sample.length < 6) {
        sample.push(`${found[0]} in ${entry.country}${suffix}`);
      }
    }
  }
  report('no degenerate rings (admin1, both levels)', bad, total, sample);
}
{
  const thin = index.filter((e) => e.count < 2);
  report('every admin1 country has 2+ divisions', thin.length, index.length,
    thin.map((e) => e.countryName));
}
{
  // Each level must have something to ask about, or the setup screen offers a
  // game that cannot start.
  const empty = [];
  for (const entry of index) {
    const features = decode(read(`admin1/${entry.country}.topo.json`), 'admin1');
    if (!features.some((f) => f.properties.tier === 1)) empty.push(entry.countryName);
  }
  report('every admin1 country has tier-1 items', empty.length, index.length, empty);
}

console.log(
  failures ? `\n${failures} check(s) failed.\n` : '\nAll checks passed.\n',
);
process.exit(failures ? 1 : 0);
