import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, wrapTextWithAnsi, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { Effect, Semaphore } from "effect";

/** User-authored text or an ordered set of choices. */
export type AnswerValue = string | string[];

/** A question or MCP field, with wire values separate from display labels. */
export interface AnswerField {
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
  readonly options?: readonly { value: string; label: string; description?: string; preview?: string }[];
  readonly multiple?: boolean;
  readonly allowCustom?: boolean;
  readonly required?: boolean;
  readonly initial?: AnswerValue;
  readonly validate?: (value: AnswerValue | undefined) => string | undefined;
}

/** One explicit submission; cancelled and declined forms never return partial answers. */
export type AnswerResult = { action: "accept"; values: Record<string, AnswerValue> } | { action: "cancel" | "decline" };

/** Presentation shared by agent questions and server-originated requests. */
export interface AnswerForm {
  readonly title: string;
  readonly message: string;
  readonly fields: readonly AnswerField[];
  readonly allowDecline?: boolean;
  readonly submitLabel?: string;
}

/** UI seam usable from Pi contexts and deterministic dialog tests. */
export type AnswerContext = {
  readonly hasUI: boolean;
  readonly mode?: ExtensionContext["mode"];
  readonly ui: Pick<ExtensionContext["ui"], "select" | "input" | "notify"> & Partial<Pick<ExtensionContext["ui"], "custom" | "confirm">>;
};

// One terminal input owner across concurrent MCP requests and question tools.
const inputOwner = Semaphore.makeUnsafe(1);

/** Serialize human input while retaining Effect interruption and UI cleanup. */
export function answerFormEffect(ctx: AnswerContext, form: AnswerForm) {
  return inputOwner.withPermits(1)(Effect.tryPromise({
    try: (signal) => ctx.mode === "tui" && ctx.ui.custom ? showForm(ctx, form, signal) : showDialogs(ctx, form, signal),
    catch: (error) => error,
  }));
}

async function showForm(ctx: AnswerContext, form: AnswerForm, signal: AbortSignal): Promise<AnswerResult> {
  signal.throwIfAborted();
  return await ctx.ui.custom!<AnswerResult>((tui, theme, keys, done) => {
    const cancel = () => done({ action: "cancel" });
    signal.addEventListener("abort", cancel, { once: true });
    const component = new AnswerFlow(tui, theme, keys, form, done);
    if (signal.aborted) queueMicrotask(cancel);
    return Object.assign(component, { dispose: () => signal.removeEventListener("abort", cancel) });
  }) ?? { action: "cancel" };
}

/** Keyboard-driven form with revisitable answers and an explicit submission page. */
export class AnswerFlow implements Focusable {
  private page = 0;
  private selected = 0;
  private scroll = 0;
  private editing = false;
  private error = "";
  private readonly input = new Input();
  private readonly values = new Map<string, AnswerValue>();
  private readonly drafts = new Map<string, string>();
  private _focused = false;

  /** Create one disposable interaction; no answers escape until submission. */
  constructor(private readonly tui: TUI, private readonly theme: Theme, private readonly keys: Pick<KeybindingsManager, "matches">,
    private readonly form: AnswerForm, private readonly done: (result: AnswerResult) => void) {
    for (const field of form.fields) if (field.initial !== undefined) this.values.set(field.id, structuredClone(field.initial));
    this.enterPage(0);
  }

  /** Forward terminal focus to the native input for IME positioning. */
  get focused() { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value && this.editing; }

