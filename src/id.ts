// Generate globally-unique 8-char base36 ids for `{ev <id> ...}` markers.
// Layout: 4 time-based chars + 4 random chars, so ids are roughly sortable by
// creation time while staying collision-safe across a personal vault.

const ID_RE = /^[0-9a-z]{8}$/;

function rand4(): string {
	return Math.random().toString(36).slice(2).padEnd(4, "0").slice(0, 4);
}

export function generateId(taken?: (id: string) => boolean): string {
	for (let i = 0; i < 64; i++) {
		const time4 = Date.now().toString(36).slice(-4);
		const id = (time4 + rand4()).slice(0, 8);
		if (!taken || !taken(id)) return id;
	}
	// Extremely unlikely fallback.
	return (Date.now().toString(36) + rand4()).slice(-8);
}

export function isValidId(id: string): boolean {
	return ID_RE.test(id);
}
