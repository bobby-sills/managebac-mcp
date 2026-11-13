// ManageBac MCP server for Cloudflare Workers, built on the official MCP TypeScript SDK.
// Stateless Streamable HTTP: each request gets a fresh server + transport.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { ManageBac, Env, LoginError } from "./client";
import { parseTaskTiles, parseClasses, mainContent, parseTimetable, htmlToText, TaskTile } from "./parse";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const READ = { readOnlyHint: true, openWorldHint: true };

type Args = Record<string, any>;
interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
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
    inputSchema: {},
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
      view: z.enum(["upcoming", "overdue", "past"]).default("upcoming"),
      page: z.number().int().min(1).default(1).describe("Page number (mostly useful for view=past)"),
      include_comments: z.boolean().default(true).describe("Include teacher comments shown on the tile"),
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
    inputSchema: { class_id: z.number().int(), task_id: z.number().int() },
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
      start: z.string().regex(DATE).optional().describe("YYYY-MM-DD"),
      end: z.string().regex(DATE).optional().describe("YYYY-MM-DD"),
      description_chars: z.number().int().min(0).max(5000).default(400).describe("How much of each description to include (0 = none)"),
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
      kind: z.enum(["unread", "read", "starred", "all"]).default("unread"),
      page: z.number().int().min(1).default(1),
      per_page: z.number().int().min(1).max(100).default(20),
      full_body: z.boolean().default(false),
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
    inputSchema: { notification_id: z.number().int() },
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
    inputSchema: {},
    annotations: READ,
    run: async (mb) => parseClasses(await mb.html("/student/classes/my"), mb.base),
  },
  {
    name: "get_class",
    title: "Class page",
    description:
      "Read a section of one class: overview, class_stream (teacher posts), units, tasks (all tasks in the class), discussions, files, or members.",
    inputSchema: {
      class_id: z.number().int(),
      section: z.enum(["overview", "class_stream", "units", "tasks", "discussions", "files", "members"]).default("overview"),
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
    inputSchema: { start_date: z.string().regex(DATE).optional().describe("YYYY-MM-DD") },
    annotations: READ,
    run: async (mb, a) => parseTimetable(await mb.html(`/student/timetables/weekly?start_date=${a.start_date ?? todayLocal(await mb.timezone())}`)),
  },
  {
    name: "get_page",
    title: "Read any student page",
    description:
      "Fallback reader for any ManageBac student page, e.g. /student/profile (reports, academic overview), /student/ib/activity/sa (Service as Action), /student/portfolio, /student/ib/pbl/... (Personal Project). Path must start with /student/.",
    inputSchema: { path: z.string().regex(/^\/student\//) },
    annotations: READ,
    run: async (mb, a) => ({ ...mainContent(await mb.html(a.path), mb.base), url: mb.base + a.path }),
  },
];

function buildServer(mb: ManageBac): McpServer {
  const server = new McpServer(
    { name: "managebac", title: "ManageBac", version: "1.1.0" },
    {
      instructions:
        "Tools for the student's ManageBac account at their school. Times are in the school's timezone (get_overview reports it). Use get_overview for what's due; list_tasks view=past for grades and teacher comments; list_notifications for recent updates.",
    }
  );
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
      async (args: Args) => {
        try {
          const data = await tool.run(mb, args);
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }] };
        } catch (e) {
          const text = e instanceof LoginError ? `Login problem: ${e.message}` : `Error: ${(e as Error)?.message ?? e}`;
          return { isError: true, content: [{ type: "text" as const, text }] };
        }
      }
    );
  }
  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!env.MCP_SECRET || env.MCP_SECRET.length < 16) {
      return new Response("Set a MCP_SECRET secret (at least 16 characters) first.", { status: 500 });
    }
    if (url.pathname !== `/mcp/${env.MCP_SECRET}`) return new Response("Not found", { status: 404 });

    let mb: ManageBac;
    try {
      mb = new ManageBac(env);
    } catch (e) {
      return new Response((e as Error).message, { status: 500 });
    }
    const server = buildServer(mb);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const res = await transport.handleRequest(request);
    ctx.waitUntil(mb.flush());
    return res;
  },
};
