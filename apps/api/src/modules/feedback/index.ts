// The feedback module's only public entry (apps/api/AGENTS.md): product feedback
// (CT-26q submitProductFeedback, B1-28p) and its deletion cleanup step.
export { deleteFeedbackForUser } from './application/deletion.ts';
export type { FeedbackDeletionInput } from './application/deletion.ts';
