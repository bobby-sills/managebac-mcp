// ManageBac client: logs in with your school username/password, keeps the
// session cookies (in KV, so all Worker instances share one login), and
// transparently signs in again when the session expires.

export interface Env {
  MB_HOST: string; // your school's ManageBac address, e.g. "yourschool.managebac.com"
  MB_LOGIN: string; // secret
  MB_PASSWORD: string; // secret
  MCP_SECRET: string; // secret, part of the connector URL
  SESSION: KVNamespace;
}

interface SessionState {
  cookies: Record<string, string>;
  mnnToken?: string;
  mnnEndpoint?: string;
  timezone?: string;
  savedAt: number;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const KV_KEY = "mb-session";

export class LoginError extends Error {}

export class ManageBac {
  private state: SessionState | null = null;
  private loginPromise: Promise<void> | null = null;
  readonly base: string;

  constructor(private env: Env) {
    const host = (env.MB_HOST ?? "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!/^[\w-]+(\.[\w-]+)+$/.test(host)) throw new LoginError("Set MB_HOST to your school's ManageBac address, e.g. yourschool.managebac.com");
    this.env = { ...env, MB_HOST: host };
    this.base = `https://${host}`;
  }

  // ---------- cookie helpers ----------
  private cookieHeader(): string {
    return Object.entries(this.state?.cookies ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  private absorbCookies(res: Response, jar: Record<string, string>) {
    const list: string[] =
      typeof (res.headers as any).getSetCookie === "function"
        ? (res.headers as any).getSetCookie()
        : (res.headers.get("set-cookie") ?? "").split(/,(?=\s*[\w.-]+=)/);
    for (const raw of list) {
      const first = raw.split(";")[0];
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      const expired = /max-age=0/i.test(raw) || /expires=Thu, 01 Jan 1970/i.test(raw);
      if (expired || value === "" || value === "deleted") delete jar[name];
      else jar[name] = value;
    }
  }

  private async loadState(): Promise<void> {
    if (this.state) return;
    const saved = await this.env.SESSION.get<SessionState>(KV_KEY, "json");
    if (saved) this.state = saved;
  }

  private async saveState() {
    if (this.state)
      await this.env.SESSION.put(KV_KEY, JSON.stringify(this.state), {
        expirationTtl: 60 * 60 * 24 * 30,
      });
  }

  // ---------- login ----------
  async login(): Promise<void> {
    if (!this.loginPromise) {
      this.loginPromise = this.doLogin().finally(() => (this.loginPromise = null));
    }
    return this.loginPromise;
  }

  private async doLogin(): Promise<void> {
    if (!this.env.MB_LOGIN || !this.env.MB_PASSWORD)
      throw new LoginError("MB_LOGIN / MB_PASSWORD secrets are not set on the Worker.");
    const jar: Record<string, string> = {};
    const hdr = () => ({
      "User-Agent": UA,
      Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "),
    });

    const page = await fetch(`${this.base}/login`, { headers: hdr(), redirect: "manual" });
    this.absorbCookies(page, jar);
    const html = await page.text();
    const token =
      html.match(/name="authenticity_token"[^>]*value="([^"]+)"/)?.[1] ??
      html.match(/value="([^"]+)"[^>]*name="authenticity_token"/)?.[1] ??
      html.match(/<meta name="csrf-token" content="([^"]+)"/)?.[1];
    if (!token) throw new LoginError(`Could not read the login form (HTTP ${page.status}).`);

    const body = new URLSearchParams({
      authenticity_token: decodeEntities(token),
      login: this.env.MB_LOGIN,
      password: this.env.MB_PASSWORD,
      remember_me: "1",
      commit: "Sign in",
    });
    const res = await fetch(`${this.base}/sessions`, {
      method: "POST",
      redirect: "manual",
      headers: {
        ...hdr(),
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: this.base,
        Referer: `${this.base}/login`,
        Accept: "text/html,application/xhtml+xml",
      },
      body,
    });
    this.absorbCookies(res, jar);
    const loc = res.headers.get("location") ?? "";
    if (!(res.status >= 300 && res.status < 400) || /\/login/.test(loc)) {
      throw new LoginError(
        "ManageBac rejected the sign-in. Check MB_LOGIN / MB_PASSWORD (the school may also have turned on SSO or 2-step verification)."
      );
    }
    this.state = { cookies: jar, savedAt: Date.now() };
    // Follow the redirect once so any extra cookies get set, and grab the notifications token.
    await this.refreshMnnToken();
    await this.saveState();
  }

