import type { Gateway } from "./gateway.js";
import { Gio } from "./gi.js";
import { label } from "./ui.js";

export interface ChatUiPreferences {
  welcome?: { mode?: string; text?: string };
  nested_subagents_expanded?: boolean;
}

/** Main's empty-state copy is UI, never a history row or a model response. */
export class ChatWelcome {
  readonly widget = label("", "title-2");
  private readonly cancel = new Gio.Cancellable();
  private main = false;
  private complete = false;
  private content = false;
  private copy: string | undefined;
  private version = 0;
  private closed = false;

  constructor(private readonly gateway: Gateway, private readonly observed?: (prefs: ChatUiPreferences) => void) {
    this.widget.set_visible(false);
    this.widget.set_selectable(true);
    this.widget.set_margin_top(32);
    this.widget.set_margin_bottom(16);
  }

  setMain(main: boolean): void {
    this.main = main;
    this.version++;
    this.historyPending();
  }

  async refresh(): Promise<void> {
    if (this.closed) return;
    const version = ++this.version;
    try {
      const prefs = await this.gateway.json<ChatUiPreferences>(
        "GET", "/api/ui/preferences", undefined, undefined, false, this.cancel);
      if (this.closed || version !== this.version) return;
      this.observed?.(prefs);
      const welcome = prefs.welcome;
      this.copy = welcome?.mode === "default" ? "Ouroboros has awakened"
        : welcome?.mode === "custom" && typeof welcome.text === "string" && welcome.text.trim() ? welcome.text : undefined;
      this.render();
    } catch { /* A failed read keeps the last observed choice, as in the gateway. */ }
  }

  historyPending(): void { this.complete = false; this.render(); }
  historyRead(complete: boolean): void { this.complete = complete; this.render(); }
  setContent(content: boolean): void { this.content = content; this.render(); }

  close(): void {
    this.closed = true;
    this.cancel.cancel();
    this.widget.set_visible(false);
  }

  private render(): void {
    this.widget.set_label(this.copy ?? "");
    this.widget.set_visible(!this.closed && this.main && this.complete && !this.content && Boolean(this.copy));
  }
}
