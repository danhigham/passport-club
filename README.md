# Passport Club

A friendly geography game: you're shown a place, you find it on a spinnable
globe. Aimed at children and at anyone whose world map is still a bit fuzzy.

Where [MapTap](https://maptap.gg) gives everyone the same satellite globe with no
borders and no labels, Passport Club's whole point is that **you choose how hard
it is** — what kind of place you're hunting for, how obscure it's allowed to be,
and how many training wheels stay on.

```bash
npm install
npm run data     # download and bake the map data (first run only, ~2 min)
npm run dev      # http://localhost:5173
```

---

## What you can tune

**What you're finding** — Continents → Countries → States & Counties → Cities.
Roughly in order of difficulty; continents is where a five-year-old starts.

**Where** — the whole world, one continent, or (for states/counties) one of 171
countries, each with its own divisions and its own word for them: US *states*,
French *departments*, Japanese *prefectures*, Irish *counties*.

**How obscure** — three levels, which change *which* places get asked about
rather than adding time pressure:

| Level | Draws from |
| --- | --- |
| Explorer | Only the big famous ones — the top third |
| Traveller | Adds places you'd have to think about |
| Globetrotter | Everything, including the tiny and the tricky |

**Helpers** — each is a separate switch, so difficulty is a mixing desk rather
than one dial:

- **Draw borders** — outlines every country/state. With it off, the land is one
  continuous mass and the game gets dramatically harder.
- **Show place names** — labels everything *except* the answer. Turns the game
  into a reading exercise instead of a memory test, which is how beginners
  actually learn a map.
- **Mark cities with dots** — makes city mode multiple-choice.
- **Glow the country/continent it's in** — narrows the search before you start.
- **Timer** — off by default. There is no rush.

Every wrong guess names what you *did* hit and points you the right way
("That's Spain. France is north-east of there."), because being told "no" teaches
nothing. Three misses reveals the answer and the globe turns to show it.

---

## How it works

### The globe

The map is a real sphere — a d3 `geoOrthographic` projection you can spin and
zoom — drawn to a **canvas**, with an SVG layer above it for text and markers.

Canvas because an orthographic projection has to be recomputed from scratch on
every frame of a spin; there's no transform that can fake turning a ball. Handing
several thousand freshly-generated path strings to the DOM sixty times a second
isn't viable, but painting them is. Text stays in SVG, where it's crisp and
selectable.

Two deliberate constraints on the spin, both for the target audience:

- **North stays up.** Roll is never applied, so a few careless swipes can't leave
  the world tilted or upside-down.
- **The turn rate follows the zoom**, so a drag moves the same amount of *surface*
  under the finger whether you're looking at the whole planet or at one county.

Clicks are judged with `geoContains` against the real polygon on the sphere —
never against rendered pixels — so the answer is identical however the globe
happens to be turned, and stroke widths can never swallow a tap.

### The data

All map data is Natural Earth (public domain), baked at setup time by
`scripts/build-data.mjs` into files the game loads directly. No tile server, no
API keys, no runtime dependency on anyone else's infrastructure.

| File | Size | Contents |
| --- | --- | --- |
| `countries.json` | 194 kb | 177 country polygons + continent/population |
| `continents.json` | 1 kb | Continent registry and opening viewpoints |
| `cities.json` | 249 kb | 1,248 populated places |
| `admin1/<ISO3>.json` | 20 mb total | 4,127 divisions across 171 countries |

The admin-1 set is far too big to ship as one file, so it's split per country and
fetched only when a player picks that country. Median file is 64 kb.

The build does more than repackage:

- **Coordinates are thinned adaptively** — 2 decimal places for large shapes, up
  to 4 for small islands that would otherwise collapse to nothing.
- **Ring winding is normalised.** This one matters enormously: `geoContains` is
  *spherical*, so a ring wound the wrong way isn't malformed — it's a valid
  polygon covering everything *except* the shape you meant. Natural Earth ships a
  few (Alaska, thanks to the Aleutians crossing the antimeridian), and the symptom
  is one state silently swallowing every click on the map.
- **Every shape gets a guaranteed-interior point.** Hints, reveal pins and
  distance feedback all need a "here it is" coordinate, and a plain centroid falls
  in the sea for crescents like Croatia. Where the centroid escapes, the build
  grid-searches the largest lobe for a point that's genuinely inside.
- **Difficulty is ranked within its own country.** Every English county is
  "small" next to a Russian oblast, but Yorkshire is still the easy one if you're
  being quizzed on England. Absolute thresholds produced 232 "hard" UK counties
  and zero easy ones; ranking each country against its own siblings fixed it.
- **Micro-states are re-homed.** The 110m country file drops Singapore, Monaco,
  Malta and friends, so ~45 cities named a country that's never drawn. Those are
  resolved against the polygon they actually sit in.
- **Continent viewpoints are hand-set**, because Natural Earth files all of
  Russia under Europe — so the true centroid of "Europe" lands in central Siberia.

### Layout

```
src/
  map/
    geo.ts             Camera model, projection, hit-testing, framing
    render.ts          Canvas renderer for the globe
    useGlobeControls.ts  Spin / zoom / pinch / tap
  game/
    session.ts         Turns settings + data into a set of questions
    useGame.ts         Round state machine, scoring, reveals
    feedback.ts        Every word the game says to the player
  components/          Setup, game HUD, results, map
  data/datasets.ts     Loading and caching
scripts/
  build-data.mjs       Natural Earth -> game data
  check-data.mjs       Data invariants
  smoke.mjs            Game logic against real data, headless
  e2e.mjs              Plays the game in a real browser
```

---

## Testing

```bash
npm run verify   # types + data invariants + game logic
npm run e2e      # plays the game in a headless browser
```

Three layers, each catching something the others can't:

**`check-data.mjs`** asserts invariants on the baked data — no inverted polygons,
no region swallowing a sibling, every representative point inside its own shape,
no duplicate city names within a country, every country having playable items at
every level.

**`smoke.mjs`** bundles the *real* game modules, stubs `fetch` to read from disk,
and builds a session for every mode/scope/level combination — then clicks the
exact centre of every answer and asserts the judge accepts it. This is what
catches a question that can be generated but not answered.

**`e2e.mjs`** drives a real Chromium through complete rounds: reading each
question off the screen, projecting the answer's coordinates to a pixel, spinning
the globe if the answer is round the back, and clicking. It checks that wrong
guesses are rejected and explained, that three misses reveals, that the helper
switches reach the map, that dragging spins without tilting the poles, and that
clicks still land correctly after spinning and zooming.

The browser suite talks to the app through a handle that is only attached when
the page is loaded with `?e2e=1`; nothing is exposed in normal use.

---

## Still to come

**The passport.** The name is a promise the app doesn't keep yet: every place you
find should earn a stamp in a virtual passport that persists between sessions,
with per-user progress, a map of everywhere you've been, and revision rounds
built from the places you keep missing. The data model is already shaped for it —
every round records its target, guesses, distances and timings.

Other candidates: daily challenge, two-player pass-and-play, flags and capitals
modes, and reading the place names aloud for pre-readers.

---

## Credits

Map data from [Natural Earth](https://www.naturalearthdata.com/) (public domain).
Built with React, Vite and [d3-geo](https://github.com/d3/d3-geo).
