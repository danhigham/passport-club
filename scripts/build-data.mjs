#!/usr/bin/env node
/**
 * mypassport.club — data pipeline
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
import { topology } from 'topojson-server';
import { presimplify, quantile, simplify } from 'topojson-simplify';
import topojsonClient from 'topojson-client';

const { feature: topoFeature, quantize } = topojsonClient;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, '.cache');
const OUT = path.join(ROOT, 'public', 'data');
const BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';

/**
 * Quantisation grids, in steps across each file's own bounding box.
 *
 * TopoJSON stores coordinates as integers on a grid and deltas between them,
 * which is most of why the files shrink so much. 1e5 across the whole world is
 * about 400m; the admin-1 files each cover a single country, so a coarser grid
 * number buys a much finer real-world resolution.
 */
const QUANTIZE_WORLD = 1e5;
const QUANTIZE_COUNTRY = 1e4;

/**
 * The coarse level of detail: what fraction of the world's vertices survive.
 *
 * Every frame of a spin re-projects whatever is on screen, so drawing 50m
 * detail at the world view costs ten times what it can possibly show — the
 * globe is about 600px across there, which puts roughly half a degree in each
 * pixel against the 0.05 degree detail of the source. This cut-down copy is
 * used whenever the camera is far out or moving, and is visually
 * indistinguishable at those sizes.
 */
const COARSE_KEEP = 0.15;

/**
 * Smallest ring worth keeping in a coarse copy, as twice its area in square
 * degrees. Roughly a 0.05-degree box, which at the zoom levels the coarse data
 * is used for is a fraction of one pixel.
 *
 * Simplification does not only flatten rings to nothing, it also leaves slivers
 * with an area that is tiny but not zero. Those are just as unreliable to clip
 * as fully degenerate ones and just as invisible, so they go too.
 */
const COARSE_MIN_RING = 0.004;
const QUANTIZE_COARSE = 2e4;

