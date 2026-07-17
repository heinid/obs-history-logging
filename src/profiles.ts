// View profiles persisted in `_chronology/profiles.md`. A profile scopes and
// groups the timeline. Format mirrors events.md: `## <name>` + `key: value`.
//
//   ## All
//   groupBy: century
//
//   ## Japan (AD only)
//   match: #ad
//   groupBy: decade

export type GroupBy = "century" | "decade" | "none";

export interface Profile {
	name: string;
	match: string; // base query applied to every entry (empty = all)
	groupBy: GroupBy; // fallback grouping when no era system is applied
	eraSystem: string; // default era-system lens by name (empty = none)
}

export const PROFILES_HEADER = "# History Logging — profiles";

export const DEFAULT_PROFILE: Profile = {
	name: "All",
	match: "",
	groupBy: "century",
	eraSystem: "",
};

function isGroupBy(v: string): v is GroupBy {
	return v === "century" || v === "decade" || v === "none";
}

export function parseProfilesFile(content: string): Profile[] {
	const normalised = content.replace(/\r\n/g, "\n");
	const re = /^##\s+(.+?)\s*$/gm;
	const heads: { name: string; start: number; bodyStart: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(normalised)) !== null) {
		heads.push({ name: m[1], start: m.index, bodyStart: m.index + m[0].length });
	}
	const profiles: Profile[] = [];
	for (let i = 0; i < heads.length; i++) {
		const h = heads[i];
		const end = i + 1 < heads.length ? heads[i + 1].start : normalised.length;
		const block = normalised.slice(h.bodyStart, end);
		const profile: Profile = {
			name: h.name,
			match: "",
			groupBy: "century",
			eraSystem: "",
		};
		for (const line of block.split("\n")) {
			const kv = /^(\w+):\s*(.*)$/.exec(line.trim());
			if (!kv) continue;
			if (kv[1] === "match") profile.match = kv[2].trim();
			else if (kv[1] === "eraSystem") profile.eraSystem = kv[2].trim();
			else if (kv[1] === "groupBy" && isGroupBy(kv[2].trim()))
				profile.groupBy = kv[2].trim() as GroupBy;
		}
		profiles.push(profile);
	}
	return profiles.length ? profiles : [DEFAULT_PROFILE];
}

export function serializeProfilesFile(profiles: Profile[]): string {
	const parts: string[] = [PROFILES_HEADER, ""];
	for (const p of profiles) {
		parts.push(`## ${p.name}`);
		if (p.match) parts.push(`match: ${p.match}`);
		if (p.eraSystem) parts.push(`eraSystem: ${p.eraSystem}`);
		parts.push(`groupBy: ${p.groupBy}`);
		parts.push("");
	}
	return parts.join("\n").replace(/\n+$/, "\n");
}
