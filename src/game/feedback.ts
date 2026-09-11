import type { Guess, Target } from '../types';

/**
 * All the words the game says to the player.
 *
 * The tone matters more than it looks: a child who is wrong should learn
 * something ("that's Spain — France is just north-east") rather than simply be
 * told "no". Every miss therefore names what they *did* hit and nudges them in
 * the right direction.
 */

const PRAISE = [
  'Nice one!',
  'Spot on!',
  'Got it!',
  'Brilliant!',
  'Perfect!',
  'You nailed it!',
  'Bullseye!',
];

const FIRST_TRY_PRAISE = [
  'First try!',
  'Straight there!',
  'No hesitation!',
  'Textbook!',
];

function pick(list: string[]): string {
  return list[Math.floor(Math.random() * list.length)];
}

/** Compass direction from the guess towards the answer. */
export function bearingWord(from: [number, number], to: [number, number]): string {
  let dLon = to[0] - from[0];
  // Take the short way round the globe.
  if (dLon > 180) dLon -= 360;
  if (dLon < -180) dLon += 360;
  const dLat = to[1] - from[1];

  const parts: string[] = [];
  if (Math.abs(dLat) > 4) parts.push(dLat > 0 ? 'north' : 'south');
  if (Math.abs(dLon) > 4) parts.push(dLon > 0 ? 'east' : 'west');
  if (!parts.length) return 'right about there';
  return parts.join('-');
}

export function distanceWord(km: number): string {
  if (km < 60) return 'almost touching it';
  if (km < 250) return 'really close';
  if (km < 800) return 'not far off';
  if (km < 2500) return 'a fair way off';
  return 'a long way off';
}

export function formatKm(km: number): string {
  if (km < 10) return `${Math.round(km)} km`;
  if (km < 1000) return `${Math.round(km / 10) * 10} km`;
  return `${Math.round(km / 100) / 10}k km`;
}

export function correctMessage(attempts: number): string {
  if (attempts === 0) return `${pick(FIRST_TRY_PRAISE)} ${pick(PRAISE)}`;
  if (attempts === 1) return `${pick(PRAISE)} Second time lucky.`;
  return 'Got there in the end — that one counts.';
}

export function wrongMessage(target: Target, guess: Guess): string {
  const where = bearingWord(guess.at, target.point);
  const near = distanceWord(guess.distanceKm);

  if (guess.hitName) {
    if (where === 'right about there') {
      return `That's ${guess.hitName} — ${target.name} is tucked in right beside it.`;
    }
    return `That's ${guess.hitName}. ${target.name} is ${where} of there.`;
  }

  if (guess.distanceKm > 4000) {
    return `Whole different part of the world! Head ${where}.`;
  }
  return `You're ${near} — try a bit further ${where}.`;
}

export function revealMessage(target: Target): string {
  return `Here's ${target.name}. Have a good look — it might come up again.`;
}

/** End-of-game headline, keyed off accuracy rather than raw score. */
export function verdictFor(accuracy: number): { title: string; note: string; emoji: string } {
  if (accuracy >= 0.95)
    return {
      title: 'Perfect trip!',
      note: 'You found nearly everything first time. Try the next level up?',
      emoji: '\u{1F31F}',
    };
  if (accuracy >= 0.8)
    return {
      title: 'Seasoned traveller',
      note: 'Only a couple of wrong turns. Very sharp.',
      emoji: '\u{1F3C5}',
    };
  if (accuracy >= 0.6)
    return {
      title: 'Getting your bearings',
      note: 'Solid work. A few more trips and these will stick.',
      emoji: '\u{1F44F}',
    };
  if (accuracy >= 0.35)
    return {
      title: 'Well travelled soon',
      note: 'Tricky set! Turn on borders or drop a level and go again.',
      emoji: '\u{1F9ED}',
    };
  return {
    title: 'Everyone starts here',
    note: 'Try Continents first, or switch the helper labels on.',
    emoji: '\u{1F423}',
  };
}
