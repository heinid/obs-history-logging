// Zoomable, pannable picture stage shared by the occlusion editor, the map
// exam surfaces and the read-only zoom modal. Scale 1 means "picture fitted
// into the host": wheel zooms around the cursor (down to 0.3× fit), dragging
// pans, double-click resets to fit.

const MIN_SCALE = 0.3;
const MAX_SCALE = 12;

export class MapStage {
	readonly wrap: HTMLElement;
	readonly stage: HTMLElement;
	readonly img: HTMLImageElement;
	private scale = 1;
	private tx = 0;
	private ty = 0;
	private fitW = 0;

	// onPress handles a primary-button press before panning kicks in;
	// returning true consumes the press (the editor draws/moves frames).
	constructor(
		host: HTMLElement,
		src: string,
		private onPress?: (e: MouseEvent) => boolean
	) {
		this.wrap = host.createDiv({ cls: "hl-occ-stage-wrap" });
		this.stage = this.wrap.createDiv({ cls: "hl-occ-stage" });
		this.img = this.stage.createEl("img", { cls: "hl-occ-img" });
		this.img.src = src;
		this.img.draggable = false;
		const settle = (): void => {
			if (this.fitW) {
				this.img.style.width = `${this.fitW}px`;
				this.applyTransform();
			} else this.fit();
		};
		if (this.img.complete) window.setTimeout(settle, 0);
		else this.img.addEventListener("load", settle, { once: true });
		this.applyTransform();
		this.wire();
	}

	fit(): void {
		if (!this.img.naturalWidth || !this.img.naturalHeight) return;
		const wrap = this.wrap.getBoundingClientRect();
		if (!wrap.width || !wrap.height) return;
		const fit = Math.min(
			wrap.width / this.img.naturalWidth,
			wrap.height / this.img.naturalHeight
		);
		this.fitW = this.img.naturalWidth * fit;
		this.img.style.width = `${this.fitW}px`;
		this.scale = 1;
		this.tx = (wrap.width - this.fitW) / 2;
		this.ty = (wrap.height - this.img.naturalHeight * fit) / 2;
		this.applyTransform();
	}

	private applyTransform(): void {
		this.stage.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
	}

	// Pointer position → image fractions, valid under any zoom because the
	// image rect itself carries the transform.
	toFrac(e: MouseEvent): { x: number; y: number } | null {
		const rect = this.img.getBoundingClientRect();
		if (!rect.width || !rect.height) return null;
		return {
			x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
			y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
		};
	}

	private wire(): void {
		this.wrap.addEventListener(
			"wheel",
			(e) => {
				e.preventDefault();
				const rect = this.wrap.getBoundingClientRect();
				const px = e.clientX - rect.left;
				const py = e.clientY - rect.top;
				const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
				const next = Math.min(
					MAX_SCALE,
					Math.max(MIN_SCALE, this.scale * factor)
				);
				if (next === this.scale) return;
				// Keep the point under the cursor fixed.
				this.tx = px - ((px - this.tx) / this.scale) * next;
				this.ty = py - ((py - this.ty) / this.scale) * next;
				this.scale = next;
				this.applyTransform();
			},
			{ passive: false }
		);
		this.wrap.addEventListener("dblclick", () => this.fit());
		this.wrap.addEventListener("mousedown", (e) => {
			if (e.button === 0 && this.onPress?.(e)) return;
			if (e.button === 0 || e.button === 1) this.startPan(e);
		});
	}

	private startPan(e: MouseEvent): void {
		e.preventDefault();
		const sx = e.clientX - this.tx;
		const sy = e.clientY - this.ty;
		trackDrag(
			(ev) => {
				this.tx = ev.clientX - sx;
				this.ty = ev.clientY - sy;
				this.applyTransform();
			},
			() => undefined
		);
	}
}

export function trackDrag(
	onMove: (e: MouseEvent) => void,
	onUp: (e: MouseEvent) => void
): void {
	const move = (e: MouseEvent): void => onMove(e);
	const up = (e: MouseEvent): void => {
		window.removeEventListener("mousemove", move);
		window.removeEventListener("mouseup", up);
		onUp(e);
	};
	window.addEventListener("mousemove", move);
	window.addEventListener("mouseup", up);
}
