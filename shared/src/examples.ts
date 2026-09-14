/**
 * The workflows Joseki ships with.
 *
 * They live in the Examples folder, and they are files there like any other:
 * open one and edit it, and the edit is kept; delete one, and it stays
 * deleted. They are put there once — when a database is created, and by the
 * migration that introduced folders — not on every start, so a folder
 * cleared on purpose does not fill back up. To have them again, the server
 * restores whichever are missing on request — **Restore** in the Open
 * dialog's footer asks for exactly that.
 */

import type { Workflow } from './index';
import { CONTENT_REVIEW_PIPELINE_ID, createExampleWorkflow } from './exampleWorkflow';
import { TRANSLATION_ROUND_TRIP_ID, createTranslationRoundTrip } from './translationRoundTrip';
import { BEST_OF_FOUR_ID, createBestOfFour } from './bestOfFour';

export { CONTENT_REVIEW_PIPELINE_ID, TRANSLATION_ROUND_TRIP_ID, BEST_OF_FOUR_ID };
export { createTranslationRoundTrip } from './translationRoundTrip';
export { createBestOfFour } from './bestOfFour';

/** The ids the shipped examples are stored under. Stable across versions. */
export const SHIPPED_EXAMPLE_IDS: readonly string[] = [
  CONTENT_REVIEW_PIPELINE_ID,
  TRANSLATION_ROUND_TRIP_ID,
  BEST_OF_FOUR_ID
];

/** Fresh copies of every shipped example, each already placed in the Examples folder. */
export function shippedExamples(): Workflow[] {
  return [createExampleWorkflow(), createTranslationRoundTrip(), createBestOfFour()];
}
