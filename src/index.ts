// ManageBac MCP server for Cloudflare Workers.
// Implements MCP's Streamable HTTP transport (stateless, JSON responses) directly,
// so the whole Worker stays small enough to paste into the Cloudflare dashboard.
import { ManageBac, Env, LoginError } from "./client";
import { parseTaskTiles, parseClasses, mainContent, parseTimetable, htmlToText, TaskTile } from "./parse";

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DATE = "^\\d{4}-\\d{2}-\\d{2}$";
const READ = { readOnlyHint: true, openWorldHint: true };

type Args = Record<string, any>;
interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, any>; required?: string[] };
  annotations: Record<string, boolean>;
  run: (mb: ManageBac, a: Args) => Promise<unknown>;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const todayLocal = (tz: string) => new Date().toLocaleDateString("en-CA", { timeZone: tz });

type Ev = { id: number; title: string; start: string; end: string | null; allDay: boolean; description: string; type: string; category: string; url: string };
const events = async (mb: ManageBac, start: string, end: string) =>
  mb.json<Ev[]>(
    `/student/events.json?start=${encodeURIComponent(start + "T00:00:00")}&end=${encodeURIComponent(end + "T00:00:00")}&timeZone=${encodeURIComponent(await mb.timezone())}`
  );

const tasksView = async (mb: ManageBac, view: string, page = 1) =>
  parseTaskTiles(await mb.html(`/student/tasks_and_deadlines?view=${view}${page > 1 ? `&page=${page}` : ""}`), mb.base);

async function withIsoDates(mb: ManageBac, tasks: TaskTile[]) {
  if (!tasks.length) return tasks;
  try {
    const now = Date.now();
    const evs = await events(mb, isoDay(new Date(now - 400 * 864e5)), isoDay(new Date(now + 400 * 864e5)));
    const byId = new Map(evs.filter((e) => e.type === "CoreTask").map((e) => [e.id, e.start]));
    for (const t of tasks) if (t.task_id && byId.has(t.task_id)) t.due_iso = byId.get(t.task_id)!;
  } catch {
    /* exact dates are a bonus */
  }
  return tasks;
}

function slimNotification(n: any) {
  return {
    id: n.id,
    title: n.title,
    created_at: n.created_at,
    type: n.event_name,
    from: n.sender?.name,
    class: n.origin?.name,
    is_read: n.is_read,
    starred: n.starred || undefined,
    preview: n.body_preview,
  };
}

