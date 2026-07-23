import { Menu } from "obsidian";

// Right-click actions for selected text: copy and a web search, standing in
// for the browser context menu Electron doesn't provide.

export function currentSelection(): string {
	return window.getSelection()?.toString().trim() ?? "";
}

export function addSelectionItems(menu: Menu, sel: string): void {
	const short = sel.length > 24 ? sel.slice(0, 24) + "…" : sel;
	menu.addItem((i) =>
		i
			.setTitle("复制")
			.setIcon("copy")
			.onClick(() => void navigator.clipboard.writeText(sel))
	);
	menu.addItem((i) =>
		i
			.setTitle(`用 Google 搜索「${short}」`)
			.setIcon("search")
			.onClick(() =>
				window.open(
					"https://www.google.com/search?q=" +
						encodeURIComponent(sel)
				)
			)
	);
	menu.addSeparator();
}