  /** Consume form navigation without stealing ordinary text-editing keys. */
  handleInput(data: string): void {
    const field = this.form.fields[this.page];
    if (this.keys.matches(data, "tui.select.cancel")) {
      if (this.editing && field?.options?.length) { this.saveDraft(); this.editing = false; }
      else this.done({ action: "cancel" });
    } else if (matchesKey(data, "shift+tab") || matchesKey(data, "ctrl+left")) {
      this.saveDraft(); this.enterPage((this.page + this.form.fields.length) % (this.form.fields.length + 1));
    } else if (matchesKey(data, "tab") || matchesKey(data, "ctrl+right")) {
      this.saveDraft(); this.enterPage((this.page + 1) % (this.form.fields.length + 1));
    } else if (matchesKey(data, "ctrl+o") && field && !field.required) {
      this.values.delete(field.id); this.drafts.delete(field.id); this.advance();
    } else if (this.keys.matches(data, "tui.select.pageDown") || this.keys.matches(data, "tui.select.pageUp")) {
      this.scroll += this.keys.matches(data, "tui.select.pageDown") ? 5 : -5;
    } else if (this.editing && field) {
      if (this.keys.matches(data, "tui.input.submit")) {
        const text = this.input.getValue();
        const previous = this.values.get(field.id);
        const value = field.multiple && field.options?.length
          ? [...(Array.isArray(previous) ? previous.filter((v) => field.options!.some((o) => o.value === v)) : []), ...(text.trim() ? [text] : [])]
          : text;
        if (this.store(field, value)) this.advance();
      } else this.input.handleInput(data);
    } else if (this.keys.matches(data, "tui.select.up")) {
      this.selected = Math.max(0, this.selected - 1); this.scroll = 0;
    } else if (this.keys.matches(data, "tui.select.down")) {
      this.selected = Math.min(this.rowCount() - 1, this.selected + 1); this.scroll = 0;
    } else if (field && /^[1-9]$/.test(data) && Number(data) <= this.rowCount()) {
      this.selected = Number(data) - 1; this.choose(field, !field.multiple);
    } else if (field && matchesKey(data, "space") && field.multiple) {
      this.choose(field, false);
    } else if (this.keys.matches(data, "tui.select.confirm")) {
      if (!field) this.reviewAction();
      else this.choose(field, true);
    }
    this.input.focused = this._focused && this.editing;
    this.tui.requestRender();
  }

  /** Render a bounded, scrollable body with fixed progress and keyboard hints. */
  render(width: number): string[] {
    width = Math.max(1, width);
    const field = this.form.fields[this.page];
    const body: string[] = [];
    const add = (text: string) => body.push(...wrapTextWithAnsi(safeUiText(text), width));
    add(this.form.message);
    let anchor = 0;
    if (field) {
      add(`\n${field.label}${field.required ? " *" : " (optional)"}\n${field.prompt}`);
      if (field.options?.length) add(field.multiple ? "Select all that apply." : "Choose one.");
      for (const [index, option] of (field.options ?? []).entries()) {
        if (index === this.selected) anchor = body.length;
        const value = this.values.get(field.id);
        const checked = Array.isArray(value) ? value.includes(option.value) : value === option.value;
        add(`${index === this.selected ? "›" : " "} ${index + 1}. ${field.multiple ? (checked ? "[x]" : "[ ]") : (checked ? "●" : "○")} ${option.label}`);
        if (option.description) add(`    ${option.description}`);
        if (index === this.selected && option.preview) add(option.preview);
      }
      if (field.allowCustom && field.options?.length) {
        if (this.selected === field.options.length) anchor = body.length;
        add(`${this.selected === field.options.length ? "›" : " "} ${field.options.length + 1}. Other — type your answer`);
      }
      if (this.editing) {
        anchor = body.length;
        body.push(...this.input.render(width));
      }
    } else {
      add("\nReview your answers — Enter on an answer to edit");
      this.form.fields.forEach((item, index) => {
        if (index === this.selected) anchor = body.length;
        const value = this.values.get(item.id);
        const labels = (Array.isArray(value) ? value : value === undefined ? [] : [value])
          .map((v) => item.options?.find((o) => o.value === v)?.label ?? v);
        add(`${index === this.selected ? "›" : " "} ${item.label}: ${labels.length ? labels.join(", ") : "(not answered)"}`);
      });
      if (this.selected === this.form.fields.length) anchor = body.length;
      add(`${this.selected === this.form.fields.length ? "›" : " "} ${this.form.submitLabel ?? "Submit answers"}`);
      if (this.form.allowDecline) {
        if (this.selected === this.form.fields.length + 1) anchor = body.length;
        add(`${this.selected === this.form.fields.length + 1 ? "›" : " "} Decline request`);
      }
    }
    const height = Math.max(1, (this.tui.terminal.rows ?? 24) - 7);
    const base = Math.max(0, anchor - height + 2);
    const start = Math.max(0, Math.min(Math.max(0, body.length - height), base + this.scroll));
    this.scroll = start - base;
    const progress = this.form.fields.map((f, i) => `${i === this.page ? "›" : ""}${this.values.has(f.id) ? "✓" : "○"} ${f.label}`).join("  ");
    return [
      this.theme.fg("accent", truncateToWidth(safeUiText(this.form.title), width)),
      truncateToWidth(safeUiText(`${progress}  ${field ? "" : "›"}Review`), width),
      this.theme.fg("borderMuted", "─".repeat(width)),
      ...body.slice(start, start + height),
      this.theme.fg("error", truncateToWidth(safeUiText(this.error), width)),
      this.theme.fg("dim", truncateToWidth(`Esc cancel • Enter ${this.editing ? "save" : field?.multiple ? "continue" : "confirm"} • Tab/Shift+Tab next/back`, width)),
      this.theme.fg("dim", truncateToWidth(`${start + 1}–${Math.min(body.length, start + height)}/${body.length} • PgUp/Dn scroll${field?.multiple ? " • Space/number toggle" : field?.options?.length ? " • ↑↓/number choose" : ""}${field && !field.required ? " • Ctrl+O omit" : ""}`, width)),
    ].map((line) => truncateToWidth(line, width));
  }