const TOOLS: Tool[] = [
  {
    name: "get_overview",
    title: "ManageBac overview",
    description:
      "One-call snapshot: overdue tasks, upcoming tasks (next deadlines first), and unread notifications. Start here for 'what do I have due?' questions.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
    async run(mb) {
      const [overdue, upcoming, unread] = await Promise.all([
        tasksView(mb, "overdue"),
        tasksView(mb, "upcoming"),
        mb.mnn<any>("notifications?page=1&per_page=20&kind=unread"),
      ]);
      const slim = (t: TaskTile) => ({ task_id: t.task_id, class_id: t.class_id, title: t.title, due: t.due, class: t.class_name, labels: t.labels, result: t.result });
      return {
        timezone: await mb.timezone(),
        today: new Date().toLocaleDateString("en-GB", { timeZone: await mb.timezone(), weekday: "long", year: "numeric", month: "short", day: "numeric" }),
        overdue: overdue.tasks.map(slim),
        upcoming: upcoming.tasks.map(slim),
        unread_notifications: (unread.items ?? []).map(slimNotification),
        unread_notification_count: unread.meta?.total ?? 0,
      };
    },
  },
  {
    name: "list_tasks",
    title: "List tasks & deadlines",
    description:
      "List assignments from Tasks & Deadlines. view=upcoming (default), overdue, or past (past includes criterion scores like 'C: 8/8', teacher comments and early/late submission). Past is paginated (about 10 per page).",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["upcoming", "overdue", "past"], default: "upcoming" },
        page: { type: "integer", minimum: 1, default: 1, description: "Page number (mostly useful for view=past)" },
        include_comments: { type: "boolean", default: true, description: "Include teacher comments shown on the tile" },
      },
    },
    annotations: READ,
    async run(mb, a) {
      const { tasks, tabCounts } = await tasksView(mb, a.view, a.page);
      await withIsoDates(mb, tasks);
      if (!a.include_comments) tasks.forEach((t) => delete t.comment);
      return { view: a.view, page: a.page, counts: tabCounts, tasks, note: tasks.length === 0 && a.page > 1 ? "No more tasks on this page." : undefined };
    },
  },
  {
    name: "get_task",
    title: "Get task details",
    description:
      "Full details for one task: instructions/task sheet text, due date, assessment criteria, grades and feedback if released, your uploaded files (Dropbox), and discussion. Needs class_id and task_id (from list_tasks / get_overview).",
    inputSchema: {
      type: "object",
      properties: { class_id: { type: "integer" }, task_id: { type: "integer" } },
      required: ["class_id", "task_id"],
    },
    annotations: READ,
    async run(mb, a) {
      const path = `/student/classes/${a.class_id}/core_tasks/${a.task_id}`;
      const page = mainContent(await mb.html(path), mb.base);
      return { ...page, url: mb.base + path, files_note: page.files.length ? "File links need a signed-in browser; open them via the task URL." : undefined };
    },
  },
  {
    name: "get_calendar",
    title: "Calendar events",
    description:
      "Calendar items (tasks, projects, events) between two dates with exact due times and descriptions. Dates as YYYY-MM-DD; defaults to today through 30 days out.",
    inputSchema: {
      type: "object",
      properties: {
        start: { type: "string", pattern: DATE },
        end: { type: "string", pattern: DATE },
        description_chars: { type: "integer", minimum: 0, maximum: 5000, default: 400, description: "How much of each description to include (0 = none)" },
      },
    },
    annotations: READ,
    async run(mb, a) {
      const s = a.start ?? todayLocal(await mb.timezone());
      const e = a.end ?? isoDay(new Date(Date.now() + 30 * 864e5));
      const evs = await events(mb, s, e);
      return evs
        .sort((x, y) => x.start.localeCompare(y.start))
        .map((ev) => {
          const ids = ev.url?.match(/classes\/(\d+)\/core_tasks\/(\d+)/);
          const desc = a.description_chars ? htmlToText(ev.description ?? "", a.description_chars) : "";
          return {
            id: ev.id,
            title: ev.title,
            start: ev.start,
            end: ev.end,
            all_day: ev.allDay,
            category: ev.category,
            type: ev.type,
            class_id: ids ? Number(ids[1]) : undefined,
            task_id: ids ? Number(ids[2]) : undefined,
            description: desc || undefined,
            url: ev.url ? mb.base + ev.url : undefined,
          };
        });
    },
  },
  {
    name: "list_notifications",
    title: "List notifications",
    description:
      "ManageBac notifications: new/updated tasks, grades & comments posted, announcements, etc. kind=unread (default), read, starred, or all. Set full_body=true to get the full message text (e.g. complete teacher comments).",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["unread", "read", "starred", "all"], default: "unread" },
        page: { type: "integer", minimum: 1, default: 1 },
        per_page: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        full_body: { type: "boolean", default: false },
      },
    },
    annotations: READ,
    async run(mb, a) {
      const kinds: string[] = a.kind === "all" ? ["unread", "read"] : [a.kind];
      const results = await Promise.all(kinds.map((k) => mb.mnn<any>(`notifications?page=${a.page}&per_page=${a.per_page}&kind=${k}`)));
      const items = results
        .flatMap((r) => r.items ?? [])
        .sort((x: any, y: any) => String(y.created_at).localeCompare(String(x.created_at)))
        .map((n: any) => ({ ...slimNotification(n), body: a.full_body ? htmlToText(n.body ?? "", 6000) : undefined }));
      return {
        kind: a.kind,
        page: a.page,
        totals: Object.fromEntries(kinds.map((k, i) => [k, results[i].meta?.total ?? null])),
        has_more: results.some((r) => r.meta?.has_more),
        items,
      };
    },
  },
  {
    name: "mark_notification_read",
    title: "Mark notification read",
    description: "Mark one ManageBac notification as read (use the id from list_notifications).",
    inputSchema: { type: "object", properties: { notification_id: { type: "integer" } }, required: ["notification_id"] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(mb, a) {
      await mb.mnn(`notifications/${a.notification_id}/read`, "PUT");
      return { ok: true, notification_id: a.notification_id };
    },
  },
  {
    name: "list_classes",
    title: "List my classes",
    description: "Your classes with their class_id (needed for get_class).",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
    run: async (mb) => parseClasses(await mb.html("/student/classes/my"), mb.base),
  },
  {
    name: "get_class",
    title: "Class page",
    description:
      "Read a section of one class: overview, class_stream (teacher posts), units, tasks (all tasks in the class), discussions, files, or members.",
    inputSchema: {
      type: "object",
      properties: {
        class_id: { type: "integer" },
        section: { type: "string", enum: ["overview", "class_stream", "units", "tasks", "discussions", "files", "members"], default: "overview" },
      },
      required: ["class_id"],
    },
    annotations: READ,
    async run(mb, a) {
      const sub: Record<string, string> = { overview: "", class_stream: "/class_stream", units: "/units", tasks: "/core_tasks", discussions: "/discussions", files: "/files", members: "/students" };
      const path = `/student/classes/${a.class_id}${sub[a.section]}`;
      const html = await mb.html(path);
      const tasks = a.section === "tasks" ? parseTaskTiles(html, mb.base).tasks : undefined;
      return { ...mainContent(html, mb.base), tasks: tasks?.length ? tasks : undefined, url: mb.base + path };
    },
  },
  {
    name: "get_timetable",
    title: "Weekly timetable",
    description: "Your timetable for the week containing start_date (YYYY-MM-DD, default today): periods, times, rooms, teachers and attendance marks.",
    inputSchema: { type: "object", properties: { start_date: { type: "string", pattern: DATE } } },
    annotations: READ,
    run: async (mb, a) => parseTimetable(await mb.html(`/student/timetables/weekly?start_date=${a.start_date ?? todayLocal(await mb.timezone())}`)),
  },
  {
    name: "get_page",
    title: "Read any student page",
    description:
      "Fallback reader for any ManageBac student page, e.g. /student/profile (reports, academic overview), /student/ib/activity/sa (Service as Action), /student/portfolio, /student/ib/pbl/... (Personal Project). Path must start with /student/.",
    inputSchema: { type: "object", properties: { path: { type: "string", pattern: "^/student/" } }, required: ["path"] },
    annotations: READ,
    run: async (mb, a) => ({ ...mainContent(await mb.html(a.path), mb.base), url: mb.base + a.path }),
  },
];

