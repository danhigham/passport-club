import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CoreData } from '../data/datasets';
import { distanceKm, findAreaAt, findNearestCity } from '../map/geo';
import type { Guess, RoundResult, Target } from '../types';
import {
  correctMessage as correctText,
  revealMessage as revealText,
  wrongMessage as wrongText,
} from './feedback';
import type { Session } from './session';

/**
 * How long a correct answer is celebrated before the game moves itself on.
 * Exported so the on-screen progress bar can stay honest about it.
 */
export const AUTO_ADVANCE_MS = 1500;

/**
 * A new round ignores input for this long.
 *
 * Rounds can advance on their own, which means a tap can be in flight when the
 * question underneath it changes. Without this guard that tap lands on the new
 * round — as a wasted guess on the map, or worse, on whatever button has just
 * appeared where the player was aiming.
 */
export const ROUND_ARM_MS = 320;

/** Has this round been on screen long enough to accept input? */
export function isArmed(round: { startedAt: number } | null): boolean {
  return !!round && Date.now() - round.startedAt >= ROUND_ARM_MS;
}

/**
 * Points for solving a round, by how many wrong guesses came first.
 *
 * Extends far enough for the most generous setting; anything beyond it scores
 * the floor rather than nothing, because a player who gets there has still
 * worked the answer out.
 */
const POINTS_BY_ATTEMPT = [100, 70, 40, 25, 15, 10];
const STREAK_BONUS = 15;
const MAX_STREAK_BONUS = 5;

export type RoundStatus = 'guessing' | 'correct' | 'revealed';

export interface RoundState {
  index: number;
  target: Target;
  guesses: Guess[];
  status: RoundStatus;
  /** The most recent thing to say to the player. */
  message: string | null;
  hintUsed: boolean;
  startedAt: number;
  /** Seconds left, or null when playing untimed. */
  secondsLeft: number | null;
}

export interface GameState {
  round: RoundState | null;
  results: RoundResult[];
  score: number;
  streak: number;
  bestStreak: number;
  finished: boolean;
  total: number;
}

export interface JudgeInput {
  lonLat: [number, number];
  /** How generous a city click may be, in km (depends on current zoom). */
  cityToleranceKm: number;
}

export interface GameApi extends GameState {
  guess: (input: JudgeInput) => void;
  useHint: () => void;
  skip: () => void;
  next: () => void;
}

/* ------------------------------------------------------------------ judge */

interface Judgement {
  correct: boolean;
  hitName: string | null;
  distanceKm: number;
}

function judge(
  session: Session,
  core: CoreData,
  target: Target,
  input: JudgeInput,
): Judgement {
  const { lonLat } = input;
  const straightLine = distanceKm(lonLat, target.point);

  if (target.kind === 'city') {
    const nearest = findNearestCity(session.cities, lonLat);
    const correct = straightLine <= input.cityToleranceKm;
    return {
      correct,
      // Only name a rival city if the player was genuinely closer to it.
      hitName:
        !correct && nearest && nearest.city.id !== target.id && nearest.km < straightLine
          ? nearest.city.name
          : null,
      distanceKm: straightLine,
    };
  }

  const hit = findAreaAt(session.hitAreas, lonLat);

  if (target.kind === 'continent') {
    const country = hit && hit.properties.kind === 'country' ? hit : null;
    const continent = country?.properties.continent ?? null;
    const correct = continent === target.id;
    const continentName = continent ? core.continentById.get(continent)?.name : null;
    return {
      correct,
      hitName: correct ? null : (continentName ?? null),
      distanceKm: straightLine,
    };
  }

  const correct = hit?.properties.id === target.id;
  return {
    correct,
    hitName: correct || !hit ? null : hit.properties.name,
    // Clicking anywhere inside the right shape is a hit, so distance is only
    // ever used for near-miss feedback.
    distanceKm: straightLine,
  };
}

/* ------------------------------------------------------------------- hook */