  /** Native input owns its render cache; all other styling is computed live. */
  invalidate(): void { this.input.invalidate(); }

  private rowCount() {
    const field = this.form.fields[this.page];
    return field ? (field.options?.length ?? 0) + (field.allowCustom ? 1 : 0) : this.form.fields.length + 1 + (this.form.allowDecline ? 1 : 0);
  }

  private saveDraft() {
    const field = this.form.fields[this.page];
    if (field && this.editing) {
      const value = this.values.get(field.id);
      const previous = typeof value === "string" ? value : Array.isArray(value) ? value.find((v) => !field.options?.some((o) => o.value === v)) : undefined;
      if (this.input.getValue() === (previous ?? "")) this.drafts.delete(field.id);
      else this.drafts.set(field.id, this.input.getValue());
    }
  }

  private enterPage(page: number) {
    this.page = page; this.selected = page === this.form.fields.length ? page : 0; this.scroll = 0; this.error = "";
    const field = this.form.fields[page];
    this.editing = !!field && !field.options?.length;
    const value = field && this.values.get(field.id);
    if (field?.options && typeof value === "string") this.selected = Math.max(0, field.options.findIndex((option) => option.value === value));
    this.input.setValue(field ? this.drafts.get(field.id) ?? (typeof value === "string" ? value : "") : "");
    this.input.focused = this._focused && this.editing;
  }

  private advance() { this.enterPage(Math.min(this.form.fields.length, this.page + 1)); }

  private store(field: AnswerField, value: AnswerValue | undefined) {
    const error = validateAnswer(field, value);
    if (error) { this.error = error; return false; }
    if (value === undefined) this.values.delete(field.id); else this.values.set(field.id, value);
    this.drafts.delete(field.id); this.error = ""; return true;
  }

  private choose(field: AnswerField, advance: boolean) {
    const option = field.options?.[this.selected];
    if (!option && field.allowCustom) {
      this.editing = true;
      const value = this.values.get(field.id);
      const custom = (Array.isArray(value) ? value : value === undefined ? [] : [value]).find((v) => !field.options?.some((o) => o.value === v));
      this.input.setValue(this.drafts.get(field.id) ?? custom ?? "");
      return;
    }
    if (field.multiple) {
      if (advance) { if (this.store(field, this.values.get(field.id) ?? [])) this.advance(); }
      else if (option) {
        const value = this.values.get(field.id);
        const selected = Array.isArray(value) ? value : [];
        this.values.set(field.id, selected.includes(option.value) ? selected.filter((v) => v !== option.value) : [...selected, option.value]);
      }
    } else if (option && this.store(field, option.value)) this.advance();
  }