// ---------- argument validation (applies defaults, checks types/enums/patterns) ----------
function prepareArgs(tool: Tool, input: unknown): Args {
  const given: Args = input && typeof input === "object" ? (input as Args) : {};
  const out: Args = {};
  for (const [key, s] of Object.entries(tool.inputSchema.properties)) {
    let v = given[key];
    if (v === undefined || v === null) {
      if ("default" in s) out[key] = s.default;
      else if (tool.inputSchema.required?.includes(key)) throw new ArgError(`Missing required argument "${key}"`);
      continue;
    }
    if (s.type === "integer") {
      if (typeof v === "string" && /^-?\d+$/.test(v)) v = Number(v);
      if (!Number.isInteger(v)) throw new ArgError(`"${key}" must be an integer`);
      if (s.minimum !== undefined && v < s.minimum) throw new ArgError(`"${key}" must be ≥ ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) throw new ArgError(`"${key}" must be ≤ ${s.maximum}`);
    } else if (s.type === "boolean") {
      if (v === "true" || v === "false") v = v === "true";
      if (typeof v !== "boolean") throw new ArgError(`"${key}" must be true or false`);
    } else if (s.type === "string") {
      if (typeof v !== "string") throw new ArgError(`"${key}" must be a string`);
      if (s.enum && !s.enum.includes(v)) throw new ArgError(`"${key}" must be one of: ${s.enum.join(", ")}`);
      if (s.pattern && !new RegExp(s.pattern).test(v)) throw new ArgError(`"${key}" has the wrong format`);
    }
    out[key] = v;
  }
  return out;
}
class ArgError extends Error {}

// ---------- JSON-RPC / MCP ----------
type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: any };
const rpcResult = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handleRpc(msg: Rpc, mb: ManageBac): Promise<object | null> {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return msg && "id" in msg ? rpcError(msg.id, -32600, "Invalid request") : null;
  }
  const isNotification = !("id" in msg);
  if (isNotification) return null;
  const { id, method, params } = msg;
  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "managebac", title: "ManageBac", version: "1.1.0" },
        instructions:
          "Tools for the student's ManageBac account at their school. Times are in the school's timezone (get_overview reports it). Use get_overview for what's due; list_tasks view=past for grades and teacher comments; list_notifications for recent updates.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
      let args: Args;
      try {
        args = prepareArgs(tool, params?.arguments);
      } catch (e) {
        return rpcError(id, -32602, (e as Error).message);
      }
      try {
        const data = await tool.run(mb, args);
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(data, null, 1) }] });
      } catch (e) {
        const text = e instanceof LoginError ? `Login problem: ${e.message}` : `Error: ${(e as Error)?.message ?? e}`;
        return rpcResult(id, { isError: true, content: [{ type: "text", text }] });
      }
    }
    case "resources/list":
      return rpcResult(id, { resources: [] });
    case "prompts/list":
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!env.MCP_SECRET || env.MCP_SECRET.length < 16) {
      return new Response("Set a MCP_SECRET secret (at least 16 characters) first.", { status: 500 });
    }
    if (url.pathname !== `/mcp/${env.MCP_SECRET}`) return new Response("Not found", { status: 404 });
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(rpcError(null, -32700, "Parse error"), 400);
    }
    let mb: ManageBac;
    try {
      mb = new ManageBac(env);
    } catch (e) {
      return json(rpcError(null, -32603, (e as Error).message), 500);
    }
    const batch = Array.isArray(body);
    const msgs = (batch ? body : [body]) as Rpc[];
    const replies = (await Promise.all(msgs.map((m) => handleRpc(m, mb)))).filter((r): r is object => r !== null);
    ctx.waitUntil(mb.flush());
    if (!replies.length) return new Response(null, { status: 202 });
    return json(batch ? replies : replies[0]);
  },
};