  // ---------- requests ----------
  /** GET a ManageBac page/JSON (path starting with "/"), re-logging in if needed. */
  async get(path: string, accept = "text/html"): Promise<Response> {
    await this.loadState();
    if (!this.state) await this.login();
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.followGet(path, accept);
      if (res) return res;
      await this.login(); // session expired
    }
    throw new LoginError("Signed in, but ManageBac keeps sending us back to the login page.");
  }

  /** Returns null when the session is no longer valid. */
  private async followGet(path: string, accept: string): Promise<Response | null> {
    let url = new URL(path, this.base).toString();
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(url, {
        redirect: "manual",
        headers: { "User-Agent": UA, Cookie: this.cookieHeader(), Accept: accept },
      });
      if (this.state) this.absorbCookies(res, this.state.cookies);
      if (res.status === 401) return null;
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location") ?? "";
        if (/\/login|\/sessions\/new/.test(loc)) return null;
        url = new URL(loc, url).toString();
        continue;
      }
      if (new URL(url).host !== this.env.MB_HOST)
        throw new Error(`Unexpected redirect to ${new URL(url).host}`);
      return res;
    }
    throw new Error("Too many redirects");
  }

  async html(path: string): Promise<string> {
    const res = await this.get(path);
    if (!res.ok) throw new Error(`ManageBac returned HTTP ${res.status} for ${path}`);
    return res.text();
  }

  async json<T = unknown>(path: string): Promise<T> {
    const res = await this.get(path, "application/json");
    if (!res.ok) throw new Error(`ManageBac returned HTTP ${res.status} for ${path}`);
    return res.json() as Promise<T>;
  }

  // ---------- notifications service (separate host, bearer token) ----------
  private async refreshMnnToken() {
    const res = await this.followGet("/student/home", "text/html");
    if (!res) throw new LoginError("Session not valid after sign-in.");
    const html = await res.text();
    const tag = html.match(/<a[^>]*js-messages-and-notifications-trigger[^>]*>/)?.[0] ?? "";
    const token = tag.match(/data-token="([^"]+)"/)?.[1];
    const endpoint = tag.match(/data-mnn-hub-endpoint="([^"]+)"/)?.[1];
    const tz = tag.match(/data-timezone="([^"]+)"/)?.[1];
    if (this.state && token && endpoint) {
      this.state.mnnToken = token;
      this.state.mnnEndpoint = endpoint;
    }
    if (this.state && tz) this.state.timezone = tz;
  }

  async mnn<T = unknown>(path: string, method = "GET"): Promise<T> {
    await this.loadState();
    if (!this.state) await this.login();
    if (!this.state!.mnnToken) {
      await this.refreshMnnToken();
      await this.saveState();
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = this.state!;
      if (!s.mnnToken || !s.mnnEndpoint) throw new Error("Could not find the notifications token.");
      const res = await fetch(`${s.mnnEndpoint}/api/frontend/v2/${path}`, {
        method,
        headers: { Authorization: `Bearer ${s.mnnToken}`, Accept: "application/json", "User-Agent": UA },
      });
      if (res.status === 401 || res.status === 403) {
        await this.refreshMnnToken().catch(() => this.login());
        await this.saveState();
        continue;
      }
      if (!res.ok) throw new Error(`Notifications service returned HTTP ${res.status}`);
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    }
    throw new Error("Notifications service keeps rejecting the token.");
  }

  /** The school's timezone as ManageBac reports it (e.g. "Asia/Bangkok"). */
  async timezone(): Promise<string> {
    await this.loadState();
    if (!this.state) await this.login();
    if (!this.state!.timezone) {
      await this.refreshMnnToken();
      await this.saveState();
    }
    return this.state!.timezone ?? "UTC";
  }

  /** Persist any cookie refreshes picked up during this request. */
  async flush() {
    if (this.state) await this.saveState();
  }
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
