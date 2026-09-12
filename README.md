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
- **Say which part of the world it's in** — the line under the question reading
  “Country in Asia”. A bigger clue than it looks: it narrows the search from the
  whole globe to one region before the player has looked at anything.
- **Timer** — off by default. There is no rush.

Plus **how many tries per question** (1, 2, 3 or 5) and **how many questions**.
One try is sudden death; five is forgiving enough for a small child to hunt
around. Points fall with each miss — 100, 70, 40, 25, 15 — so a generous setting
costs score rather than nothing.

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
| `countries.topo.json` | 761 kb | 242 country polygons (204 askable) at 50m |
| `countries-coarse.topo.json` | 212 kb | The same countries, 15% of the vertices |
| `continents.json` | 1 kb | Continent registry and opening viewpoints |
| `cities.json` | 249 kb | 1,248 populated places |
| `admin1/<ISO3>.topo.json` | 10.7 mb total | 4,542 divisions across 211 countries, both detail levels |

The admin-1 set is far too big to ship as one file, so it's split per country and
fetched only when a player picks that country.

**Polygons ship as TopoJSON**, which pays for itself twice over. Shared borders
are stored once rather than twice and coordinates are quantised integers, so the
whole world at 50m costs ~260 kb gzipped — *less than the 110m GeoJSON it
replaced*, at roughly eighteen times the detail. And because a border is a
single shared arc, neighbours cannot drift apart into slivers of visible ocean
the way independently-simplified polygons do.

Resolution matters more than it sounds. At 110m the entire United Kingdom is
**56 points** — fine for a world view, obviously broken the moment you zoom, and
absurd beneath the 10m county boundaries drawn on top of it. At 50m it's 986.

The build does more than repackage:

- **Quantisation replaces decimal rounding.** Coordinates used to be snapped to
  a decimal grid to save space; TopoJSON quantisation does that job on a finer
  grid and without discarding the detail the 50m upgrade exists to deliver.
- **Ring winding is normalised**, after packing. This one matters enormously:
  `geoContains` is *spherical*, so a ring wound the wrong way isn't malformed —
  it's a valid polygon covering everything *except* the shape you meant. Natural
  Earth ships a few (Alaska, thanks to the Aleutians crossing the antimeridian),
  and building a topology can introduce more, since arcs get cut and re-threaded
  without regard to which way round the result ends up. The symptom is one state
  silently swallowing every click on the map.
- **Dependencies are drawn but never asked about.** The 50m set adds 65 entries
  over 110m, mostly territories — Guam, Jersey, the British Indian Ocean
  Territory, and non-countries like the Siachen Glacier. A map with holes in it
  is worse than useless, but "find Ashmore and Cartier Islands" is not a question
  to put to a child, so they carry an `askable` flag.
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

### The hybrid base map (experimental)

> This lives on the `hybrid-map` branch.

A **Map style** choice in the setup screen — *Drawn map* or *Satellite photos* —
swaps the painted globe for a photograph of the Earth, with the vector data
reduced to an overlay: borders, and — the point of the thing — the outline of
whatever is under the cursor.

It began life as a toggle among the helpers and nobody found it. Someone looking
for map layers does not go hunting in a list that starts with “show place
names”, so it is now a pair of labelled options at the top of that panel.

The reasoning is that the two map styles fail in opposite directions. Satellite
imagery shows a child what a place actually *looks* like, but gives no clue
where one country stops and the next begins. Vector cartography shows the
boundaries perfectly and nothing else. Highlighting the shape under the pointer
puts the boundary back exactly where it is being looked at, and only there.

**How the imagery works.** NASA's Blue Marble composite (public domain), one
equirectangular image, wrapped onto the globe by a fragment shader: about forty
lines of GLSL over a single full-screen quad. There is no tile server, no mesh
and no scene graph, because the projection is fixed — every pixel of the disc is
one point on the sphere, so the shader goes straight from pixel to latitude and
longitude and samples the photograph. Two sizes ship; the 72kb one appears
immediately and the 0.9mb one replaces it when it arrives.

The month is chosen, not incidental. The composites are cloudless, so what looks
like cloud over Russia is snow, and how much there is depends entirely on which
one you take. Between 50N and 75N the share of land reading as snow or ice runs
from 69.9% in December to 7.2% in August; between 35N and 50N, where most of
Europe sits, it is 12.2% against 0.2%. August it is — a green northern
hemisphere is what lets a child tell one place from another.

