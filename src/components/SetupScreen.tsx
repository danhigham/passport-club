import { useMemo, useState } from 'react';
import type { CoreData } from '../data/datasets';
import { prefetchAdmin1 } from '../data/datasets';
import { LEVEL_INFO, MODE_INFO, poolSize } from '../game/session';
import type { GameConfig, Level, Mode, Scope } from '../types';

interface Props {
  core: CoreData;
  config: GameConfig;
  onChange: (patch: Partial<GameConfig>) => void;
  onStart: () => void;
}

const MODES: Mode[] = ['continent', 'country', 'admin1', 'city'];
const LEVELS: Level[] = ['explorer', 'traveller', 'globetrotter'];
const ROUND_CHOICES = [5, 10, 15, 20];

export function SetupScreen({ core, config, onChange, onStart }: Props) {
  const [countryQuery, setCountryQuery] = useState('');

  const scopeCountry =
    config.scope.type === 'country' ? core.admin1ByCountry.get(config.scope.id) : undefined;

  const admin1Count = scopeCountry?.count ?? 0;
  const available = poolSize(core, config, admin1Count);

  const admin1Options = useMemo(() => {
    const q = countryQuery.trim().toLowerCase();
    const list = core.admin1Index.filter((e) => e.count >= 4);
    if (!q) {
      // Default view: the countries a child is most likely to want, by how
      // many divisions they have and how well known they are.
      const popular = [
        'USA', 'GBR', 'FRA', 'DEU', 'ESP', 'ITA', 'CAN', 'AUS',
        'JPN', 'BRA', 'IND', 'MEX', 'IRL', 'NLD', 'CHN', 'ZAF',
      ];
      const rank = new Map(popular.map((c, i) => [c, i]));
      return list
        .slice()
        .sort(
          (a, b) =>
            (rank.get(a.country) ?? 999) - (rank.get(b.country) ?? 999) ||
            a.countryName.localeCompare(b.countryName),
        )
        .slice(0, 18);
    }
    return list
      .filter(
        (e) =>
          e.countryName.toLowerCase().includes(q) || e.term.toLowerCase().includes(q),
      )
      .slice(0, 24);
  }, [core.admin1Index, countryQuery]);

  const setMode = (mode: Mode) => {
    const patch: Partial<GameConfig> = { mode };
    // Each mode has a scope that actually makes sense for it.
    if (mode === 'continent') {
      patch.scope = { type: 'world' };
    } else if (mode === 'admin1') {
      if (config.scope.type !== 'country') {
        patch.scope = { type: 'country', id: 'USA' };
        prefetchAdmin1('USA');
      }
    } else if (config.scope.type === 'country') {
      patch.scope = { type: 'world' };
    }
    onChange(patch);
  };

  const setScope = (scope: Scope) => {
    if (scope.type === 'country') prefetchAdmin1(scope.id);
    onChange({ scope });
  };

  const scopeIs = (s: Scope) =>
    config.scope.type === s.type &&
    (s.type === 'world' || ('id' in config.scope && config.scope.id === (s as { id: string }).id));

  // Offer the standard lengths that fit, plus the pool's own size when it is
  // smaller than the first standard step (seven continents, nine provinces).
  // Always include whatever is currently selected, so the setting a player
  // returns to is never silently unrepresented in the row.
  const roundChoices = [
    ...new Set(
      [
        ...ROUND_CHOICES.filter((n) => n <= available),
        ...(available > 0 && available < ROUND_CHOICES[1] ? [available] : []),
        config.rounds,
      ].filter((n) => n > 0),
    ),
  ].sort((a, b) => a - b);

  const tooFew = available < 3;

  return (
    <div className="setup">
      <header className="setup-head">
        <h1>
          <span className="logo-mark">{'\u{1F6C2}'}</span> Passport Club
        </h1>
        <p className="tagline">
          Pick what you'd like to find and how much help you want. There's no wrong
          way to start.
        </p>
      </header>

      <section className="panel">
        <h2>
          <span className="step">1</span> What shall we find?
        </h2>
        <div className="card-grid">
          {MODES.map((m) => {
            const info = MODE_INFO[m];
            return (
              <button
                key={m}
                type="button"
                className={`big-card ${config.mode === m ? 'selected' : ''}`}
                onClick={() => setMode(m)}
                aria-pressed={config.mode === m}
              >
                <span className="card-emoji">{info.emoji}</span>
                <span className="card-title">{info.name}</span>
                <span className="card-blurb">{info.blurb}</span>
              </button>
            );
          })}
        </div>
      </section>

      {config.mode === 'admin1' ? (
        <section className="panel">
          <h2>
            <span className="step">2</span> Inside which country?
          </h2>
          <input
            className="search"
            type="search"
            value={countryQuery}
            placeholder={'Search for a country\u2026'}
            onChange={(e) => setCountryQuery(e.target.value)}
            aria-label="Search for a country"
          />
          <div className="chip-grid">
            {admin1Options.map((e) => (
              <button
                key={e.country}
                type="button"
                className={`chip tall ${scopeIs({ type: 'country', id: e.country }) ? 'selected' : ''}`}
                onClick={() => setScope({ type: 'country', id: e.country })}
              >
                <span className="chip-title">{e.countryName}</span>
                <span className="chip-sub">
                  {e.count} {e.term.toLowerCase()}
                </span>
              </button>
            ))}
            {!admin1Options.length && (
              <p className="empty">
                No country matches "{countryQuery}". Not every country has regions in
                the map data.
              </p>
            )}
          </div>
        </section>
      ) : config.mode !== 'continent' ? (
        <section className="panel">
          <h2>
            <span className="step">2</span> Where in the world?
          </h2>
          <div className="chip-grid">
            <button
              type="button"
              className={`chip ${scopeIs({ type: 'world' }) ? 'selected' : ''}`}
              onClick={() => setScope({ type: 'world' })}
            >
              <span className="chip-emoji">{'\u{1F310}'}</span> Whole world
            </button>
            {core.continents
              .filter((c) => c.id !== 'Antarctica')
              .map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`chip ${scopeIs({ type: 'continent', id: c.id }) ? 'selected' : ''}`}
                  onClick={() => setScope({ type: 'continent', id: c.id })}
                >
                  <span className="chip-emoji">{c.emoji}</span> {c.name}
                </button>
              ))}
          </div>
        </section>
      ) : null}

      <section className="panel">
        <h2>
          <span className="step">{config.mode === 'continent' ? 2 : 3}</span> How tricky?
        </h2>
        <div className="card-grid three">
          {LEVELS.map((l) => {
            const info = LEVEL_INFO[l];
            return (
              <button
                key={l}
                type="button"
                className={`big-card ${config.level === l ? 'selected' : ''}`}
                onClick={() => onChange({ level: l })}
                aria-pressed={config.level === l}
                disabled={config.mode === 'continent' && l !== 'explorer'}
              >
                <span className="card-emoji">{info.emoji}</span>
                <span className="card-title">{info.name}</span>
                <span className="card-blurb">{info.blurb}</span>
              </button>
            );
          })}
        </div>
        {config.mode === 'continent' && (
          <p className="hint-text">
            There are only seven continents, so they're all fair game at every level.
          </p>
        )}
      </section>

      <section className="panel">
        <h2>
          <span className="step">{config.mode === 'continent' ? 3 : 4}</span> Helpers
        </h2>
        <div className="switch-list">
          <Switch
            label="Use satellite photos"
            hint="Shows the real Earth from space. Whatever you point at lights up, so you can still see the borders."
            checked={config.basemap === 'satellite'}
            onChange={(v) => onChange({ basemap: v ? 'satellite' : 'vector' })}
          />
          <Switch
            label={
              config.mode === 'continent'
                ? 'Colour the continents'
                : config.mode === 'admin1'
                  ? `Draw the ${scopeCountry?.term.toLowerCase() ?? 'region'} borders`
                  : 'Draw country borders'
            }
            hint={
              config.mode === 'continent'
                ? 'Tints each continent a different colour so you can see the groups.'
                : 'Outlines every shape so you can tell where one ends and the next begins.'
            }
            checked={config.showBorders}
            onChange={(v) => onChange({ showBorders: v })}
          />
          <Switch
            label="Show place names"
            hint="Labels everything except the one you're looking for. Great for learning."
            checked={config.showLabels}
            onChange={(v) => onChange({ showLabels: v })}
          />
          {config.mode === 'city' && (
            <Switch
              label="Mark the cities with dots"
              hint="Turns it into a multiple choice — tap the right dot."
              checked={config.showCityDots}
              onChange={(v) => onChange({ showCityDots: v })}
            />
          )}
          {(config.mode === 'city' || config.mode === 'country') && (
            <Switch
              label={
                config.mode === 'city'
                  ? 'Glow the country it sits in'
                  : 'Glow the continent it sits in'
              }
              hint="Narrows the search down before you even start looking."
              checked={config.narrowToParent}
              onChange={(v) => onChange({ narrowToParent: v })}
            />
          )}
          <Switch
            label="Add a timer"
            hint="20 seconds per question. Off by default — there's no rush."
            checked={config.timeLimit !== null}
            onChange={(v) => onChange({ timeLimit: v ? 20 : null })}
          />
        </div>

        <div className="rounds-row">
          <span className="rounds-label">How many questions?</span>
          <div className="chip-grid tight">
            {roundChoices.map((n) => (
              <button
                key={n}
                type="button"
                className={`chip small ${config.rounds === n ? 'selected' : ''}`}
                onClick={() => onChange({ rounds: n })}
                disabled={n > Math.max(available, 1)}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      </section>

      <footer className="setup-foot">
        <p className="pool-note">
          {tooFew
            ? 'That combination has almost nothing to find — try another country or level.'
            : `${available} place${available === 1 ? '' : 's'} to choose from.`}
        </p>
        <button
          type="button"
          className="start-button"
          onClick={onStart}
          disabled={tooFew}
        >
          Start exploring
        </button>
      </footer>
    </div>
  );
}

function Switch({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className={`switch ${checked ? 'on' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="track" aria-hidden="true">
        <span className="thumb" />
      </span>
      <span className="switch-text">
        <span className="switch-label">{label}</span>
        <span className="switch-hint">{hint}</span>
      </span>
    </label>
  );
}
