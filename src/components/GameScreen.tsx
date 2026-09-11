import { useEffect, useState } from 'react';
import type { CoreData } from '../data/datasets';
import { MODE_INFO } from '../game/session';
import type { Session } from '../game/session';
import { AUTO_ADVANCE_MS, isArmed, type GameApi } from '../game/useGame';
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
  const isLast = round.index + 1 >= game.total;

  /*
   * Swallow taps that arrive in the first instants of a round. A correct answer
   * advances the game by itself, so a player reaching for a button can easily
   * still be moving when the next question replaces it.
   */
  const guard = (fn: () => void) => () => {
    if (!isArmed(round)) return;
    fn();
  };

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
                    onClick={guard(game.useHint)}
                    disabled={hintUsed}
                  >
                    {hintUsed ? 'Hint shown' : '\u{1F50D} Hint'}
                  </button>
                  <button
                    type="button"
                    className="ghost-button subtle"
                    onClick={guard(game.skip)}
                  >
                    Show me
                  </button>
                </div>
              </>
            ) : status === 'correct' ? (
              /*
               * Deliberately not a button. A correct answer moves on by itself,
               * so anything clickable here is a target that vanishes mid-reach,
               * and the press then lands on whatever takes its place. A progress
               * bar communicates the same thing without inviting a tap.
               */
              <div className="advancing" aria-live="polite">
                <span className="advancing-label">
                  {isLast ? 'Finishing up\u2026' : 'Next question\u2026'}
                </span>
                <span className="advance-track">
                  <span
                    className="advance-fill"
                    style={{ animationDuration: `${AUTO_ADVANCE_MS}ms` }}
                  />
                </span>
              </div>
            ) : (
              <button type="button" className="next-button" onClick={guard(game.next)}>
                {isLast ? 'See results' : 'Next'} {'\u2192'}
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
