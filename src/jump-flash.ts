import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";

// A transient "breathing" highlight painted over the jumped-to range so the
// target tag pulses for a few seconds and is hard to miss. Applied as a real
// CodeMirror mark decoration (not a DOM hack) so it survives re-renders and
// works in both source and live-preview modes.

export const jumpFlashEffect = StateEffect.define<{
	from: number;
	to: number;
} | null>();

const breatheMark = Decoration.mark({ class: "hl-jump-breathe" });

export const jumpFlashField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(deco, tr) {
		deco = deco.map(tr.changes);
		for (const e of tr.effects) {
			if (!e.is(jumpFlashEffect)) continue;
			deco =
				e.value && e.value.to > e.value.from
					? Decoration.set([breatheMark.range(e.value.from, e.value.to)])
					: Decoration.none;
		}
		return deco;
	},
	provide: (f) => EditorView.decorations.from(f),
});

export const JUMP_FLASH_MS = 6000;

export function flashJumpTarget(
	cm: EditorView,
	from: number,
	to: number
): void {
	const clamp = (n: number) => Math.max(0, Math.min(n, cm.state.doc.length));
	cm.dispatch({ effects: jumpFlashEffect.of({ from: clamp(from), to: clamp(to) }) });
	window.setTimeout(() => {
		cm.dispatch({ effects: jumpFlashEffect.of(null) });
	}, JUMP_FLASH_MS);
}
