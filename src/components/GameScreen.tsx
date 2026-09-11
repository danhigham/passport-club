import { useEffect, useState } from 'react';
import type { CoreData } from '../data/datasets';
import { MODE_INFO } from '../game/session';
import type { Session } from '../game/session';
import type { GameApi } from '../game/useGame';
import { MapCanvas } from './MapCanvas';

interface Props {
  session: Session;
  core: CoreData;
  game: GameApi;
  onQuit: () => void;
}

export function GameScreen({ session, core, game, onQuit }: Props) {
  const { round } = game;
  const [shake, setShake] = useState(0);

  // Nudge the prompt card whenever a guess misses, so the feedback registers
  // even if the player's eyes are still on the map.
  const misses = round?.guesses.filter((g) => g.verdict === 'wrong').length ?? 0;
  useEffect(() => {
    if (misses > 0) setShake((s) => s + 1);
  }, [misses, round?.index]);

  if (!round) return null;

  const { target, status, guesses, message, secondsLeft, hintUsed } = round;
  const attemptsLeft = Math.max(0, 3 - guesses.length);
  const timerLow = secondsLeft !== null && secondsLeft <= 5;

  return (
    <div className="game">
      <header className="hud">
        <button type="button" className="ghost-button back" onClick={onQuit}>
          {'\u2190'} <span className="label-text">Settings</span>
        </button>

        <div className="hud-stats">
          <Stat label="Round" value={`${round.index + 1}/${game.total}`} />
          <Stat label="Score" value={String(game.score)} />
          <Stat
            label="Streak"
            value={game.streak > 0 ? `\u{1F525} ${game.streak}` : '\u2013'}
            highlight={game.streak >= 3}
          />
        </div>

        {secondsLeft !== null && status === 'guessing' && (
          <div className={`timer ${timerLow ? 'low' : ''}`}>{secondsLeft}</div>
        )}
      </header>

      <div className="map-area">
        <MapCanvas session={session} core={core} round={round} onGuess={game.guess} />
      </div>

      <div className={`prompt-dock status-${status}`} key={shake}>
        <div className="prompt-card">
          <div className="prompt-main">
            <span className="prompt-kicker">
              {MODE_INFO[session.config.mode].emoji} Find
            </span>
            <h2 className="prompt-name">{target.name}</h2>
            <p className="prompt-sub">{target.subtitle}</p>
          </div>

          <div className="prompt-side">
            {status === 'guessing' ? (
              <>
                <div className="lives" aria-label={`${attemptsLeft} tries left`}>
                  {[0, 1, 2].map((i) => (
                    <span key={i} className={`pip ${i < attemptsLeft ? 'full' : 'spent'}`} />
                  ))}
                </div>
                <div className="prompt-actions">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={game.useHint}
                    disabled={hintUsed}
                  >
                    {hintUsed ? 'Hint shown' : '\u{1F50D} Hint'}
                  </button>
                  <button type="button" className="ghost-button subtle" onClick={game.skip}>
                    Show me
                  </button>
                </div>
              </>
            ) : (
              <button type="button" className="next-button" onClick={game.next}>
                {round.index + 1 >= game.total ? 'See results' : 'Next'} {'\u2192'}
              </button>
            )}
          </div>
        </div>

        {message && (
          <p className={`feedback ${status === 'correct' ? 'good' : status === 'revealed' ? 'reveal' : 'bad'}`}>
            {message}
          </p>
        )}
        {!message && status === 'guessing' && (
          <p className="feedback neutral">
            {session.config.mode === 'city'
              ? 'Tap the map where you think it is. Pinch or scroll to zoom in.'
              : 'Tap the shape on the map. Pinch or scroll to zoom in.'}
          </p>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className={`stat ${highlight ? 'hot' : ''}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