const SOURCES = {
  // 50m, not 110m. At 110m the whole United Kingdom is 56 points, which looks
  // like a crude polygon the moment you zoom past the world view -- and next to
  // the 10m county boundaries drawn on top of it, plainly broken.
  countries: 'ne_50m_admin_0_countries',
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

/**
 * Drop repeated points and close the ring.
 *
 * Note there is no rounding here any more. Coordinates used to be snapped to a
 * decimal grid to save space, but TopoJSON quantisation now does that job far
 * better — on a finer grid, and without throwing away the 50m detail this whole
 * pipeline exists to deliver.
 */
function cleanRing(ring) {
  const out = [];
  for (const [x, y] of ring) {
    const last = out[out.length - 1];
    if (!last || last[0] !== x || last[1] !== y) out.push([x, y]);
  }
  if (out.length < 4) return null; // collapsed to a sliver — not clickable anyway
  const first = out[0];
  const last = out[out.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
  return out.length >= 4 ? out : null;
}

const HEMISPHERE = 2 * Math.PI;

/** Twice the enclosed area of a ring, by the shoelace formula. */
function shoelace(ring) {
  let sum = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(sum);
}

/**
 * Keep only rings that enclose actual area.
 *
 * A ring that has collapsed to a point or a line is not merely invisible, it is
 * dangerous: d3's clipping is spherical, and asking whether a degenerate ring
 * contains the centre of the view gives an arbitrary answer. When it answers
 * "yes", the clipper concludes the shape covers the entire visible hemisphere
 * and emits the whole disc — painting the oceans in the land colour for exactly
 * as long as the camera stays at that angle, which is usually one frame.
 *
 * Simplification is what creates these: at 15% of vertices a small island is
 * reduced to two points. Quantisation can do it too.
 */
function liveRings(rings, minArea = 0) {
  const out = [];
  for (const ring of rings) {
    const cleaned = cleanRing(ring);
    if (!cleaned) continue;
    const distinct = new Set(cleaned.map((p) => `${p[0]},${p[1]}`)).size;
    if (distinct < 3 || shoelace(cleaned) <= minArea) continue;
    out.push(cleaned);
  }
  return out;
}

/** Tidy a Polygon/MultiPolygon; returns null if nothing survives. */
function thinGeometry(geom, minArea = 0) {
  if (!geom) return null;

  if (geom.type === 'Polygon') {
    const rings = liveRings(geom.coordinates, minArea);
    return rings.length ? { type: 'Polygon', coordinates: rings } : null;
  }
  if (geom.type === 'MultiPolygon') {
    const polys = geom.coordinates
      .map((poly) => liveRings(poly, minArea))
      .filter((poly) => poly.length > 0);
    if (!polys.length) return null;
    return polys.length === 1
      ? { type: 'Polygon', coordinates: polys[0] }
      : { type: 'MultiPolygon', coordinates: polys };
  }
  return geom;
}

/**
 * Force ring winding on a packed topology: exterior counter-clockwise, holes
 * clockwise.
 *
 * This matters enormously, and it has to happen *here*, after packing. d3's
 * `geoContains` is spherical, so a ring wound the wrong way isn't malformed —
 * it's a valid polygon covering everything *except* the shape you meant, and
 * the symptom is one region silently swallowing every click on the map.
 * Natural Earth ships a few such rings (Alaska, whose Aleutians cross the
 * antimeridian), and building a topology can introduce more, because arcs are
 * cut and re-threaded without regard to which way round the result ends up.
 *
 * A ring is reversed in TopoJSON by reversing its list of arcs and taking the
 * ones-complement of each index, which is exactly how the format already
 * encodes "traverse this shared arc backwards".
 */
function orientPolygonArcs(ringCoords, ringArcs) {
  let flipped = 0;
  ringCoords.forEach((ring, i) => {
    const lone = geoArea({ type: 'Polygon', coordinates: [ring] });
    const inverted = i === 0 ? lone > HEMISPHERE : lone < HEMISPHERE;
    if (inverted) {
      ringArcs[i] = ringArcs[i].map((a) => ~a).reverse();
      flipped++;
    }
  });
  return flipped;
}

/**
 * A simplified copy of a layer, for drawing when detail cannot be seen.
 *
 * Simplification is topology-aware: it works on shared arcs, so a border
 * thinned on one side is thinned identically on the other and neighbours stay
 * welded together. Feature order and ids are untouched, so the coarse and
 * detailed copies are interchangeable at render time.
 */
function coarsenTopology(name, features, keep, quantization) {
  let topo = presimplify(topology({ [name]: { type: 'FeatureCollection', features } }));
  // `quantile` takes the fraction of vertices to *retain*, not to discard.
  topo = simplify(topo, quantile(topo, keep));
  // presimplify leaves a weight on every point; drop it before quantising.
  topo.arcs = topo.arcs.map((arc) => arc.map((p) => [p[0], p[1]]));
  topo = quantize(topo, quantization);

  // Sweep up whatever simplification flattened, then pack again. A shape that
  // loses every ring falls back to its unsimplified self rather than vanishing:
  // these are tiny countries that cost a handful of vertices anyway.
  const decoded = topoFeature(topo, topo.objects[name]).features;
  const cleaned = decoded.map((f, i) => ({
    type: 'Feature',
    properties: features[i].properties,
    // If simplification left nothing, keep the shape unsimplified rather than
    // dropping it: a country that vanishes when the globe starts moving is far
    // more jarring than a handful of extra vertices. Only shapes too small to
    // survive even untouched — Monaco, the Vatican — genuinely disappear, and
    // those are a fraction of a pixel at the zooms this copy is used for.
    geometry:
      thinGeometry(f.geometry, COARSE_MIN_RING) ??
      thinGeometry(features[i].geometry, COARSE_MIN_RING),
  }));

  return packTopology(name, cleaned, quantization, COARSE_MIN_RING).topo;
}

function orientTopology(topo, name) {
  const object = topo.objects[name];
  const decoded = topoFeature(topo, object).features;
  let flipped = 0;

  decoded.forEach((f, i) => {
    const geometry = object.geometries[i];
    // Coarse levels drop shapes too small to draw, leaving no geometry at all.
    if (!f.geometry) return;
    if (f.geometry.type === 'Polygon') {
      flipped += orientPolygonArcs(f.geometry.coordinates, geometry.arcs);
    } else if (f.geometry.type === 'MultiPolygon') {
      f.geometry.coordinates.forEach((poly, k) => {
        flipped += orientPolygonArcs(poly, geometry.arcs[k]);
      });
    }
  });

  return flipped;
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

/**
 * Pack a FeatureCollection into TopoJSON, and hand back both the packed
 * topology and the features as the game will actually see them.
 *
 * Two reasons this is worth the extra step. Size: shared borders are stored
 * once rather than twice, and quantised integers beat decimal strings, which is
 * what makes shipping 50m data affordable at all. Correctness: because a border
 * is one shared arc, neighbours cannot drift apart into slivers of visible
 * ocean the way independently-simplified polygons do.
 *
 * The decoded features are returned because anything measured from the geometry
 * -- above all the guaranteed-interior point -- has to be measured from the
 * coordinates that ship, not the ones we started with. Quantisation moves
 * vertices, and a point computed before it can end up outside afterwards.
 */
function packTopology(name, features, quantization, minArea = 0) {
  const topo = quantize(
    topology({ [name]: { type: 'FeatureCollection', features } }),
    quantization,
  );
  // Quantisation snaps vertices to a grid, which can itself flatten a small
  // ring to nothing, so degenerate rings are swept up *after* it and the
  // topology rebuilt from the survivors. The second pass is geometrically a
  // no-op — the coordinates are already on the grid — so nothing shifts.
  const firstPass = topoFeature(topo, topo.objects[name]).features;
  const finalTopo = quantize(
    topology({
      [name]: {
        type: 'FeatureCollection',
        features: firstPass.map((f, i) => ({
          type: 'Feature',
          properties: features[i].properties,
          // No fallback: a ring too small to survive is too small to see.
          // Anything that loses all of them is dropped rather than redrawn at
          // a size that cannot be clipped reliably.
          geometry: thinGeometry(f.geometry, minArea),
        })),
      },
    }),
    quantization,
  );

  const flipped = orientTopology(finalTopo, name);
  const decoded = topoFeature(finalTopo, finalTopo.objects[name]).features;
  return { topo: finalTopo, decoded, flipped };
}

/**
 * Attach the representative point to each geometry, measured from the decoded
 * coordinates. `topoFeature` preserves geometry order, so the two lists line up.
 */
function attachPoints(topo, name, decoded, preferred) {
  const geometries = topo.objects[name].geometries;
  decoded.forEach((f, i) => {
    geometries[i].properties.point = representativePoint(
      f.geometry,
      preferred ? preferred(f) : null,
    );
  });
}

/* ----------------------------------------------------- naming / difficulty */

// Natural Earth's NAME column is already short & map-friendly, but a few
// entries read oddly to a child. Override them here.
/**
 * Which Natural Earth `TYPE`s are fair game as quiz answers.
 *
 * The 50m file carries 242 entries against 110m's 177, and the extra 65 are
 * mostly dependencies and territories: Guam, Jersey, the Isle of Man, the
 * British Indian Ocean Territory, and non-countries like the Siachen Glacier.
 * They should all be drawn — a map with holes in it is worse than useless — but
 * "find Ashmore and Cartier Islands" is not a question to put to a child.
 */
const ASKABLE_TYPES = new Set(['Sovereign country', 'Country']);

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
  'Capital Region': 'Region',
  // Note there is deliberately no 'Federal District' -> 'State' here. It was
  // the reason the United States was described as having 51 states, which is
  // not a number of states that exists: it has fifty, plus one federal
  // district. Softening is for collapsing synonyms, not for erasing a real
  // distinction.
};

/** Crude but adequate English pluralisation for division names. */
function pluralise(word) {
  if (/y$/i.test(word)) return word.slice(0, -1) + 'ies';
  if (/(s|sh|ch|x|z)$/i.test(word)) return word + 'es';
  return word + 's';
}

/**
 * A plain-English description of what a country is divided into.
 *
 * The dominant type alone is misleading where a country mixes them: the United
 * States came out as "51 states", which is not a number of states that exists.
 * It is fifty states and one federal district, and 83 of the 211 countries here
 * are mixtures of some kind.
 *
 * Deliberately built from the raw Natural Earth types rather than the softened
 * ones, since the softening exists to give a country a single friendly label and
 * would merge the very distinctions this is meant to show.
 */
function divisionSummary(features, total) {
  const counts = new Map();
  for (const f of features) {
    const raw = (f.properties.type_en || 'Region').trim();
    // Softened first, so genuine synonyms collapse: the United Kingdom's
    // unitary authorities, metropolitan districts and London boroughs are one
    // kind of thing to a child, and listing them separately is noise.
    const type = (TERM_FIX[raw] || raw).toLowerCase();
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const phrase = ([type, n]) => `${n} ${n === 1 ? type : pluralise(type)}`;

  if (ranked.length === 1) return phrase(ranked[0]);
  if (ranked.length === 2) return `${phrase(ranked[0])} & ${phrase(ranked[1])}`;
  // Three or more kinds is too much for a chip, and the tail is always small.
  // The dominant name with the true total reads naturally and stays honest
  // about how many places there are.
  return `${total} ${pluralise(ranked[0][0])}`;
}

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
  console.log('\nmypassport.club data build\n');
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
        // Whether this is a place to *ask* about, as opposed to merely draw.
        // The 50m file includes dependencies and disputed areas -- Guam, Jersey,
        // the Siachen Glacier -- which belong on the map but not in a quiz for
        // a child.
        askable: ASKABLE_TYPES.has(p.TYPE),
        // Natural Earth's hand-placed label anchor is a much nicer "where is
        // it" marker than a computed centroid for odd shapes like Norway or
        // Chile — but only when it actually lands on the country. Filled in
        // after packing, from the coordinates that actually ship.
        labelAnchor: [p.LABEL_X, p.LABEL_Y],
      },
      geometry,
    });
  }

  // Natural Earth files a handful of scattered island territories under
  // "Seven seas (open ocean)". A child asked to find Europe should still be
  // able to tap them, so adopt each one into its nearest real continent.
  const anchored = countries.filter((c) => CONTINENTS[c.properties.continent]);
  // A rough centroid is plenty here: we only need to know which continent is
  // closest, and the exact interior points aren't computed until after packing.
  const roughCentre = (f) => geoCentroid(f);
  for (const c of countries) {
    if (CONTINENTS[c.properties.continent]) continue;
    let nearest = null;
    let bestD = Infinity;
    for (const other of anchored) {
      const d = geoDistance(roughCentre(c), roughCentre(other));
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

  const packedCountries = packTopology('countries', countries, QUANTIZE_WORLD);
  attachPoints(packedCountries.topo, 'countries', packedCountries.decoded, (f) => {
    const a = f.properties.labelAnchor;
    return a && Number.isFinite(a[0]) ? a : null;
  });
  for (const g of packedCountries.topo.objects.countries.geometries) {
    delete g.properties.labelAnchor;
  }

  const nCountries = writeJSON('countries.topo.json', packedCountries.topo);
  const askable = countries.filter((c) => c.properties.askable).length;
  log(
    `wrote   countries.topo.json  ${countries.length} features ` +
      `(${askable} askable)  ${kb(nCountries)}`,
  );

  const coarseTopo = coarsenTopology('countries', countries, COARSE_KEEP, QUANTIZE_COARSE);
  const nCoarse = writeJSON('countries-coarse.topo.json', coarseTopo);
  const countPoints = (fc) =>
    fc.reduce((n, f) => {
      if (!f.geometry) return n;
      const walk = (c) => (typeof c[0] === 'number' ? 1 : c.reduce((m, x) => m + walk(x), 0));
      return n + walk(f.geometry.coordinates);
    }, 0);
  log(
    `wrote   countries-coarse.topo.json  ${kb(nCoarse)}  ` +
      `${countPoints(topoFeature(coarseTopo, coarseTopo.objects.countries).features).toLocaleString()}` +
      ` points vs ${countPoints(packedCountries.decoded).toLocaleString()}`,
  );

  // Decoded features, for everything below that needs real coordinates.
  const decodedCountries = topoFeature(
    packedCountries.topo,
    packedCountries.topo.objects.countries,
  ).features;

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
   * A few cities still name a country we don't draw — far fewer than at 110m,
   * which omitted every micro-state — so resolve those against the polygon they
   * actually sit in, or the closest one. Tested against the decoded geometry,
   * since that is what the game will hit-test against.
   */
  const resolveHost = (lonLat) => {
    for (const c of decodedCountries) {
      if (geoContains(c, lonLat)) return c;
    }
    let nearest = null;
    let bestD = Infinity;
    for (const c of decodedCountries) {
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
          labelAnchor: [p.longitude, p.latitude],
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

    // Packed per country, so a player downloads only the one they picked. The
    // shared-arc encoding also means neighbouring counties genuinely share an
    // edge rather than each carrying their own copy of it.
    const packed = packTopology('admin1', out, QUANTIZE_COUNTRY);
    attachPoints(packed.topo, 'admin1', packed.decoded, (f) => {
      const a = f.properties.labelAnchor;
      return a && Number.isFinite(a[0]) ? a : null;
    });
    for (const g of packed.topo.objects.admin1.geometries) {
      delete g.properties.labelAnchor;
    }

    let bytes = writeJSON(path.join('admin1', a3 + '.topo.json'), packed.topo);

    // A coarse copy too. The United States alone is 60,000 vertices; redrawing
    // that on every frame of a spin costs more than it can show while moving.
    bytes += writeJSON(
      path.join('admin1', a3 + '.coarse.topo.json'),
      coarsenTopology('admin1', out, COARSE_KEEP, QUANTIZE_COUNTRY),
    );
    admin1Bytes += bytes;
    index.push({
      country: a3,
      countryName,
      continent: continentByA3.get(a3) || null,
      count: out.length,
      term: term.plural,
      termSingular: term.singular,
      summary: divisionSummary(feats, out.length),
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
