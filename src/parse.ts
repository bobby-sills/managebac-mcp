import { parse, HTMLElement, Node, NodeType } from "node-html-parser";

const BLOCK = new Set([
  "p", "div", "section", "article", "header", "footer", "main", "aside", "ul", "ol",
  "table", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "dl", "dt", "dd",
  "figure", "form", "fieldset", "nav", "hr",
]);
const SKIP = new Set(["script", "style", "svg", "noscript", "template", "button", "input", "select", "img", "iframe"]);

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** Turn an HTML fragment into compact readable text (headings, lists and line breaks kept). */
export function htmlToText(input: string | HTMLElement | null | undefined, maxLen = 20000): string {
  if (!input) return "";
  const root = typeof input === "string" ? parse(input) : input;
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === NodeType.TEXT_NODE) {
      const t = n.text.replace(/\s+/g, " ");
      if (t.trim()) out.push(t);
      return;
    }
    if (n.nodeType !== NodeType.ELEMENT_NODE) return;
    const el = n as HTMLElement;
    const tag = el.rawTagName?.toLowerCase() ?? "";
    if (SKIP.has(tag)) return;
    if (el.getAttribute("aria-hidden") === "true" || /\bd-none\b|\bvisually-hidden\b/.test(el.classNames)) return;
    if (tag === "br") return void out.push("\n");
    if (/^h[1-6]$/.test(tag)) out.push("\n\n" + "#".repeat(Math.min(Number(tag[1]), 4)) + " ");
    else if (tag === "li") out.push("\n- ");
    else if (tag === "td" || tag === "th") out.push(" | ");
    else if (BLOCK.has(tag)) out.push("\n");
    el.childNodes.forEach(walk);
    if (BLOCK.has(tag) || /^h[1-6]$/.test(tag)) out.push("\n");
  };
  walk(root);
  let text = out
    .join("")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length > maxLen) text = text.slice(0, maxLen) + "\n…[truncated]";
  return text;
}

// ---------------- Tasks & Deadlines ----------------
export interface TaskTile {
  task_id: number | null;
  class_id: number | null;
  title: string;
  due: string; // as shown, e.g. "Nov 13, 11:55 AM"
  due_iso?: string;
  group?: string; // date heading, e.g. "Today - Friday, Nov 13"
  class_name: string;
  labels: string[]; // e.g. Summative, Essay, Submitted, Pending
  result?: string; // e.g. "Complete", "Not Assessed Yet"
  criteria_scores?: { criterion: string; name?: string; score: string }[];
  comment?: string;
  url: string;
}

export function parseTaskTiles(html: string, base: string): { tasks: TaskTile[]; tabCounts: Record<string, string> } {
  const root = parse(html);
  const tasks: TaskTile[] = [];
  const tabCounts: Record<string, string> = {};
  for (const a of root.querySelectorAll('a[href*="tasks_and_deadlines?view="]')) {
    const m = a.getAttribute("href")!.match(/view=(\w+)/);
    const num = clean(a.text).match(/(\d+)\s*$/);
    if (m) tabCounts[m[1]] = num ? num[1] : "0";
  }

  let group: string | undefined;
  const visit = (el: HTMLElement) => {
    for (const child of el.childNodes) {
      if (child.nodeType !== NodeType.ELEMENT_NODE) continue;
      const c = child as HTMLElement;
      if (c.classList.contains("f-task-tile")) {
        tasks.push(parseTile(c, base, group));
      } else if (c.getAttribute("role") === "heading" && c.closest(".js-tasks")) {
        group = clean(c.text);
      } else visit(c);
    }
  };
  visit(root);
  return { tasks, tabCounts };
}

function parseTile(t: HTMLElement, base: string, group?: string): TaskTile {
  const link = t.querySelector("a.f-tile__title-link") ?? t.querySelector('a[href*="core_tasks"]');
  const href = link?.getAttribute("href") ?? "";
  const ids = href.match(/classes\/(\d+)\/core_tasks\/(\d+)/);
  const desc = t.querySelector(".f-tile__description");
  const due = clean(desc?.querySelector("span")?.text ?? "");
  const classLink = desc
    ?.querySelectorAll("a")
    .find((a) => /^\/student\/classes\/\d+$/.test(a.getAttribute("href") ?? ""));
  // Badges: task type (Summative/Formative), category, and submission status.
  // The status badge's tooltip carries timing, e.g. "5 minutes early", "11 hours" (late), "Waiting".
  const labels = t
    .querySelectorAll(".f-tile__description .badge")
    .map((b) => {
      const label = clean(b.querySelector(".badge-label")?.text ?? b.text);
      const hint = clean(b.getAttribute("data-bs-title") ?? "");
      if (!label) return "";
      if (!hint || hint === "Waiting") return label;
      const late = /orange|red|danger/.test(b.classNames) && !/early/i.test(hint);
      return `${label} (${hint}${late ? " late" : ""})`;
    })
    .filter(Boolean);

  const tile: TaskTile = {
    task_id: ids ? Number(ids[2]) : null,
    class_id: ids ? Number(ids[1]) : null,
    title: clean(link?.text ?? ""),
    due,
    group,
    class_name: clean(classLink?.text ?? ""),
    labels: [...new Set(labels)],
    url: href ? base + href : "",
  };

  const suffix = t.querySelector(".f-tile__suffix");
  if (suffix) {
    const items = suffix.querySelectorAll(".f-task-score__criteria-item");
    if (items.length) {
      tile.criteria_scores = items.map((it) => {
        const ps = it.querySelectorAll("p");
        return {
          criterion: clean(ps[0]?.text ?? ""),
          name: ps[0]?.getAttribute("data-bs-title") ?? undefined,
          score: clean(ps[1]?.text ?? "").replace(/\s*\/\s*/, "/"),
        };
      });
    } else {
      suffix.querySelectorAll("a.btn, button").forEach((b) => b.remove());
      const r = clean(suffix.text);
      if (r) tile.result = r;
    }
  }
  const footer = t.querySelector(".f-tile__footer");
  if (footer) {
    footer.querySelectorAll("h6").forEach((h) => h.remove());
    const c = htmlToText(footer, 4000);
    if (c) tile.comment = c;
  }
  return tile;
}

