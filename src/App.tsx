import { useCallback, useEffect, useRef, useState } from 'react';
import { loadAdmin1, loadCore, type CoreData } from './data/datasets';
import { buildSession, type Session } from './game/session';
import { useGame } from './game/useGame';
import { GameScreen } from './components/GameScreen';
import { ResultsScreen } from './components/ResultsScreen';
import { SetupScreen } from './components/SetupScreen';
import type { Admin1Feature, GameConfig, Phase } from './types';

const STORAGE_KEY = 'passport-club/config/v1';

const DEFAULT_CONFIG: GameConfig = {
  mode: 'continent',
  scope: { type: 'world' },
  level: 'explorer',
  showBorders: true,
  showLabels: false,
  showCityDots: true,
  narrowToParent: false,
  rounds: 10,
  timeLimit: null,
};

function loadConfig(): GameConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    // Merge rather than replace, so new options gain their defaults.
    return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<GameConfig>) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export default function App() {
  const [core, setCore] = useState<CoreData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<GameConfig>(loadConfig);
  const [phase, setPhase] = useState<Phase>('setup');
  const [session, setSession] = useState<Session | null>(null);
  const startToken = useRef(0);

  /* Core data loads once, up front. */
  useEffect(() => {
    loadCore().then(setCore, (e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      /* private browsing — not worth bothering the player about */
    }
  }, [config]);

  const patchConfig = useCallback((patch: Partial<GameConfig>) => {
    setConfig((c) => ({ ...c, ...patch }));
  }, []);

  const begin = useCallback(
    async (withConfig: GameConfig) => {
      if (!core) return;
      const token = ++startToken.current;
      setPhase('loading');
      try {
        let admin1 = { features: [] as Admin1Feature[], coarse: [] as Admin1Feature[] };
        if (withConfig.mode === 'admin1' && withConfig.scope.type === 'country') {
          admin1 = await loadAdmin1(withConfig.scope.id);
        }
        if (token !== startToken.current) return; // superseded by a newer start
        setSession(buildSession(core, withConfig, admin1));
        setPhase('playing');
      } catch (e) {
        if (token !== startToken.current) return;
        setError((e as Error).message);
        setPhase('setup');
      }
    },
    [core],
  );

  const handleFinish = useCallback(() => setPhase('results'), []);
  // The session is fed in for both 'playing' and 'results': the hook resets
  // itself whenever the session identity changes, so dropping it on finish
  // would wipe the very results the results screen is about to render.
  const game = useGame(session, core, handleFinish);

  if (error) {
    return (
      <div className="boot error">
        <h1>{'\u{1F5FA}\uFE0F'} The map got lost</h1>
        <p>{error}</p>
        <button
          type="button"
          className="start-button"
          onClick={() => window.location.reload()}
        >
          Try again
        </button>
      </div>
    );
  }

  if (!core) {
    return (
      <div className="boot">
        <div className="globe-spin">{'\u{1F30D}'}</div>
        <p>Unrolling the map…</p>
      </div>
    );
  }

  if (phase === 'loading') {
    return (
      <div className="boot">
        <div className="globe-spin">{'\u{1F5FA}\uFE0F'}</div>
        <p>Packing your bags…</p>
      </div>
    );
  }

  if (phase === 'playing' && session) {
    return (
      <GameScreen
        session={session}
        core={core}
        game={game}
        onQuit={() => {
          startToken.current++;
          setSession(null);
          setPhase('setup');
        }}
      />
    );
  }

  if (phase === 'results' && session) {
    return (
      <ResultsScreen
        results={game.results}
        score={game.score}
        bestStreak={game.bestStreak}
        config={session.config}
        onPlayAgain={() => begin(session.config)}
        onChangeSettings={() => {
          setSession(null);
          setPhase('setup');
        }}
      />
    );
  }

  return (
    <SetupScreen
      core={core}
      config={config}
      onChange={patchConfig}
      onStart={() => begin(config)}
    />
  );
}
