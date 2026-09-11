#!/usr/bin/env node
/**
 * Passport Club — data pipeline
 *
 * Downloads Natural Earth public-domain vector data and bakes it down into
 * small, label-free GeoJSON files the game can load instantly.
 *
 *   npm run data
 *
 * Output (all under public/data):
 *   countries.json         177 country polygons + continent/population metadata
 *   continents.json        friendly continent registry (derived from countries)
 *   cities.json            ~1250 populated places as points
 *   admin1/index.json      which countries have sub-national divisions
 *   admin1/<ISO3>.json     states / provinces / counties for that country
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { geoArea, geoCentroid, geoContains, geoDistance } from 'd3-geo';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, '.cache');
const OUT = path.join(ROOT, 'public', 'data');
const BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';

const SOURCES = {
  countries: 'ne_110m_admin_0_countries',
  admin1: 'ne_10m_admin_1_states_provinces',
  cities: 'ne_50m_populated_places_simple',
};

/* ------------------------------------------------------------------ utils */

const log = (...a) => console.log('  ' + a.join(' '));
const kb = (n) => (n / 1024).toFixed(0) + 'kb';

async function fetchSource(name) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, name + '.geojson');
  if (fs.existsSync(file)) {
    log(`cached  ${name}  ${kb(fs.statSync(file).size)}`);
  } else {
    const url = `${BASE}/${name}.geojson`;
    process.stdout.write(`  fetch   ${name} ... `);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(file, buf);
    console.log(kb(buf.length));
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Longitude/latitude span of a geometry, used to pick a precision. */
function span(geom) {
  let minX = 180, maxX = -180, minY = 90, maxY = -90;
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
    } else for (const x of c) walk(x);
  };
  walk(geom.coordinates);
  return Math.max(maxX - minX, maxY - minY);
}