// ---------------- Classes ----------------
export function parseClasses(html: string, base: string) {
  const root = parse(html);
  const byId = new Map<number, string>();
  for (const a of root.querySelectorAll('a[href^="/student/classes/"]')) {
    const m = (a.getAttribute("href") ?? "").match(/^\/student\/classes\/(\d+)$/);
    if (!m) continue;
    const name = clean(a.text);
    if (!name) continue;
    const id = Number(m[1]);
    if ((byId.get(id)?.length ?? 0) < name.length) byId.set(id, name);
  }
  return [...byId].map(([class_id, name]) => ({ class_id, name, url: `${base}/student/classes/${class_id}` }));
}

// ---------------- Generic page content ----------------
export function mainContent(html: string, base: string) {
  const root = parse(html);
  const title = clean(root.querySelector("title")?.text ?? "").replace(/^ManageBac \| /, "");
  const heroTitle = clean(root.querySelector(".f-hero h1, .f-hero [role=heading], .f-hero .f-title__content")?.text ?? "");
  const content =
    root.querySelector(".f-layout-main__content") ?? root.querySelector("main") ?? root.querySelector("body");
  const files: { name: string; url: string }[] = [];
  const links: { text: string; url: string }[] = [];
  for (const a of content?.querySelectorAll("a[href]") ?? []) {
    const href = a.getAttribute("href")!;
    const text = clean(a.text) || clean(a.getAttribute("title") ?? "") || clean(a.getAttribute("download") ?? "");
    if (/privacy_attachments|\/attachments\/|\/files\/|\.pdf|\.docx?|\.pptx?/.test(href)) {
      if (text) files.push({ name: text, url: new URL(href, base).toString() });
    } else if (/^https?:\/\//.test(href) && !href.includes(new URL(base).host) && text) {
      links.push({ text, url: href });
    }
  }
  return {
    title: heroTitle && heroTitle !== title ? `${title} — ${heroTitle}` : title,
    text: htmlToText(content ?? null),
    files: dedupe(files, (f) => f.url),
    external_links: dedupe(links, (l) => l.url),
  };
}

const dedupe = <T,>(xs: T[], key: (x: T) => string) => {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
};

// ---------------- Timetable ----------------
export function parseTimetable(html: string) {
  const root = parse(html);
  const table = root.querySelector(".f-layout-main__content table") ?? root.querySelector("table");
  if (!table) return { days: [] as any[] };
  const rows = table.querySelectorAll("tr");
  const headers = rows[0]?.querySelectorAll("th, td").map((c) => clean(c.text)) ?? [];
  const days = headers.slice(1).map((h) => ({ day: h, periods: [] as { period: string; details: string }[] }));
  for (const tr of rows.slice(1)) {
    const cells = tr.querySelectorAll("th, td");
    const period = clean(cells[0]?.text ?? "");
    cells.slice(1).forEach((cell, i) => {
      if (!days[i]) return;
      const parts = cell
        .querySelectorAll("*")
        .filter((e) => e.childNodes.some((n) => n.nodeType === NodeType.TEXT_NODE && n.text.trim()))
        .map((e) => clean(e.childNodes.filter((n) => n.nodeType === NodeType.TEXT_NODE).map((n) => n.text).join(" ")))
        .filter(Boolean);
      const details = (parts.length ? parts : [clean(cell.text)]).join(" · ");
      if (details) days[i].periods.push({ period, details });
    });
  }
  const nav = root
    .querySelectorAll('a[href*="start_date="]')
    .map((a) => a.getAttribute("href")!.match(/start_date=([\d-]+)/)?.[1])
    .filter(Boolean);
  return { days, related_start_dates: [...new Set(nav)] };
}