**The hard part is agreement.** The imagery is projected by the shader and the
overlay by d3 — two independent implementations of the same projection. Disagree
by a few pixels and the outlines visibly slide off their coastlines. So the
shader is not "an orthographic projection", it is a transcription of *d3's*, and
`npm run align` measures the result rather than trusting it (and `npm run
align:dev` repeats it against the dev server, where React mounts effects twice
on purpose — which is where this layer was once found dead on arrival): for a grid of
pixels it asks whether the photograph looks like land there and whether d3 says
a polygon covers it, then nudges the comparison a few pixels in each direction
and confirms the best match is dead centre.

```
PASS  Europe / Africa    best offset (0, -1)px, mismatch 9.2% vs 9.4% centred
PASS  the Americas       best offset (-1, -1)px, mismatch 10.6% vs 10.6% centred
PASS  Asia / Australia    best offset (0, 0)px, mismatch 13.6% vs 13.6% centred
```

The residual ~10% is coastline fuzz, islands and permanent ice — what matters is
that shifting the comparison does not improve it.

It also checks the photograph is *there*, and that the painted globe is not.
Alignment alone says nothing: a bare sphere with correctly-placed borders on it
passes perfectly, and so does a silent fall back to the vector base map.

**Cost.** 24ms per frame at the world view against 7ms for the vector globe, but
that figure is from software rendering (SwiftShader in headless Chromium) and
should fall a long way on a real GPU. Zoomed in it is already a wash — 10.3ms
against 10.5ms — because the vector layer stops filling shapes when the
photograph is doing that job. WebGL2 is required; where it is missing the
satellite option quietly does nothing and the vector globe carries on.

### Making a vector globe fast

MapTap sidesteps this problem by texturing a sphere with satellite raster tiles:
the GPU does all the work and nothing is ever re-projected. A vector globe has
no such luxury — every frame of a spin re-projects the world from scratch — and
the first version cost **107–159 ms per frame**, which is 6–9 fps.

It now runs in 6–16 ms. Three changes, in order of how much they bought:

**Level of detail.** At the world view the globe is ~600 px across, which puts
roughly half a degree in every pixel — against source data detailed to 0.05°.
We were paying for ten times the detail a pixel could show. A simplified copy
(15% of the vertices) is drawn whenever the camera is far out *or moving*, and
the full resolution only when it is both zoomed in and still. The simplification
is topology-aware, so a border thinned on one side is thinned identically on the
other and neighbours stay welded together.

**Project once, not twice.** Each outline was walked once to fill it and again
to stroke it — re-projecting a hundred thousand vertices to draw the very same
shape. Projecting into a `Path2D` and reusing it makes the second pass free.

**Horizon culling.** Each shape gets a bounding cap (the smallest circle on the
sphere containing it), cached on first use. If the cap lies entirely beyond what
the viewport can reach, the shape is skipped for the cost of one distance
comparison instead of projecting every vertex. Zoomed into a country this throws
away most of the planet. The same caps prefilter hit-testing, which runs on
every mouse move.

```
scenario              before     after
Countries, world      106.8ms    7.5ms
Countries, Europe     143.1ms   10.5ms
Continents (tinted)    80.5ms    6.3ms
Counties, UK          159.1ms   11.5ms
States, USA           134.6ms   16.1ms
```

`npm run bench` reproduces this: it spins the globe under a scripted drag and
reports paint times. Frame timing is instrumented permanently — it costs two
clock reads per frame, and rendering cost is the thing most likely to regress
here.

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
npm run frames   # frame-by-frame rendering integrity
npm run bench    # rendering performance
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

**`frames.mjs`** samples the canvas every frame while playing and flags any
single-frame lurch in the land-to-ocean balance.

That last one exists because of a bug nothing else could see. d3's clipping is
spherical: to draw a shape it asks whether that shape contains the centre of the
view. For a ring collapsed to a point or a line the answer is arbitrary, and
when it comes back "yes" the clipper concludes the shape covers the whole
visible hemisphere and fills the entire disc — painting the oceans in the colour
of the land, for one frame, at a narrow band of camera angles. Simplification
creates such rings from small islands. Every static check passed: they were
valid GeoJSON, correctly wound, and enclosed no area worth mentioning. Only
watching what actually reached the screen found it.

The coarse copies therefore drop not just collapsed rings but slivers — anything
below roughly a twentieth of a degree, invisible at the zooms they're used for
and equally unreliable to clip. A shape that loses everything falls back to its
unsimplified outline rather than vanishing when the globe starts moving; only
six (Monaco, the Vatican and friends) are too small to draw coarse at all.

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
