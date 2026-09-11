import { formatKm, verdictFor } from '../game/feedback';
import { MODE_INFO } from '../game/session';
import type { GameConfig, RoundResult } from '../types';

interface Props {
  results: RoundResult[];
  score: number;
  bestStreak: number;
  config: GameConfig;
  onPlayAgain: () => void;
  onChangeSettings: () => void;
}

export function ResultsScreen({
  results,
  score,
  bestStreak,
  config,
  onPlayAgain,
  onChangeSettings,
}: Props) {
  const solved = results.filter((r) => r.solved);
  const firstTry = results.filter((r) => r.solved && r.guesses.length === 1);
  const accuracy = results.length ? solved.length / results.length : 0;
  const verdict = verdictFor(accuracy);

  // Three stars for a clean run, one for showing up.
  const stars = accuracy >= 0.9 ? 3 : accuracy >= 0.65 ? 2 : accuracy >= 0.3 ? 1 : 0;

  return (
    <div className="results">
      <div className="results-card">
        <div className="stars" aria-label={`${stars} out of 3 stars`}>
          {[0, 1, 2].map((i) => (
            <span key={i} className={`star ${i < stars ? 'lit' : ''}`}>
              {'\u2605'}
            </span>
          ))}
        </div>

        <h1>
          <span className="verdict-emoji">{verdict.emoji}</span> {verdict.title}
        </h1>
        <p className="verdict-note">{verdict.note}</p>

        <div className="score-row">
          <Figure value={String(score)} label="points" big />
          <Figure value={`${solved.length}/${results.length}`} label="found" />
          <Figure value={String(firstTry.length)} label="first try" />
          <Figure value={String(bestStreak)} label="best streak" />
        </div>

        <div className="review">
          <h3>
            {MODE_INFO[config.mode].emoji} Your round
          </h3>
          <ul>
            {results.map((r, i) => {
              const misses = r.guesses.filter((g) => g.verdict === 'wrong');
              const closest = misses.length
                ? Math.min(...misses.map((g) => g.distanceKm))
                : null;
              return (
                <li key={`${r.target.id}-${i}`} className={r.solved ? 'ok' : 'missed'}>
                  <span className="tick">{r.solved ? '\u2713' : '\u2715'}</span>
                  <span className="review-name">
                    {r.target.name}
                    <small>{r.target.subtitle}</small>
                  </span>
                  <span className="review-meta">
                    {r.solved ? (
                      <>
                        {r.points} pts
                        {r.guesses.length > 1 && (
                          <small>
                            {' '}
                            after {r.guesses.length - 1} miss
                            {r.guesses.length > 2 ? 'es' : ''}
                          </small>
                        )}
                      </>
                    ) : closest !== null ? (
                      <small>closest {formatKm(closest)}</small>
                    ) : (
                      <small>skipped</small>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="results-actions">
          <button type="button" className="start-button" onClick={onPlayAgain}>
            Play again
          </button>
          <button type="button" className="ghost-button" onClick={onChangeSettings}>
            Change settings
          </button>
        </div>

        <p className="passport-teaser">
          {'\u{1F6C2}'} Passport stamps are coming soon — every place you find will be
          recorded in your own virtual passport.
        </p>
      </div>
    </div>
  );
}

function Figure({ value, label, big }: { value: string; label: string; big?: boolean }) {
  return (
    <div className={`figure ${big ? 'big' : ''}`}>
      <span className="figure-value">{value}</span>
      <span className="figure-label">{label}</span>
    </div>
  );
}
