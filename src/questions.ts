import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { Type, type Static } from "typebox";
import { answerFormEffect, safeUiText, type AnswerField } from "./answer-flow.js";

const QuestionParams = Type.Object({
  questions: Type.Array(Type.Object({
    question: Type.String({ minLength: 1, maxLength: 2000, description: "Full question text, unique within this request." }),
    header: Type.String({ minLength: 1, maxLength: 12, description: "Short question tab label." }),
    options: Type.Array(Type.Object({
      label: Type.String({ minLength: 1, maxLength: 200 }),
      description: Type.String({ maxLength: 2000 }),
      preview: Type.Optional(Type.String({ maxLength: 4000, description: "Optional plain-text/ASCII preview; never executable HTML." })),
    }), { minItems: 2, maxItems: 4 }),
    multiSelect: Type.Boolean(),
  }), { minItems: 1, maxItems: 4 }),
});

/** Claude AskUserQuestion-compatible input contract. */
export type QuestionInput = Static<typeof QuestionParams>;

type QuestionDetails = { status: string; questions: QuestionInput["questions"]; answers: Record<string, string | string[]> };

/** Turn questions into form fields, rejecting ambiguous result keys and choices. */
export function questionFields(input: QuestionInput): AnswerField[] {
  if (new Set(input.questions.map((q) => q.question)).size !== input.questions.length) throw new Error("Question text must be unique.");
  return input.questions.map((q) => {
    if (!q.question.trim() || !q.header.trim() || q.options.some((o) => !o.label.trim())) throw new Error("Questions, headers, and option labels must not be blank.");
    if (new Set(q.options.map((o) => o.label)).size !== q.options.length) throw new Error("Option labels must be unique within each question.");
    return {
      id: q.question, label: q.header, prompt: q.question,
      options: q.options.map((o) => ({ ...o, value: o.label })),
      multiple: q.multiSelect, allowCustom: true, required: true,
      validate: (value) => {
        const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
        if (values.length === 0) return "Select at least one answer.";
        if (values.some((v) => v.length > 4000)) return "Keep each answer within 4,000 characters.";
        if (values.some((v) => !v.trim())) return "Answers must not be blank.";
        if (values.length > 5) return "Choose up to four options and one custom answer.";
        if (new Set(values).size !== values.length) return "Choose each answer only once.";
        return undefined;
      },
    };
  });
}

/** Register the standalone human-question tool alongside the MCP extension. */
export default function questionsExtension(pi: ExtensionAPI) {
  let lifetime = new AbortController();
  pi.on("session_start", async () => { lifetime.abort(); lifetime = new AbortController(); });
  pi.on("session_shutdown", async () => { lifetime.abort(); });
  pi.registerTool<typeof QuestionParams, QuestionDetails>({
    name: "ask_user_question",
    label: "Ask user",
    description: "Ask 1–4 clarifying questions with 2–4 described options each. Supports multiple selections and custom answers. Answers are returned only after user review. Unavailable in print/JSON mode.",
    promptSnippet: "Ask the user structured clarifying questions",
    promptGuidelines: [
      "Use ask_user_question for consequential ambiguities or user preferences, not facts you can inspect with tools.",
      "For ask_user_question, put a recommended option first and suffix its label with (Recommended); explain the trade-off in its description. Do not add an Other option—the UI supplies it.",
      "If ask_user_question is cancelled or unavailable, do not invent answers or repeatedly reopen the same questions.",
    ],
    parameters: QuestionParams,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const requestSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      requestSignal.throwIfAborted();
      const fields = questionFields(params);
      if (!ctx.hasUI) return {
        content: [{ type: "text", text: "Question UI unavailable in print/JSON mode. Ask in conversation instead; no answers were collected." }],
        details: { status: "unavailable", questions: params.questions, answers: {} },
      };
      const result = await Effect.runPromise(answerFormEffect(ctx, {
        title: "Questions", message: "Choose your answers. Nothing is sent until you review and submit.", fields,
      }), { signal: requestSignal });
      const answers = result.action === "accept" ? result.values : {};
      const status = result.action === "accept" ? "answered" : "cancelled";
      return {
        content: [{ type: "text", text: status === "answered" ? JSON.stringify({ answers }) : "User cancelled; no answers submitted." }],
        details: { status, questions: params.questions, answers },
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("Questions ")) + theme.fg("muted", `${args.questions?.length ?? 0} to answer`), 0, 0);
    },
    renderResult(result, { isPartial, expanded }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Waiting for your answers…"), 0, 0);
      if (result.details?.status !== "answered") return new Text(theme.fg("warning", result.details?.status ?? "No answers"), 0, 0);
      const lines = Object.entries(result.details.answers).map(([question, value]) => `${question}\n  → ${Array.isArray(value) ? value.join(", ") : value}`);
      return new Text(safeUiText(expanded ? lines.join("\n") : `✓ ${lines.length} answer${lines.length === 1 ? "" : "s"} submitted — expand to review`), 0, 0);
    },
  });
}
