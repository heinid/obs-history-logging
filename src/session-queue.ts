// Ordered queue of a recitation session. Pure so the interjection rules are
// testable outside Obsidian.
//
// A session snapshots its cards up front; cards of the same deck coming off
// a short wait while the session runs are interjected right after the
// current card (earliest due first) instead of waiting for an alarm.

export interface SessionQueueState {
	ids: string[];
	index: number; // position of the card being shown
}

// Insert `due` (id + ISO due time) after the current card. Multiple arrivals
// order by due time within the interjected block; an id still waiting later
// in the queue is moved forward instead of duplicated; an id already
// answered this round re-enters (the forgot → retry loop closes inside the
// session); only the card currently on screen is left alone.
export function interject(
	state: SessionQueueState,
	due: { id: string; due: string }[]
): SessionQueueState {
	const fresh = due.filter(
		(d, i) =>
			due.findIndex((x) => x.id === d.id) === i &&
			d.id !== state.ids[state.index]
	);
	if (!fresh.length) return state;
	const head = state.ids.slice(0, state.index + 1);
	const rest = state.ids
		.slice(state.index + 1)
		.filter((id) => !fresh.some((d) => d.id === id));
	const block = [...fresh]
		.sort((a, b) => a.due.localeCompare(b.due))
		.map((d) => d.id);
	return { ids: [...head, ...block, ...rest], index: state.index };
}

// Drop upcoming cards that no longer qualify (e.g. answered in another
// window); the current and past cards stay for accurate counts.
export function pruneUpcoming(
	state: SessionQueueState,
	keep: (id: string) => boolean
): SessionQueueState {
	const head = state.ids.slice(0, state.index + 1);
	const rest = state.ids.slice(state.index + 1).filter(keep);
	return { ids: [...head, ...rest], index: state.index };
}

export function shuffle<T>(items: T[]): T[] {
	const result = [...items];
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[result[i], result[j]] = [result[j], result[i]];
	}
	return result;
}