/** Round a ring's coordinates, drop consecutive duplicates, close the ring. */
function thinRing(ring, p) {
  const f = 10 ** p;
  const out = [];
  for (const [x, y] of ring) {
    const rx = Math.round(x * f) / f;
    const ry = Math.round(y * f) / f;
    const last = out[out.length - 1];
    if (!last || last[0] !== rx || last[1] !== ry) out.push([rx, ry]);
  }
  if (out.length < 4) return null; // collapsed to a sliver — not clickable anyway
  const first = out[0];
  const last = out[out.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
  return out.length >= 4 ? out : null;
}

const HEMISPHERE = 2 * Math.PI;

/**
 * Force GeoJSON ring winding: exterior counter-clockwise, holes clockwise.
 *
 * This matters enormously. d3's `geoContains` is *spherical*, so a ring wound
 * the wrong way isn't a malformed polygon — it's a perfectly valid polygon
 * covering everything *except* the shape you meant. Natural Earth ships a few
 * of these (Alaska is the notorious one, thanks to the Aleutians crossing the
 * antimeridian), and the symptom is that one state silently swallows every
 * click on the map.
 */
function orientRings(rings) {
  return rings.map((ring, i) => {
    const lone = geoArea({ type: 'Polygon', coordinates: [ring] });
    const inverted = i === 0 ? lone > HEMISPHERE : lone < HEMISPHERE;
    return inverted ? ring.slice().reverse() : ring;
  });
}

/** Simplify a Polygon/MultiPolygon in-place-ish; returns null if nothing survives. */
function thinGeometry(geom) {
  if (!geom) return null;
  // Tiny features (small islands, city-states) need more precision to survive.
  const s = span(geom);
  const p = s < 1 ? 4 : s < 5 ? 3 : 2;

  if (geom.type === 'Polygon') {
    const rings = geom.coordinates.map((r) => thinRing(r, p)).filter(Boolean);
    return rings.length ? { type: 'Polygon', coordinates: orientRings(rings) } : null;
  }
  if (geom.type === 'MultiPolygon') {
    const polys = geom.coordinates
      .map((poly) => poly.map((r) => thinRing(r, p)).filter(Boolean))
      .filter((poly) => poly.length > 0)
      .map(orientRings);
    if (!polys.length) return null;
    return polys.length === 1
      ? { type: 'Polygon', coordinates: polys[0] }
      : { type: 'MultiPolygon', coordinates: polys };
  }
  return geom;
}

/* ------------------------------------------------- representative points */

/**
 * A point guaranteed to sit *inside* the shape.
 *
 * The game uses this for hint circles, reveal pins and "you were 400km away"
 * feedback, so a point that lands in the sea (which a plain centroid does for
 * crescents like Croatia, and which Natural Earth's label anchors occasionally
 * do too) would actively mislead the player.
 */
function representativePoint(geometry, preferred) {
  if (preferred && Number.isFinite(preferred[0]) && geoContains({ type: 'Feature', geometry, properties: {} }, preferred)) {
    return [round4(preferred[0]), round4(preferred[1])];
  }

  const feature = { type: 'Feature', geometry, properties: {} };
  const c = geoCentroid(feature);
  if (Number.isFinite(c[0]) && geoContains(feature, c)) return [round4(c[0]), round4(c[1])];

  // Centroid fell outside. Grid-search the largest ring's bounding box and keep
  // the interior point furthest from the box edges, which lands us somewhere
  // comfortably in the middle of the biggest lobe rather than in a thin spur.
  const rings =
    geometry.type === 'Polygon' ? [geometry.coordinates[0]] : geometry.coordinates.map((p) => p[0]);
  let ring = rings[0];
  let bestSpan = -1;
  for (const r of rings) {
    const b = ringBounds(r);
    const s = (b[2] - b[0]) * (b[3] - b[1]);
    if (s > bestSpan) {
      bestSpan = s;
      ring = r;
    }
  }

  const [minX, minY, maxX, maxY] = ringBounds(ring);
  const STEPS = 24;
  let best = null;
  let bestScore = -1;
  for (let i = 1; i < STEPS; i++) {
    for (let j = 1; j < STEPS; j++) {
      const x = minX + ((maxX - minX) * i) / STEPS;
      const y = minY + ((maxY - minY) * j) / STEPS;
      if (!geoContains(feature, [x, y])) continue;
      const score = Math.min(x - minX, maxX - x) * Math.min(y - minY, maxY - y);
      if (score > bestScore) {
        bestScore = score;
        best = [x, y];
      }
    }
  }
  if (best) return [round4(best[0]), round4(best[1])];

  // Shape is thinner than the grid (a sliver of coastline). Its own midpoint
  // vertex is the closest we can get.
  const v = ring[Math.floor(ring.length / 2)];
  return [round4(v[0]), round4(v[1])];
}

const round4 = (n) => Math.round(n * 1e4) / 1e4;

function ringBounds(ring) {
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function writeJSON(rel, data) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const json = JSON.stringify(data);
  fs.writeFileSync(file, json);
  return json.length;
}

/* ----------------------------------------------------- naming / difficulty */

// Natural Earth's NAME column is already short & map-friendly, but a few
// entries read oddly to a child. Override them here.
const COUNTRY_NAME_FIX = {
  'United States of America': 'United States',
  'Dem. Rep. Congo': 'Democratic Republic of the Congo',
  'Congo': 'Republic of the Congo',
  'Central African Rep.': 'Central African Republic',
  'Dominican Rep.': 'Dominican Republic',
  'Eq. Guinea': 'Equatorial Guinea',
  'S. Sudan': 'South Sudan',
  'Bosnia and Herz.': 'Bosnia and Herzegovina',
  'Solomon Is.': 'Solomon Islands',
  'N. Cyprus': 'Northern Cyprus',
  'Czechia': 'Czechia (Czech Republic)',
  'Côte d\u2019Ivoire': 'Ivory Coast',
  "Côte d'Ivoire": 'Ivory Coast',
  'Myanmar': 'Myanmar (Burma)',
  'eSwatini': 'Eswatini',
  'Timor-Leste': 'East Timor',
  'Falkland Is.': 'Falkland Islands',
  'Fr. S. Antarctic Lands': 'French Southern Territories',
  'W. Sahara': 'Western Sahara',
};

/**
 * Continent keys as Natural Earth spells them -> what we show a child, plus
 * the viewpoint the globe should open on.
 *
 * `view` is hand-set rather than derived, because a computed centroid gives a
 * badly wrong answer for continents with a long tail. Natural Earth assigns
 * each country a single continent, so the whole of Russia counts as Europe:
 * the true centroid of "Europe" therefore lands in central Siberia, and the
 * bounding cap is wide enough to swallow the planet. A child asked to find
 * countries in Europe should be looking at Europe.
 */
const CONTINENTS = {
  Africa: { name: 'Africa', emoji: '\u{1F981}', order: 3, view: { center: [20, 2], radius: 42 } },
  Asia: { name: 'Asia', emoji: '\u{1F3EF}', order: 4, view: { center: [88, 30], radius: 52 } },
  Europe: { name: 'Europe', emoji: '\u{1F3F0}', order: 2, view: { center: [16, 51], radius: 26 } },
  'North America': {
    name: 'North America',
    emoji: '\u{1F5FD}',
    order: 1,
    view: { center: [-97, 42], radius: 44 },
  },
  'South America': {
    name: 'South America',
    emoji: '\u{1F999}',
    order: 5,
    view: { center: [-60, -22], radius: 38 },
  },
  Oceania: {
    name: 'Oceania',
    emoji: '\u{1F998}',
    order: 6,
    view: { center: [147, -24], radius: 42 },
  },
  Antarctica: {
    name: 'Antarctica',
    emoji: '\u{1F427}',
    order: 7,
    view: { center: [0, -84], radius: 34 },
  },
};

/**
 * Difficulty tier 1..3 (1 = a beginner should manage it).
 * Countries are ranked by population and by how prominently Natural Earth
 * labels them, which is a decent proxy for "have I heard of this place?".
 */
function countryTier(p) {
  const pop = p.POP_EST || 0;
  const label = p.LABELRANK ?? 6;
  if (pop >= 45_000_000 || label <= 2) return 1;
  if (pop >= 5_000_000 || label <= 4) return 2;
  return 3;
}

/**
 * City fame, which is only loosely about population — a child is far likelier
 * to have heard of Reykjavik than of Tucson.
 *
 * Natural Earth's `megacity` flag is useless here (462 of 1251 places carry
 * it). `scalerank` and `worldcity` are the honest signals: they encode how
 * early a cartographer would put the city on a zoomed-out map.
 */
function cityTier(p) {
  const pop = p.pop_max || 0;
  const capital = p.adm0cap === 1;
  if (p.worldcity === 1 || p.scalerank === 0 || (capital && pop >= 2_000_000)) return 1;
  if (capital || pop >= 2_000_000 || p.scalerank <= 1) return 2;
  return 3;
}

/**
 * Admin-1 difficulty has to be judged *within* a country. Natural Earth's
 * `labelrank` and `area_sqkm` are not comparable across borders — every English
 * county is "small" next to a Russian oblast, but Yorkshire is still the easy
 * one if you're being quizzed on England. So we rank each country's divisions
 * against their own siblings and cut the list into thirds.
 */
function assignAdmin1Tiers(feats) {
  const bboxArea = (geom) => {
    let minX = 180, maxX = -180, minY = 90, maxY = -90;
    const walk = (c) => {
      if (typeof c[0] === 'number') {
        if (c[0] < minX) minX = c[0];
        if (c[0] > maxX) maxX = c[0];
        if (c[1] < minY) minY = c[1];
        if (c[1] > maxY) maxY = c[1];
      } else for (const x of c) walk(x);
    };
    walk(geom.coordinates);
    // Rough km^2: shrink longitude by latitude so northern places aren't inflated.
    const mid = ((minY + maxY) / 2) * (Math.PI / 180);
    return (maxX - minX) * Math.cos(mid) * 111 * ((maxY - minY) * 111);
  };

  const scored = feats.map((f) => {
    const p = f.properties;
    const area = p._area > 0 ? p._area : bboxArea(f.geometry);
    return { f, area, label: p._label };
  });

  // Two independent rankings: physical size, and how prominently NE labels it.
  const byArea = [...scored].sort((a, b) => b.area - a.area);
  const byLabel = [...scored].sort((a, b) => a.label - b.label);
  const areaRank = new Map(byArea.map((s, i) => [s.f, i / scored.length]));
  const labelRank = new Map(byLabel.map((s, i) => [s.f, i / scored.length]));

  const combined = scored
    .map((s) => ({ f: s.f, score: areaRank.get(s.f) * 0.65 + labelRank.get(s.f) * 0.35 }))
    .sort((a, b) => a.score - b.score);

  const n = combined.length;
  combined.forEach(({ f }, i) => {
    // Small countries: everything is fair game for a beginner.
    if (n <= 12) f.properties.tier = 1;
    else if (i < n * 0.35) f.properties.tier = 1;
    else if (i < n * 0.7) f.properties.tier = 2;
    else f.properties.tier = 3;
    delete f.properties._area;
    delete f.properties._label;
  });
}

/**
 * What does this country call its first-level divisions? Natural Earth's
 * `type_en` is per-feature and noisy, so we take the most common value and
 * fall back to a generic word.
 */
// Natural Earth's `type_en` is officialese in places. Soften the worst of it.
const TERM_FIX = {
  'Metropolitan department': 'Department',
  'Metropolitan departments': 'Department',
  'Unitary Authority': 'County / Council Area',
  'Unitary District': 'County / Council Area',
  'Metropolitan District': 'County / Council Area',
  'London Borough': 'County / Council Area',
  'Two-tier County': 'County / Council Area',
  'Council Area': 'County / Council Area',
  'Autonomous Community': 'Province',
  'Federal District': 'State',
  'Capital Region': 'Region',
};

function divisionTerm(features) {
  const counts = {};
  for (const f of features) {
    const t = (f.properties.type_en || '').trim();
    if (t) counts[t] = (counts[t] || 0) + 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (!best) return { singular: 'Region', plural: 'Regions' };
  const singular = (TERM_FIX[best[0]] || best[0]).replace(/\s*\(.*\)$/, '');
  const plural = /y$/i.test(singular)
    ? singular.slice(0, -1) + 'ies'
    : /(s|sh|ch|x|z)$/i.test(singular)
      ? singular + 'es'
      : singular + 's';
  return { singular, plural };
}

/* ------------------------------------------------------------------- main */

async function main() {
  console.log('\nPassport Club data build\n');
  fs.mkdirSync(OUT, { recursive: true });

  /* ---- countries -------------------------------------------------- */
  const rawCountries = await fetchSource(SOURCES.countries);
  const countries = [];

  for (const f of rawCountries.features) {
    const p = f.properties;
    const geometry = thinGeometry(f.geometry);
    if (!geometry) continue;

    const id = p.ADM0_A3 || p.SOV_A3;
    const name = COUNTRY_NAME_FIX[p.NAME] || p.NAME;
    const continent = p.CONTINENT;

    countries.push({
      type: 'Feature',
      id,
      properties: {
        id,
        kind: 'country',
        name,
        continent,
        region: p.SUBREGION,
        iso2: p.ISO_A2_EH !== '-99' ? p.ISO_A2_EH : null,
        pop: p.POP_EST || 0,
        tier: countryTier(p),
        // Natural Earth's hand-placed label anchor is a much nicer "where is
        // it" marker than a computed centroid for odd shapes like Norway or
        // Chile — but only when it actually lands on the country.
        point: representativePoint(geometry, [p.LABEL_X, p.LABEL_Y]),
      },
      geometry,
    });
  }

  // Natural Earth files a handful of scattered island territories under
  // "Seven seas (open ocean)". A child asked to find Europe should still be
  // able to tap them, so adopt each one into its nearest real continent.
  const anchored = countries.filter((c) => CONTINENTS[c.properties.continent]);
  for (const c of countries) {
    if (CONTINENTS[c.properties.continent]) continue;
    let nearest = null;
    let bestD = Infinity;
    for (const other of anchored) {
      const d = geoDistance(c.properties.point, other.properties.point);
      if (d < bestD) {
        bestD = d;
        nearest = other;
      }
    }
    const adopted = nearest?.properties.continent ?? 'Africa';
    log(`adopt   ${c.properties.name} → ${adopted}`);
    c.properties.continent = adopted;
  }

  const continentSeen = new Map();
  for (const c of countries) {
    const key = c.properties.continent;
    const entry = continentSeen.get(key) || { members: 0, pop: 0 };
    entry.members++;
    entry.pop += c.properties.pop;
    continentSeen.set(key, entry);
  }

  countries.sort((a, b) => a.properties.name.localeCompare(b.properties.name));
  const nCountries = writeJSON('countries.json', {
    type: 'FeatureCollection',
    features: countries,
  });
  log(`wrote   countries.json  ${countries.length} features  ${kb(nCountries)}`);

  /* ---- continents (a registry, not geometry — we hit-test countries) ---- */
  const continents = [...continentSeen.entries()]
    .map(([key, stats]) => ({
      id: key,
      kind: 'continent',
      name: CONTINENTS[key].name,
      emoji: CONTINENTS[key].emoji,
      order: CONTINENTS[key].order,
      view: CONTINENTS[key].view,
      countries: stats.members,
      pop: stats.pop,
      tier: 1,
    }))
    .sort((a, b) => a.order - b.order);
  const nCont = writeJSON('continents.json', continents);
  log(`wrote   continents.json  ${continents.length} entries  ${kb(nCont)}`);

  /* ---- cities ------------------------------------------------------ */
  const rawCities = await fetchSource(SOURCES.cities);
  const countryNameByA3 = new Map(countries.map((c) => [c.id, c.properties.name]));
  const continentByA3 = new Map(countries.map((c) => [c.id, c.properties.continent]));

  /**
   * The 110m country file drops micro-states, so ~45 cities (Singapore, Monaco,
   * Hong Kong, Malta …) name a country we never draw. Resolve those against the
   * polygon they actually sit in — or the closest one — so they can still be
   * scoped, coloured and asked about.
   */
  const resolveHost = (lonLat) => {
    for (const c of countries) {
      if (geoContains(c, lonLat)) return c;
    }
    let nearest = null;
    let bestD = Infinity;
    for (const c of countries) {
      const d = geoDistance(c.properties.point, lonLat);
      if (d < bestD) {
        bestD = d;
        nearest = c;
      }
    }
    return nearest;
  };

  const cleanCountryName = (s) =>
    (s || '')
      .replace(/\s*S\.A\.R\.?$/i, '')
      .replace(/\s*\(.*\)$/, '')
      .trim();

  let adopted = 0;
  const cities = [];
  for (const f of rawCities.features) {
    const p = f.properties;
    if (!p.name || f.geometry?.type !== 'Point') continue;
    const [lon, lat] = f.geometry.coordinates;
    const lonLat = [Math.round(lon * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4];

    let country = p.adm0_a3;
    let countryName = countryNameByA3.get(country);
    let continent = continentByA3.get(country) ?? null;

    if (!countryName) {
      const host = resolveHost(lonLat);
      if (!host) continue;
      adopted++;
      // Scope/render against the host country, but keep the city's own
      // country name so the prompt still reads "City in Singapore".
      country = host.properties.id;
      countryName = cleanCountryName(p.adm0name) || host.properties.name;
      continent = host.properties.continent;
    }

    cities.push({
      id: 'city-' + p.ne_id,
      kind: 'city',
      name: p.name,
      country,
      countryName,
      continent,
      adm1: p.adm1name || null,
      capital: p.adm0cap === 1,
      pop: p.pop_max || 0,
      tier: cityTier(p),
      lon: lonLat[0],
      lat: lonLat[1],
    });
  }

  cities.sort((a, b) => b.pop - a.pop);

  // Two cities with the same name in the same country make a question that
  // cannot be answered fairly (China has two Suzhous). Keep the bigger one.
  const seenNames = new Set();
  const deduped = [];
  let dropped = 0;
  for (const c of cities) {
    const key = `${c.name.toLowerCase()}|${c.country}`;
    if (seenNames.has(key)) {
      dropped++;
      continue;
    }
    seenNames.add(key);
    deduped.push(c);
  }

  const nCities = writeJSON('cities.json', deduped);
  log(
    `wrote   cities.json  ${deduped.length} places  ${kb(nCities)}` +
      `  (${adopted} re-homed, ${dropped} duplicate name${dropped === 1 ? '' : 's'} dropped)`,
  );

  /* ---- admin 1 (states / provinces / counties) ---------------------- */
  const rawAdmin1 = await fetchSource(SOURCES.admin1);
  const byCountry = new Map();
  for (const f of rawAdmin1.features) {
    const p = f.properties;
    // Skip unnamed / disputed placeholders — nothing to ask a child to find.
    const name = p.name_en || p.name;
    if (!name || name === 'null') continue;
    const a3 = p.adm0_a3;
    if (!a3 || a3 === '-99') continue;
    if (!byCountry.has(a3)) byCountry.set(a3, []);
    byCountry.get(a3).push(f);
  }

  const index = [];
  let admin1Bytes = 0;
  fs.rmSync(path.join(OUT, 'admin1'), { recursive: true, force: true });

  for (const [a3, feats] of byCountry) {
    const countryName = countryNameByA3.get(a3);
    if (!countryName) continue; // territory with no matching country polygon
    if (feats.length < 2) continue; // a single "division" is a pointless quiz

    const term = divisionTerm(feats);
    const out = [];
    for (const f of feats) {
      const p = f.properties;
      const geometry = thinGeometry(f.geometry);
      if (!geometry) continue;
      const name = p.name_en || p.name;
      out.push({
        type: 'Feature',
        id: p.adm1_code,
        properties: {
          id: p.adm1_code,
          kind: 'admin1',
          name,
          country: a3,
          countryName,
          continent: continentByA3.get(a3) || null,
          type: p.type_en || term.singular,
          // Kept for a future "quiz me on Scotland only" style filter.
          region: p.region || null,
          point: representativePoint(geometry, [p.longitude, p.latitude]),
          tier: 2,
          _area: p.area_sqkm || 0,
          _label: p.labelrank ?? 10,
        },
        geometry,
      });
    }
    if (out.length < 2) continue;
    assignAdmin1Tiers(out);

    out.sort((a, b) => a.properties.name.localeCompare(b.properties.name));
    const bytes = writeJSON(path.join('admin1', a3 + '.json'), {
      type: 'FeatureCollection',
      features: out,
    });
    admin1Bytes += bytes;
    index.push({
      country: a3,
      countryName,
      continent: continentByA3.get(a3) || null,
      count: out.length,
      term: term.plural,
      termSingular: term.singular,
      bytes,
    });
  }

  index.sort((a, b) => a.countryName.localeCompare(b.countryName));
  writeJSON(path.join('admin1', 'index.json'), index);
  log(
    `wrote   admin1/  ${index.length} countries, ` +
      `${index.reduce((s, i) => s + i.count, 0)} divisions  ${kb(admin1Bytes)} total`,
  );

  console.log('\nDone. Data lives in public/data/\n');
}

main().catch((err) => {
  console.error('\nData build failed:', err.message);
  process.exit(1);
});