  private reviewAction() {
    if (this.selected < this.form.fields.length) { this.enterPage(this.selected); return; }
    if (this.selected > this.form.fields.length) { this.done({ action: "decline" }); return; }
    for (const [index, field] of this.form.fields.entries()) {
      const error = validateAnswer(field, this.values.get(field.id));
      if (error || this.drafts.has(field.id)) { this.enterPage(index); this.error = error ?? "Confirm your edited answer with Enter."; return; }
    }
    this.done({ action: "accept", values: Object.fromEntries(this.values) });
  }
}

/** Validate required answers before allowing review submission. */
export function validateAnswer(field: AnswerField, value: AnswerValue | undefined): string | undefined {
  if (field.required && (value === undefined || (!field.validate && (typeof value === "string" ? !value.trim() : value.length === 0)))) return `${field.label} is required.`;
  if (value !== undefined && field.options?.length && !field.allowCustom) {
    const values = Array.isArray(value) ? value : [value];
    if (values.some((v) => !field.options!.some((o) => o.value === v))) return "Choose one of the provided options.";
  }
  return field.validate?.(value);
}

/** Strip terminal control bytes from remote/user content, preserving ordinary newlines. */
export function safeUiText(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

async function showDialogs(ctx: AnswerContext, form: AnswerForm, signal: AbortSignal): Promise<AnswerResult> {
  if (!ctx.hasUI) return { action: "decline" };
  const values = new Map<string, AnswerValue>();
  for (const field of form.fields) {
    while (true) {
      signal.throwIfAborted();
      const title = `${form.title}\n${form.message}\n${field.label}: ${field.prompt}`;
      let value: AnswerValue | undefined;
      if (field.options?.length && !field.multiple) {
        const choices = field.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`);
        const other = "Other — type your answer";
        const omit = "Omit optional answer";
        const selected = await ctx.ui.select(title, [...choices, ...(field.allowCustom ? [other] : []), ...(!field.required ? [omit] : [])], { signal });
        if (selected === undefined) return { action: "cancel" };
        if (selected === omit) break;
        value = selected === other ? await ctx.ui.input(title, "Your answer", { signal }) : field.options[choices.indexOf(selected)]?.value;
      } else {
        const hint = field.multiple ? `JSON array of choices: ${field.options?.map((o) => o.value).join(", ") ?? "strings"}` : String(field.initial ?? "Your answer");
        const input = await ctx.ui.input(title, hint, { signal });
        if (input === undefined) return { action: "cancel" };
        if (!input && !field.required) break;
        if (field.multiple) {
          try {
            const parsed: unknown = JSON.parse(input);
            if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) throw new Error();
            value = parsed;
          } catch { ctx.ui.notify("Enter a JSON array of strings.", "error"); continue; }
        } else value = input;
      }
      if (value === undefined) return { action: "cancel" };
      const error = validateAnswer(field, value);
      if (error) { ctx.ui.notify(error, "error"); continue; }
      values.set(field.id, value); break;
    }
  }
  const answers = Object.fromEntries(values);
  const decision = await ctx.ui.select(`${form.title}\n${form.message}\nReview: ${JSON.stringify(answers, null, 2)}`, [form.submitLabel ?? "Submit answers", ...(form.allowDecline ? ["Decline request"] : [])], { signal });
  signal.throwIfAborted();
  return decision === (form.submitLabel ?? "Submit answers") ? { action: "accept", values: answers }
    : decision === "Decline request" && form.allowDecline ? { action: "decline" } : { action: "cancel" };
}