export function useGame(
  session: Session | null,
  core: CoreData | null,
  onFinish?: (results: RoundResult[], score: number) => void,
): GameApi {
  const [index, setIndex] = useState(0);
  const [round, setRound] = useState<RoundState | null>(null);
  const [results, setResults] = useState<RoundResult[]>([]);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const advanceTimer = useRef<number | null>(null);

  /**
   * The live round, mirrored outside React state.
   *
   * Judging a guess has to read the round and then act on it, and acting means
   * appending a result, adding to the score and arming the auto-advance timer.
   * None of that may happen inside a `setRound` updater, because updaters must
   * be pure -- React runs them twice in development specifically to expose side
   * effects hidden in them. Reading from a ref keeps the judging outside that
   * machinery entirely.
   */
  const roundRef = useRef<RoundState | null>(null);
  const streakRef = useRef(0);

  const total = session?.targets.length ?? 0;
  const finished = !!session && index >= total;

  const clearAdvance = () => {
    if (advanceTimer.current !== null) {
      window.clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
  };

  /** Every write to the round goes through here, so the ref never drifts. */
  const commitRound = useCallback((next: RoundState | null) => {
    roundRef.current = next;
    setRound(next);
  }, []);

  /* Start (or restart) a session. */
  useEffect(() => {
    clearAdvance();
    setIndex(0);
    setResults([]);
    setScore(0);
    streakRef.current = 0;
    setStreak(0);
    setBestStreak(0);
  }, [session]);

  /* Spin up each round as the index moves. */
  useEffect(() => {
    const target = session?.targets[index];
    if (!session || !target) {
      commitRound(null);
      return;
    }
    commitRound({
      index,
      target,
      guesses: [],
      status: 'guessing',
      message: null,
      hintUsed: false,
      startedAt: Date.now(),
      secondsLeft: session.config.timeLimit,
    });
  }, [session, index, commitRound]);

  /* Optional countdown. */
  useEffect(() => {
    if (!round || round.status !== 'guessing' || round.secondsLeft === null) return;
    if (round.secondsLeft <= 0) return;
    const id = window.setTimeout(() => {
      const r = roundRef.current;
      if (r && r.status === 'guessing' && r.secondsLeft !== null) {
        commitRound({ ...r, secondsLeft: r.secondsLeft - 1 });
      }
    }, 1000);
    return () => window.clearTimeout(id);
  }, [round, commitRound]);

  const finishRound = useCallback(
    (r: RoundState, solved: boolean, points: number, message: string) => {
      clearAdvance();
      commitRound({ ...r, status: solved ? 'correct' : 'revealed', message });
      setResults((prev) => [
        ...prev,
        {
          target: r.target,
          guesses: r.guesses,
          points,
          solved,
          elapsedMs: Date.now() - r.startedAt,
        },
      ]);
      setScore((s) => s + points);
      if (solved) {
        // Tracked in a ref as well, so the next streak can be computed without
        // nesting one state update inside another's updater.
        const next = streakRef.current + 1;
        streakRef.current = next;
        setStreak(next);
        setBestStreak((b) => Math.max(b, next));
        // A correct answer gets a beat to celebrate, then moves on by itself.
        // Nothing clickable is shown during that beat — see GameScreen.
        advanceTimer.current = window.setTimeout(
          () => setIndex((i) => i + 1),
          AUTO_ADVANCE_MS,
        );
      } else {
        streakRef.current = 0;
        setStreak(0);
      }
    },
    [commitRound],
  );

  const guess = useCallback(
    (input: JudgeInput) => {
      if (!session || !core) return;
      const current = roundRef.current;
      if (!current || current.status !== 'guessing') return;

      const verdict = judge(session, core, current.target, input);
      const record: Guess = {
        verdict: verdict.correct ? 'correct' : 'wrong',
        hitName: verdict.hitName,
        distanceKm: verdict.distanceKm,
        at: input.lonLat,
      };
      const guesses = [...current.guesses, record];

      if (verdict.correct) {
        const attempts = guesses.length - 1;
        const base = POINTS_BY_ATTEMPT[Math.min(attempts, POINTS_BY_ATTEMPT.length - 1)];
        const bonus =
          attempts === 0 ? Math.min(streakRef.current, MAX_STREAK_BONUS) * STREAK_BONUS : 0;
        const penalty = current.hintUsed ? 0.5 : 1;
        finishRound(
          { ...current, guesses },
          true,
          Math.round((base + bonus) * penalty),
          correctText(attempts),
        );
        return;
      }

      if (guesses.length >= session.config.attempts) {
        finishRound({ ...current, guesses }, false, 0, revealText(current.target));
        return;
      }

      commitRound({ ...current, guesses, message: wrongText(current.target, record) });
    },
    [session, core, finishRound, commitRound],
  );

  /* Timeout = a gentle reveal, never a hard failure. */
  useEffect(() => {
    if (!round || round.status !== 'guessing') return;
    if (round.secondsLeft !== 0) return;
    finishRound(round, false, 0, "Time's up! Here it is.");
  }, [round, finishRound]);

  const useHint = useCallback(() => {
    const r = roundRef.current;
    if (r && r.status === 'guessing') commitRound({ ...r, hintUsed: true });
  }, [commitRound]);

  const skip = useCallback(() => {
    const r = roundRef.current;
    if (!r || r.status !== 'guessing') return;
    finishRound(r, false, 0, revealText(r.target));
  }, [finishRound]);

  const next = useCallback(() => {
    clearAdvance();
    setIndex((i) => i + 1);
  }, []);

  useEffect(() => () => clearAdvance(), []);

  const finishedRef = useRef(false);
  useEffect(() => {
    if (finished && !finishedRef.current) {
      finishedRef.current = true;
      onFinish?.(results, score);
    }
    if (!finished) finishedRef.current = false;
  }, [finished, results, score, onFinish]);

  return useMemo(
    () => ({
      round,
      results,
      score,
      streak,
      bestStreak,
      finished,
      total,
      guess,
      useHint,
      skip,
      next,
    }),
    [round, results, score, streak, bestStreak, finished, total, guess, useHint, skip, next],
  );
}
