import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const name = "novel-continue";
const inject = ["tools", "fs", "subagents", "workingDirectory"];
const DEFAULT_STAGES = {
  analyze: { model: "deepseek-v4-pro", fallbackModel: "deepseek-flash", reasoningEffort: "high", maxTokens: 16e3 },
  plan: { model: "deepseek-v4-pro", fallbackModel: "deepseek-flash", reasoningEffort: "high", maxTokens: 24e3 },
  write: { model: "deepseek-v4-pro", fallbackModel: "deepseek-flash", reasoningEffort: "high", maxTokens: 16e3 },
  review: { model: "deepseek-flash", fallbackModel: "deepseek-v4-pro", reasoningEffort: "low", maxTokens: 8e3 },
  revise: { model: "deepseek-v4-pro", fallbackModel: "deepseek-flash", reasoningEffort: "high", maxTokens: 16e3 },
  memo: { model: "deepseek-flash", fallbackModel: "deepseek-v4-pro", reasoningEffort: "low", maxTokens: 8e3 }
};
const PLUGIN_PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
const pad = (n) => String(n).padStart(2, "0");
function countChars(text) {
  return text.replace(/\s/g, "").length;
}
function splitChapters(raw) {
  const re = /^\s*第\s*(\d+)\s*章[^\n]*$/gm;
  const marks = [...raw.matchAll(re)];
  return marks.map((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : raw.length;
    return { number: Number(m[1]), body: normalizeProse(raw.slice(start, end)) };
  });
}
function normalizeProse(text) {
  return text.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !/^[（(]?全文完[)）]?$/.test(l)).join("\n\n").trim();
}
function parsePlan(md) {
  const blocks = md.split(/^##\s+/m).slice(1);
  const out = [];
  for (const block of blocks) {
    const [head, ...lines] = block.split("\n");
    const m = head.match(/第\s*(\d+)\s*章\s*(.*)$/);
    if (!m) continue;
    const beats = [];
    let hook = "";
    let additions = "";
    for (const line of lines) {
      const t = line.trim();
      if (/^[-*]\s+/.test(t)) beats.push(t.replace(/^[-*]\s+/, ""));
      else if (/^钩子[:：]/.test(t)) hook = t.replace(/^钩子[:：]\s*/, "");
      else if (/^新增[:：]/.test(t)) additions = t.replace(/^新增[:：]\s*/, "");
    }
    out.push({ number: Number(m[1]), title: m[2].trim(), beats, hook, additions });
  }
  return out.sort((a, b) => a.number - b.number);
}
function renderPlanned(c) {
  return [
    `## \u7B2C${pad(c.number)}\u7AE0 ${c.title}`.trimEnd(),
    ...c.beats.map((b) => `- ${b}`),
    `\u94A9\u5B50\uFF1A${c.hook || "\u65E0"}`,
    `\u65B0\u589E\uFF1A${c.additions || "\u65E0"}`
  ].join("\n");
}
function mergePlans(existing, incoming) {
  const map = new Map(existing.map((c) => [c.number, c]));
  for (const c of incoming) map.set(c.number, c);
  return [...map.values()].sort((a, b) => a.number - b.number);
}
function repeatRatio(text, reference, n = 8) {
  const a = text.replace(/\s/g, "");
  const b = reference.replace(/\s/g, "");
  if (a.length < n || b.length < n) return 0;
  const ref = /* @__PURE__ */ new Set();
  for (let i = 0; i + n <= b.length; i++) ref.add(b.slice(i, i + n));
  let hit = 0;
  let total = 0;
  for (let i = 0; i + n <= a.length; i++) {
    total++;
    if (ref.has(a.slice(i, i + n))) hit++;
  }
  return total === 0 ? 0 : hit / total;
}
function getSection(md, heading) {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, "m");
  const m = md.match(re);
  if (!m || m.index === void 0) return "";
  const rest = md.slice(m.index + m[0].length);
  const next = rest.search(/^##\s+/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}
function setSection(md, heading, body) {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, "m");
  const m = md.match(re);
  const block = `## ${heading}
${body.trim()}
`;
  if (!m || m.index === void 0) return `${md.trimEnd()}

${block}`;
  const head = md.slice(0, m.index);
  const rest = md.slice(m.index + m[0].length);
  const next = rest.search(/^##\s+/m);
  const tail = next === -1 ? "" : rest.slice(next);
  return `${head}${block}${tail ? `
${tail}` : ""}`;
}
function upsertSummary(md, chapter, summary) {
  const body = getSection(md, "\u5DF2\u5199\u7AE0\u8282\u6458\u8981");
  const line = `\u7B2C${pad(chapter)}\u7AE0\uFF1A${summary.replace(/\s+/g, " ").trim()}`;
  const lines = body.split("\n").filter((l) => l.trim() && !l.trim().replace(/^[-*]\s*/, "").startsWith(`\u7B2C${pad(chapter)}\u7AE0`));
  lines.push(line);
  lines.sort((a, b) => Number(a.match(/第(\d+)章/)?.[1] ?? 0) - Number(b.match(/第(\d+)章/)?.[1] ?? 0));
  return setSection(md, "\u5DF2\u5199\u7AE0\u8282\u6458\u8981", lines.join("\n"));
}
function fillTemplate(template, vars) {
  return template.replace(/\{\{([^{}]+)\}\}/g, (all, key) => {
    const v = vars[key.trim()];
    return v === void 0 ? all : String(v);
  });
}
const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["pass", "revise"] },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          item: { type: "string", enum: ["\u8D8A\u754C\u8DD1\u504F", "\u91CD\u590D", "\u4EBA\u7269\u4E0E\u8BBE\u5B9A", "AI\u5473", "\u5B57\u6570"] },
          problem: { type: "string" },
          fix: { type: "string" }
        },
        required: ["item", "problem", "fix"]
      }
    }
  },
  required: ["verdict", "issues"]
};
const MEMO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    characters: { type: "string" },
    threads: { type: "string" }
  },
  required: ["summary", "characters", "threads"]
};
const textTool = () => ({
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { report: { type: "string" } },
    required: ["report"]
  },
  render: (_args, v) => [{ type: "text", text: v.report }]
});
function apply(ctx, config = {}) {
  const cfg = {
    provider: config.provider ?? "deepseek-official",
    subagentProvider: config.subagentProvider ?? "spawn",
    nodePreset: config.nodePreset ?? "novel-node",
    promptsDir: config.promptsDir ?? PLUGIN_PROMPTS_DIR,
    chapterChars: config.chapterChars ?? 1e3,
    recentChapters: config.recentChapters ?? 3,
    minCharsRatio: config.minCharsRatio ?? 0.7,
    maxCharsRatio: config.maxCharsRatio ?? 1.4,
    maxRepeatRatio: config.maxRepeatRatio ?? 0.15
  };
  const stages = { ...DEFAULT_STAGES };
  for (const [k, v] of Object.entries(config.stages ?? {})) {
    stages[k] = { ...stages[k], ...v };
  }
  async function bookDir(exec) {
    if (!exec?.agent) throw new Error("novel \u5DE5\u5177\u9700\u8981\u7531 Agent \u8C03\u7528\uFF08exec.agent \u7F3A\u5931\uFF09");
    const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
    const target = await ctx.fs.resolve(".", { cwd, signal: exec.signal });
    return ctx.fs.processPath(target);
  }
  const paths = (dir) => ({
    original: join(dir, "\u539F\u6587.txt"),
    memo: join(dir, "\u5907\u5FD8.md"),
    plan: join(dir, "\u5267\u60C5\u70B9.md"),
    direction: join(dir, "\u7EED\u5199\u65B9\u5411.md"),
    prose: join(dir, "\u6B63\u6587"),
    chapter: (n) => join(dir, "\u6B63\u6587", `\u7B2C${pad(n)}\u7AE0.md`),
    state: join(dir, "state"),
    book: join(dir, "state", "book.json"),
    review: (n) => join(dir, "state", "reviews", `${pad(n)}.json`),
    reviewHistory: (n) => join(dir, "state", "reviews", `${pad(n)}-${Date.now()}.json`),
    check: (n) => join(dir, "state", "checks", `${pad(n)}.json`),
    drafts: join(dir, "state", "drafts"),
    calls: join(dir, "state", "calls.jsonl"),
    exported: join(dir, "\u6210\u7A3F.txt")
  });
  async function readText(file) {
    return existsSync(file) ? readFile(file, "utf8") : "";
  }
  async function writeText(file, text) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text.endsWith("\n") ? text : `${text}
`, "utf8");
  }
  async function readJson(file) {
    return existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : void 0;
  }
  async function writtenChapters(dir) {
    const p = paths(dir);
    if (!existsSync(p.prose)) return [];
    return (await readdir(p.prose)).map((f) => f.match(/^第(\d+)章\.md$/)?.[1]).filter((x) => x !== void 0).map(Number).sort((a, b) => a - b);
  }
  async function prompt(dir, nodeName) {
    const local = join(dir, "prompts", `${nodeName}.md`);
    return readFile(existsSync(local) ? local : join(cfg.promptsDir, `${nodeName}.md`), "utf8");
  }
  async function recentChaptersText(dir, before, count) {
    const nums = (await writtenChapters(dir)).filter((n) => n < before).slice(-count);
    const parts = [];
    for (const n of nums) parts.push(`### \u7B2C${pad(n)}\u7AE0
${(await readText(paths(dir).chapter(n))).trim()}`);
    return parts.join("\n\n") || "\uFF08\u65E0\uFF09";
  }
  async function requirePlanned(dir, chapter) {
    const plan = parsePlan(await readText(paths(dir).plan));
    const current = plan.find((c) => c.number === chapter);
    if (!current) throw new Error(`\u5267\u60C5\u70B9.md \u91CC\u6CA1\u6709\u7B2C${pad(chapter)}\u7AE0\uFF0C\u5148\u8C03 novel_plan \u89C4\u5212\u3002`);
    return { plan, current };
  }
  async function runNode(exec, stage, label, text, schema) {
    if (!exec?.agent) throw new Error("novel \u5DE5\u5177\u9700\u8981\u7531 Agent \u8C03\u7528\uFF08exec.agent \u7F3A\u5931\uFF09");
    const s = stages[stage];
    const dir = await bookDir(exec);
    const models = [s.model, s.fallbackModel].filter((m) => !!m);
    const failures = [];
    for (const model of models) {
      const started = Date.now();
      const activation = await ctx.subagents.startActivation({
        provider: cfg.subagentProvider,
        label,
        delivery: "caller",
        signal: exec.signal,
        request: {
          prompt: [{ type: "text", text }],
          parent: exec.agent,
          agentPreset: cfg.nodePreset,
          agentOptions: {
            provider: cfg.provider,
            model,
            ...s.reasoningEffort ? { reasoningEffort: s.reasoningEffort } : {},
            ...s.maxTokens ? { maxTokens: s.maxTokens } : {}
          },
          ...schema ? { outputSchema: schema } : {}
        }
      });
      let result;
      try {
        result = await activation.result;
      } finally {
        await activation.dispose().catch(() => {
        });
      }
      const out = (result.output ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("").trim();
      const ok = result.stopReason === "completed" && (schema ? result.structured !== void 0 : out.length > 0);
      await mkdir(paths(dir).state, { recursive: true });
      await appendFile(paths(dir).calls, `${JSON.stringify({
        at: (/* @__PURE__ */ new Date()).toISOString(),
        stage,
        label,
        model,
        stopReason: result.stopReason,
        ok,
        outChars: countChars(out),
        ms: Date.now() - started,
        childId: activation.childId,
        diagnostic: result.diagnostic
      })}
`, "utf8");
      if (ok) return { text: out, structured: result.structured, model };
      failures.push(`${model}: ${result.stopReason}${result.diagnostic ? ` (${result.diagnostic})` : ""}${out ? "" : " \u7A7A\u8F93\u51FA"}`);
    }
    throw new Error(`\u8282\u70B9 ${stage} \u5168\u90E8\u6A21\u578B\u5931\u8D25\uFF1A${failures.join("\uFF1B")}`);
  }
  async function checkChapter(dir, chapter) {
    const body = await readText(paths(dir).chapter(chapter));
    const prev = (await writtenChapters(dir)).filter((n) => n < chapter).pop();
    const prevBody = prev === void 0 ? "" : await readText(paths(dir).chapter(prev));
    const chars = countChars(body);
    const repeat = Number(repeatRatio(body, prevBody).toFixed(3));
    const problems = [];
    if (chars < cfg.chapterChars * cfg.minCharsRatio) problems.push(`\u5B57\u6570\u4E0D\u8DB3\uFF1A${chars} \u5B57\uFF0C\u76EE\u6807\u7EA6 ${cfg.chapterChars} \u5B57`);
    if (chars > cfg.chapterChars * cfg.maxCharsRatio) problems.push(`\u5B57\u6570\u8D85\u51FA\uFF1A${chars} \u5B57\uFF0C\u76EE\u6807\u7EA6 ${cfg.chapterChars} \u5B57`);
    if (repeat > cfg.maxRepeatRatio) problems.push(`\u4E0E\u4E0A\u4E00\u7AE0\u91CD\u590D\u5EA6 ${(repeat * 100).toFixed(1)}%\uFF0C\u8D85\u8FC7 ${(cfg.maxRepeatRatio * 100).toFixed(0)}%`);
    const result = { chars, repeat, problems };
    await writeText(paths(dir).check(chapter), JSON.stringify(result, null, 2));
    return result;
  }
  const describeCheck = (c) => `${c.chars} \u5B57\uFF0C\u4E0E\u4E0A\u4E00\u7AE0\u91CD\u590D\u5EA6 ${(c.repeat * 100).toFixed(1)}%${c.problems.length ? `\uFF1B\u4EE3\u7801\u68C0\u67E5\u672A\u901A\u8FC7\uFF1A${c.problems.join("\uFF1B")}` : "\uFF1B\u4EE3\u7801\u68C0\u67E5\u901A\u8FC7"}`;
  ctx.tools.register({
    name: "novel_status",
    description: "\u67E5\u770B\u5F53\u524D\u4E66\u7684\u7EED\u5199\u8FDB\u5EA6\uFF1A\u5206\u53C9\u70B9\u3001\u5907\u5FD8\u4E0E\u5267\u60C5\u70B9\u662F\u5426\u5C31\u7EEA\u3001\u5DF2\u5199\u7AE0\u8282\u5B57\u6570\u3001\u6BCF\u7AE0\u5BA1\u7A3F\u72B6\u6001\u3001\u4E0B\u4E00\u6B65\u8BE5\u5199\u54EA\u7AE0\u3002\u5F00\u5DE5\u548C\u4E0D\u786E\u5B9A\u8FDB\u5EA6\u65F6\u5148\u8C03\u5B83\u3002",
    parameters: { type: "object", properties: {} },
    output: textTool(),
    async execute(_args, exec) {
      const dir = await bookDir(exec);
      const p = paths(dir);
      const book = await readJson(p.book);
      const plan = parsePlan(await readText(p.plan));
      const written = await writtenChapters(dir);
      const lines = [`\u4E66\u76EE\u5F55\uFF1A${dir}`];
      lines.push(existsSync(p.original) ? "\u539F\u6587.txt\uFF1A\u6709" : "\u539F\u6587.txt\uFF1A\u7F3A\u5931\uFF08\u9700\u8981\u7F16\u8F91\u653E\u5165\uFF09");
      lines.push(book ? `\u5206\u53C9\u70B9\uFF1A\u4FDD\u7559\u539F\u6587\u524D ${book.keepChapters} \u7AE0\uFF08\u539F\u6587\u5171 ${book.originalChapters} \u7AE0\uFF09` : "\u5C1A\u672A\u5206\u6790\u539F\u6587\uFF08novel_analyze\uFF09");
      lines.push(existsSync(p.memo) ? "\u5907\u5FD8.md\uFF1A\u6709" : "\u5907\u5FD8.md\uFF1A\u65E0");
      lines.push(existsSync(p.direction) ? "\u7EED\u5199\u65B9\u5411.md\uFF1A\u6709" : "\u7EED\u5199\u65B9\u5411.md\uFF1A\u65E0");
      lines.push(plan.length ? `\u5267\u60C5\u70B9\uFF1A\u7B2C${pad(plan[0].number)}~${pad(plan[plan.length - 1].number)}\u7AE0\uFF0C\u5171 ${plan.length} \u7AE0` : "\u5267\u60C5\u70B9\uFF1A\u65E0");
      let total = 0;
      for (const n of written) {
        const chars = countChars(await readText(p.chapter(n)));
        total += chars;
        const isOriginal = book && n <= book.keepChapters;
        const review = await readJson(p.review(n));
        const memoDone = getSection(await readText(p.memo), "\u5DF2\u5199\u7AE0\u8282\u6458\u8981").includes(`\u7B2C${pad(n)}\u7AE0`);
        lines.push(`- \u7B2C${pad(n)}\u7AE0 ${chars} \u5B57${isOriginal ? "\uFF08\u539F\u6587\uFF09" : `\uFF5C\u5BA1\u7A3F\uFF1A${review ? review.verdict : "\u672A\u5BA1"}\uFF5C\u5907\u5FD8\uFF1A${memoDone ? "\u5DF2\u66F4\u65B0" : "\u672A\u66F4\u65B0"}`}`);
      }
      lines.push(`\u6B63\u6587\u5408\u8BA1\uFF1A${total} \u5B57`);
      const next = plan.find((c) => !written.includes(c.number));
      lines.push(next ? `\u4E0B\u4E00\u7AE0\u5F85\u5199\uFF1A\u7B2C${pad(next.number)}\u7AE0 ${next.title}` : plan.length ? "\u89C4\u5212\u5185\u7AE0\u8282\u5DF2\u5168\u90E8\u5199\u5B8C" : "");
      return { report: lines.filter(Boolean).join("\n") };
    }
  });
  ctx.tools.register({
    name: "novel_analyze",
    description: "\u8BFB\u539F\u6587\u5E76\u751F\u6210\u7EED\u5199\u5907\u5FD8\uFF08\u4EBA\u7269\u3001\u4F0F\u7B14\u3001\u6587\u98CE\u89C2\u5BDF\u3001\u7AE0\u8282\u6458\u8981\uFF09\u3002keep_chapters \u662F\u5206\u53C9\u70B9\uFF1A\u53EA\u4FDD\u7559\u539F\u6587\u524D N \u7AE0\uFF0C\u5176\u540E\u7684\u539F\u6587\u4E22\u5F03\u3001\u7531\u7EED\u5199\u66FF\u6362\u3002\u4F1A\u628A\u4FDD\u7559\u7684\u539F\u6587\u7AE0\u8282\u62C6\u5230 \u6B63\u6587/ \u76EE\u5F55\u3002",
    parameters: {
      type: "object",
      properties: {
        keep_chapters: { type: "integer", description: "\u4FDD\u7559\u539F\u6587\u524D\u591A\u5C11\u7AE0\uFF1B\u4E0D\u586B\u5219\u4FDD\u7559\u5168\u90E8\u3002" }
      }
    },
    output: textTool(),
    async execute(args, exec) {
      const dir = await bookDir(exec);
      const p = paths(dir);
      const raw = await readText(p.original);
      if (!raw) throw new Error("\u4E66\u76EE\u5F55\u4E0B\u6CA1\u6709 \u539F\u6587.txt");
      const chapters = splitChapters(raw);
      if (chapters.length === 0) throw new Error("\u539F\u6587.txt \u91CC\u6CA1\u627E\u5230\u300C\u7B2C N \u7AE0\u300D\u6807\u9898");
      const keep = Math.min(args.keep_chapters ?? chapters.length, chapters.length);
      const kept = chapters.filter((c) => c.number <= keep);
      for (const c of kept) await writeText(p.chapter(c.number), c.body);
      await writeText(p.book, JSON.stringify({ keepChapters: keep, originalChapters: chapters.length }, null, 2));
      const original = kept.map((c) => `### \u7B2C${pad(c.number)}\u7AE0
${c.body}`).join("\n\n");
      const lengths = kept.map((c) => countChars(c.body));
      const stats = `\u5171 ${kept.length} \u7AE0\uFF0C\u6BCF\u7AE0 ${Math.min(...lengths)}~${Math.max(...lengths)} \u5B57\uFF0C\u5E73\u5747 ${Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length)} \u5B57\uFF08\u4EE3\u7801\u5B9E\u6D4B\uFF0C\u53BB\u7A7A\u767D\u5B57\u7B26\u6570\uFF09`;
      const res = await runNode(exec, "analyze", "\u8BFB\u539F\u6587", fillTemplate(await prompt(dir, "analyze"), { \u539F\u6587: original, \u7AE0\u8282\u5B57\u6570: stats }));
      await writeText(p.memo, res.text);
      return { report: `\u5DF2\u4FDD\u7559\u539F\u6587\u7B2C01~${pad(keep)}\u7AE0\uFF08\u5171 ${countChars(original)} \u5B57\uFF09\u5230 \u6B63\u6587/\uFF0C\u5907\u5FD8.md \u5DF2\u751F\u6210\uFF08${res.model}\uFF09\u3002` };
    }
  });
  ctx.tools.register({
    name: "novel_plan",
    description: "\u89C4\u5212\u7EED\u5199\u7AE0\u8282\u7684\u5267\u60C5\u70B9\uFF0C\u5199\u5165 \u5267\u60C5\u70B9.md\uFF08\u540C\u7AE0\u53F7\u8986\u76D6\uFF0C\u5176\u4F59\u4FDD\u7559\uFF09\u3002direction \u7559\u7A7A\u65F6\u8BFB\u4E66\u76EE\u5F55\u4E0B\u7684 \u7EED\u5199\u65B9\u5411.md\u3002\u89C4\u5212\u5B8C\u8981\u628A\u7AE0\u540D\u548C\u6897\u6982\u7ED9\u7F16\u8F91\u8FC7\u76EE\u3002",
    parameters: {
      type: "object",
      properties: {
        chapters: { type: "integer", description: "\u672C\u6B21\u89C4\u5212\u591A\u5C11\u7AE0\u3002" },
        start_chapter: { type: "integer", description: "\u4ECE\u7B2C\u51E0\u7AE0\u5F00\u59CB\uFF1B\u9ED8\u8BA4\u63A5\u5DF2\u5199\u7684\u6700\u540E\u4E00\u7AE0\u3002" },
        direction: { type: "string", description: "\u7F16\u8F91\u7ED9\u7684\u7EED\u5199\u65B9\u5411\uFF1B\u7559\u7A7A\u5219\u8BFB \u7EED\u5199\u65B9\u5411.md\u3002" }
      },
      required: ["chapters"]
    },
    output: textTool(),
    async execute(args, exec) {
      const dir = await bookDir(exec);
      const p = paths(dir);
      const memo = await readText(p.memo);
      if (!memo) throw new Error("\u8FD8\u6CA1\u6709 \u5907\u5FD8.md\uFF0C\u5148\u8C03 novel_analyze\u3002");
      const written = await writtenChapters(dir);
      const start = args.start_chapter ?? (written[written.length - 1] ?? 0) + 1;
      const direction = args.direction?.trim() || (await readText(p.direction)).trim();
      if (!direction) throw new Error("\u6CA1\u6709\u7EED\u5199\u65B9\u5411\uFF1A\u8BF7\u5411\u7F16\u8F91\u8981\uFF0C\u6216\u5728\u4E66\u76EE\u5F55\u5199 \u7EED\u5199\u65B9\u5411.md\u3002");
      const text = fillTemplate(await prompt(dir, "plan"), {
        \u5907\u5FD8: memo,
        \u6700\u8FD1\u7AE0\u8282: await recentChaptersText(dir, start, 2),
        \u7EED\u5199\u65B9\u5411: direction,
        \u8D77\u59CB\u7AE0: start,
        \u7AE0\u6570: args.chapters,
        \u6BCF\u7AE0\u5B57\u6570: cfg.chapterChars
      });
      const res = await runNode(exec, "plan", `\u89C4\u5212\u7B2C${pad(start)}\u7AE0\u8D77 ${args.chapters} \u7AE0`, text);
      const incoming = parsePlan(res.text);
      if (incoming.length === 0) throw new Error(`\u89C4\u5212\u8282\u70B9\u8F93\u51FA\u65E0\u6CD5\u89E3\u6790\u4E3A\u7AE0\u8282\uFF1A
${res.text.slice(0, 500)}`);
      const merged = mergePlans(parsePlan(await readText(p.plan)), incoming);
      await writeText(p.plan, `# \u5267\u60C5\u70B9

${merged.map(renderPlanned).join("\n\n")}`);
      const outline = incoming.map((c) => `\u7B2C${pad(c.number)}\u7AE0 ${c.title}\uFF1A${c.beats[0] ?? ""}\u2026\uFF08${c.beats.length} \u4E2A\u5267\u60C5\u70B9\uFF09${c.additions && c.additions !== "\u65E0" ? `\uFF5C\u65B0\u589E\uFF1A${c.additions}` : ""}`);
      return { report: `\u5267\u60C5\u70B9.md \u5DF2\u5199\u5165 ${incoming.length} \u7AE0\uFF08${res.model}\uFF09\uFF1A
${outline.join("\n")}` };
    }
  });
  ctx.tools.register({
    name: "novel_write_chapter",
    description: "\u5199\u4E00\u7AE0\u6B63\u6587\uFF1A\u53EA\u7ED9\u5199\u4F5C\u8282\u70B9 \u5907\u5FD8 + \u6700\u8FD1\u51E0\u7AE0\u5168\u6587 + \u672C\u7AE0\u5267\u60C5\u70B9\uFF0C\u5199\u5165 \u6B63\u6587/\u7B2CNN\u7AE0.md\uFF0C\u5E76\u505A\u5B57\u6570\u4E0E\u91CD\u590D\u5EA6\u68C0\u67E5\u3002\u5DF2\u5B58\u5728\u7684\u7AE0\u8282\u4F1A\u5148\u5907\u4EFD\u518D\u8986\u76D6\u3002",
    parameters: {
      type: "object",
      properties: { chapter: { type: "integer", description: "\u7AE0\u53F7" } },
      required: ["chapter"]
    },
    output: textTool(),
    async execute(args, exec) {
      const dir = await bookDir(exec);
      const p = paths(dir);
      const { plan, current } = await requirePlanned(dir, args.chapter);
      const next = plan.find((c) => c.number === args.chapter + 1);
      const text = fillTemplate(await prompt(dir, "write"), {
        \u7AE0\u53F7: args.chapter,
        \u6587\u98CE\u7EA6\u675F: await prompt(dir, "style"),
        \u5907\u5FD8: await readText(p.memo),
        \u6700\u8FD1\u7AE0\u8282: await recentChaptersText(dir, args.chapter, cfg.recentChapters),
        \u672C\u7AE0\u5267\u60C5\u70B9: renderPlanned(current),
        \u4E0B\u4E00\u7AE0\u5F00\u5934: next ? `${next.title}\uFF1A${next.beats[0] ?? ""}` : "\uFF08\u65E0\uFF0C\u672C\u7AE0\u4E3A\u5F53\u524D\u89C4\u5212\u7684\u6700\u540E\u4E00\u7AE0\uFF09",
        \u5B57\u6570: cfg.chapterChars
      });
      const res = await runNode(exec, "write", `\u5199\u7B2C${pad(args.chapter)}\u7AE0`, text);
      if (existsSync(p.chapter(args.chapter))) {
        await mkdir(p.drafts, { recursive: true });
        await copyFile(p.chapter(args.chapter), join(p.drafts, `${pad(args.chapter)}-${Date.now()}.md`));
      }
      await writeText(p.chapter(args.chapter), normalizeProse(res.text));
      const check = await checkChapter(dir, args.chapter);
      return { report: `\u7B2C${pad(args.chapter)}\u7AE0\u5DF2\u5199\u5165\uFF08${res.model}\uFF09\uFF1A${describeCheck(check)}` };
    }
  });
  ctx.tools.register({
    name: "novel_review_chapter",
    description: "\u5BA1\u4E00\u7AE0\uFF1A\u67E5\u8D8A\u754C\u8DD1\u504F\u3001\u91CD\u590D\u3001\u4EBA\u7269\u4E0E\u8BBE\u5B9A\u3001AI \u5473\u56DB\u9879\uFF0C\u7ED3\u5408\u4EE3\u7801\u68C0\u67E5\u7ED3\u679C\u7ED9\u51FA pass / revise \u548C\u5177\u4F53\u4FEE\u6539\u70B9\u3002",
    parameters: {
      type: "object",
      properties: { chapter: { type: "integer", description: "\u7AE0\u53F7" } },
      required: ["chapter"]
    },
    output: textTool(),
    async execute(args, exec) {
      const dir = await bookDir(exec);
      const p = paths(dir);
      const { current } = await requirePlanned(dir, args.chapter);
      const body = await readText(p.chapter(args.chapter));
      if (!body) throw new Error(`\u7B2C${pad(args.chapter)}\u7AE0\u8FD8\u6CA1\u5199\u3002`);
      const check = await checkChapter(dir, args.chapter);
      const prev = (await writtenChapters(dir)).filter((n) => n < args.chapter).pop();
      const text = fillTemplate(await prompt(dir, "review"), {
        \u5907\u5FD8: await readText(p.memo),
        \u4E0A\u4E00\u7AE0: prev === void 0 ? "\uFF08\u65E0\uFF09" : await readText(p.chapter(prev)),
        \u672C\u7AE0\u5267\u60C5\u70B9: renderPlanned(current),
        \u672C\u7AE0\u6B63\u6587: body,
        \u68C0\u67E5\u7ED3\u679C: describeCheck(check)
      });
      const res = await runNode(exec, "review", `\u5BA1\u7B2C${pad(args.chapter)}\u7AE0`, text, REVIEW_SCHEMA);
      const review = res.structured;
      if (check.problems.length && review.verdict === "pass") {
        review.verdict = "revise";
        for (const problem of check.problems) review.issues.push({ item: "\u5B57\u6570", problem, fix: problem.startsWith("\u5B57\u6570\u4E0D\u8DB3") ? "\u8865\u8DB3\u573A\u666F\u7EC6\u8282\u548C\u5FC3\u7406\uFF0C\u5199\u6EE1\u5267\u60C5\u70B9" : problem.startsWith("\u5B57\u6570\u8D85\u51FA") ? "\u5220\u53BB\u91CD\u590D\u7684\u5FC3\u7406\u63CF\u5199\u548C\u53EF\u6709\u53EF\u65E0\u7684\u8FC7\u6E21\uFF0C\u538B\u5230\u76EE\u6807\u5B57\u6570" : "\u5220\u53BB\u590D\u8FF0\u4E0A\u4E00\u7AE0\u7684\u5185\u5BB9" });
      }
      await writeText(p.review(args.chapter), JSON.stringify(review, null, 2));
      await writeText(p.reviewHistory(args.chapter), JSON.stringify({ ...review, model: res.model, check }, null, 2));
      const issues = review.issues.map((i, k) => `${k + 1}. [${i.item}] ${i.problem} \u2192 ${i.fix}`);
      return { report: `\u7B2C${pad(args.chapter)}\u7AE0\u5BA1\u7A3F\uFF1A${review.verdict}\uFF08${res.model}\uFF09${issues.length ? `
${issues.join("\n")}` : ""}` };
    }
  });
  ctx.tools.register({
    name: "novel_revise_chapter",
    description: "\u6309\u6700\u8FD1\u4E00\u6B21\u5BA1\u7A3F\u610F\u89C1\u548C/\u6216\u7F16\u8F91\u7684\u989D\u5916\u8981\u6C42\u6539\u4E00\u7AE0\uFF0C\u539F\u7A3F\u5907\u4EFD\u5230 state/drafts/\u3002instructions \u7528\u4E8E\u8F6C\u8FBE\u7F16\u8F91\u7684\u4FEE\u6539\u8981\u6C42\u3002",
    parameters: {
      type: "object",
      properties: {
        chapter: { type: "integer", description: "\u7AE0\u53F7" },
        instructions: { type: "string", description: "\u7F16\u8F91\u7684\u989D\u5916\u4FEE\u6539\u8981\u6C42\uFF08\u53EF\u9009\uFF09\u3002" },
        use_review: { type: "boolean", description: "\u662F\u5426\u5E26\u4E0A\u6700\u8FD1\u4E00\u6B21\u5BA1\u7A3F\u610F\u89C1\uFF0C\u9ED8\u8BA4 true\u3002" }
      },
      required: ["chapter"]
    },
    output: textTool(),
    async execute(args, exec) {
      const dir = await bookDir(exec);
      const p = paths(dir);
      const { current } = await requirePlanned(dir, args.chapter);
      const body = await readText(p.chapter(args.chapter));
      if (!body) throw new Error(`\u7B2C${pad(args.chapter)}\u7AE0\u8FD8\u6CA1\u5199\u3002`);
      const requirements = [];
      if (args.instructions?.trim()) requirements.push(`\u7F16\u8F91\u8981\u6C42\uFF1A${args.instructions.trim()}`);
      const review = args.use_review === false ? void 0 : await readJson(p.review(args.chapter));
      if (review?.verdict === "revise") review.issues.forEach((i) => requirements.push(`[${i.item}] ${i.problem} \u2192 ${i.fix}`));
      if (requirements.length === 0) throw new Error("\u6CA1\u6709\u4FEE\u6539\u8981\u6C42\uFF1A\u65E2\u6CA1\u6709 revise \u5BA1\u7A3F\u610F\u89C1\uFF0C\u4E5F\u6CA1\u6709 instructions\u3002");
      const prev = (await writtenChapters(dir)).filter((n) => n < args.chapter).pop();
      const text = fillTemplate(await prompt(dir, "revise"), {
        \u6587\u98CE\u7EA6\u675F: await prompt(dir, "style"),
        \u5907\u5FD8: await readText(p.memo),
        \u4E0A\u4E00\u7AE0: prev === void 0 ? "\uFF08\u65E0\uFF09" : await readText(p.chapter(prev)),
        \u672C\u7AE0\u5267\u60C5\u70B9: renderPlanned(current),
        \u672C\u7AE0\u6B63\u6587: body,
        \u4FEE\u6539\u8981\u6C42: requirements.map((r, k) => `${k + 1}. ${r}`).join("\n"),
        \u5B57\u6570: cfg.chapterChars
      });
      const res = await runNode(exec, "revise", `\u6539\u7B2C${pad(args.chapter)}\u7AE0`, text);
      await mkdir(p.drafts, { recursive: true });
      await copyFile(p.chapter(args.chapter), join(p.drafts, `${pad(args.chapter)}-${Date.now()}.md`));
      await writeText(p.chapter(args.chapter), normalizeProse(res.text));
      const check = await checkChapter(dir, args.chapter);
      return { report: `\u7B2C${pad(args.chapter)}\u7AE0\u5DF2\u6309 ${requirements.length} \u6761\u8981\u6C42\u6539\u5B8C\uFF08${res.model}\uFF09\uFF1A${describeCheck(check)}\u3002\u9700\u8981\u7684\u8BDD\u518D\u5BA1\u4E00\u6B21\u3002` };
    }
  });
  ctx.tools.register({
    name: "novel_update_memo",
    description: "\u4E00\u7AE0\u5B9A\u7A3F\u540E\u66F4\u65B0\u5907\u5FD8\uFF1A\u5199\u5165\u672C\u7AE0\u6458\u8981\uFF0C\u66F4\u65B0\u4EBA\u7269\u5F53\u524D\u5904\u5883\u4E0E\u4F0F\u7B14\u6E05\u5355\u3002\u6BCF\u7AE0\u5B9A\u7A3F\u540E\u90FD\u8981\u8C03\uFF0C\u540E\u9762\u7684\u7AE0\u8282\u9760\u5B83\u4FDD\u6301\u8FDE\u8D2F\u3002",
    parameters: {
      type: "object",
      properties: { chapter: { type: "integer", description: "\u7AE0\u53F7" } },
      required: ["chapter"]
    },
    output: textTool(),
    async execute(args, exec) {
      const dir = await bookDir(exec);
      const p = paths(dir);
      const memo = await readText(p.memo);
      const body = await readText(p.chapter(args.chapter));
      if (!memo || !body) throw new Error("\u5907\u5FD8\u6216\u672C\u7AE0\u6B63\u6587\u7F3A\u5931\u3002");
      const text = fillTemplate(await prompt(dir, "memo"), {
        \u4EBA\u7269: getSection(memo, "\u4EBA\u7269"),
        \u4F0F\u7B14: getSection(memo, "\u4F0F\u7B14\u4E0E\u672A\u89E3\u51B3\u7684\u7EBF"),
        \u7AE0\u53F7: args.chapter,
        \u672C\u7AE0\u6B63\u6587: body
      });
      const res = await runNode(exec, "memo", `\u66F4\u65B0\u5907\u5FD8\xB7\u7B2C${pad(args.chapter)}\u7AE0`, text, MEMO_SCHEMA);
      const s = res.structured;
      const strip = (t, h) => t.replace(new RegExp(`^##\\s+${h}\\s*\\n`), "");
      let next = setSection(memo, "\u4EBA\u7269", strip(s.characters, "\u4EBA\u7269"));
      next = setSection(next, "\u4F0F\u7B14\u4E0E\u672A\u89E3\u51B3\u7684\u7EBF", strip(s.threads, "\u4F0F\u7B14\u4E0E\u672A\u89E3\u51B3\u7684\u7EBF"));
      next = upsertSummary(next, args.chapter, s.summary);
      await writeText(p.memo, next);
      return { report: `\u5907\u5FD8\u5DF2\u66F4\u65B0\u5230\u7B2C${pad(args.chapter)}\u7AE0\uFF08${res.model}\uFF09\uFF1A${s.summary}` };
    }
  });
  ctx.tools.register({
    name: "novel_export",
    description: "\u628A \u6B63\u6587/ \u4E0B\u6240\u6709\u7AE0\u8282\u6309\u539F\u6587\u683C\u5F0F\u5408\u5E76\u6210 \u6210\u7A3F.txt\uFF0C\u8FD4\u56DE\u603B\u5B57\u6570\u3002",
    parameters: { type: "object", properties: {} },
    output: textTool(),
    async execute(_args, exec) {
      const dir = await bookDir(exec);
      const p = paths(dir);
      const nums = await writtenChapters(dir);
      const title = (await readText(p.original)).split("\n")[0]?.trim() || "\u6210\u7A3F";
      const parts = [title, ""];
      let total = 0;
      for (const n of nums) {
        const body = (await readText(p.chapter(n))).trim();
        total += countChars(body);
        parts.push(`\u7B2C ${n} \u7AE0`, "", ...body.split(/\n\s*\n/).map((para) => `    ${para.trim()}
`), "");
      }
      await writeText(p.exported, parts.join("\n"));
      return { report: `\u5DF2\u5BFC\u51FA \u6210\u7A3F.txt\uFF1A${nums.length} \u7AE0\uFF0C${total} \u5B57\u3002` };
    }
  });
}
export {
  apply,
  countChars,
  fillTemplate,
  getSection,
  inject,
  mergePlans,
  name,
  normalizeProse,
  pad,
  parsePlan,
  renderPlanned,
  repeatRatio,
  setSection,
  splitChapters,
  upsertSummary
};
