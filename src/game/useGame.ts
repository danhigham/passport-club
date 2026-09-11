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

/** Points for solving a round, by how many wrong guesses came first. */
const POINTS_BY_ATTEMPT = [100, 70, 40];
const MAX_ATTEMPTS = 3;
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

  const total = session?.targets.length ?? 0;
  const finished = !!session && index >= total;

  const clearAdvance = () => {
    if (advanceTimer.current !== null) {
      window.clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
  };

  /* Start (or restart) a session. */
  useEffect(() => {
    clearAdvance();
    setIndex(0);
    setResults([]);
    setScore(0);
    setStreak(0);
    setBestStreak(0);
  }, [session]);

  /* Spin up each round as the index moves. */
  useEffect(() => {
    if (!session) {
      setRound(null);
      return;
    }
    const target = session.targets[index];
    if (!target) {
      setRound(null);
      return;
    }
    setRound({
      index,
      target,
      guesses: [],
      status: 'guessing',
      message: null,
      hintUsed: false,
      startedAt: Date.now(),
      secondsLeft: session.config.timeLimit,
    });
  }, [session, index]);

  /* Optional countdown. */
  useEffect(() => {
    if (!round || round.status !== 'guessing' || round.secondsLeft === null) return;
    if (round.secondsLeft <= 0) return;
    const id = window.setTimeout(() => {
      setRound((r) =>
        r && r.status === 'guessing' && r.secondsLeft !== null
          ? { ...r, secondsLeft: r.secondsLeft - 1 }
          : r,
      );
    }, 1000);
    return () => window.clearTimeout(id);
  }, [round]);

  const finishRound = useCallback(
    (r: RoundState, solved: boolean, points: number, message: string) => {
      clearAdvance();
      setRound({ ...r, status: solved ? 'correct' : 'revealed', message });
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
        setStreak((s) => {
          const next = s + 1;
          setBestStreak((b) => Math.max(b, next));
          return next;
        });
        // A correct answer gets a beat to celebrate, then moves on by itself.
        // Nothing clickable is shown during that beat — see GameScreen.
        advanceTimer.current = window.setTimeout(
          () => setIndex((i) => i + 1),
          AUTO_ADVANCE_MS,
        );
      } else {
        setStreak(0);
      }
    },
    [],
  );

  const guess = useCallback(
    (input: JudgeInput) => {
      if (!session || !core) return;
      setRound((current) => {
        if (!current || current.status !== 'guessing') return current;

        const verdict = judge(session, core, current.target, input);
        const record: Guess = {
          verdict: verdict.correct ? 'correct' : 'wrong',
          hitName: verdict.hitName,
          distanceKm: verdict.distanceKm,
          at: input.lonLat,
        };
        const guesses = [...current.guesses, record];

        // Deferred so we're not calling setState inside another setState.
        queueMicrotask(() => {
          if (verdict.correct) {
            const attempts = guesses.length - 1;
            const base = POINTS_BY_ATTEMPT[Math.min(attempts, POINTS_BY_ATTEMPT.length - 1)];
            const bonus =
              attempts === 0 ? Math.min(streak, MAX_STREAK_BONUS) * STREAK_BONUS : 0;
            const penalty = current.hintUsed ? 0.5 : 1;
            finishRound(
              { ...current, guesses },
              true,
              Math.round((base + bonus) * penalty),
              correctText(attempts),
            );
          } else if (guesses.length >= MAX_ATTEMPTS) {
            finishRound({ ...current, guesses }, false, 0, revealText(current.target));
          }
        });

        if (verdict.correct || guesses.length >= MAX_ATTEMPTS) {
          return { ...current, guesses };
        }
        return { ...current, guesses, message: wrongText(current.target, record) };
      });
    },
    [session, core, streak, finishRound],
  );

  /* Timeout = a gentle reveal, never a hard failure. */
  useEffect(() => {
    if (!round || round.status !== 'guessing') return;
    if (round.secondsLeft !== 0) return;
    finishRound(round, false, 0, "Time's up! Here it is.");
  }, [round, finishRound]);

  const useHint = useCallback(() => {
    setRound((r) => (r && r.status === 'guessing' ? { ...r, hintUsed: true } : r));
  }, []);

  const skip = useCallback(() => {
    setRound((r) => {
      if (!r || r.status !== 'guessing') return r;
      queueMicrotask(() => finishRound(r, false, 0, revealText(r.target)));
      return r;
    });
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
