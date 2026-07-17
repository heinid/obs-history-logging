// Pure text helpers for map images — kept free of Obsidian imports so the
// verify script can exercise them outside the app.

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

// `![[path]]` / `![[path|300]]` / `![[path|alt]]` image embeds in `text`.
export function imageEmbeds(text: string): string[] {
	const out: string[] = [];
	const re = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const link = m[1].trim();
		if (IMAGE_EXT.test(link) && !out.includes(link)) out.push(link);
	}
	return out;
}

// Rewrite the width suffix of the embed `![[link…]]` found nearest `around`
// in `text`; returns null when no matching embed is found.
export function resizeEmbedIn(
	text: string,
	link: string,
	width: number,
	around = 0
): { text: string; from: number; to: number } | null {
	const esc = link.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`!\\[\\[${esc}(\\|[^\\]]*)?\\]\\]`, "g");
	let best: RegExpExecArray | null = null;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		if (
			!best ||
			Math.abs(m.index - around) < Math.abs(best.index - around)
		)
			best = m;
	}
	if (!best) return null;
	const replacement = `![[${link}|${width}]]`;
	return {
		text:
			text.slice(0, best.index) +
			replacement +
			text.slice(best.index + best[0].length),
		from: best.index,
		to: best.index + best[0].length,
	};
}
