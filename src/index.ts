interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * SEC Form D fundraising intelligence.
 *
 * Live data comes from SEC EDGAR full-text search, filer submissions JSON,
 * and the official Form D XML filing. A Form D is a notice of an exempt
 * offering; it is not evidence that a financing round closed.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'SEC Form D');
}


const EFTS = 'https://efts.sec.gov/LATEST/search-index';
const SEC_DATA = 'https://data.sec.gov';
const SEC_ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';
const SEC_UA = 'Pipeworx/1.0 (support@pipeworx.io)';
const MAX_BODY_BYTES = 2_000_000;
// EDGAR full-text search reports at most this many total hits and returns the
// ceiling itself as the count once a window exceeds it.
const EFTS_TOTAL_CAP = 10_000;

const offeringOutputSchema = {
  type: 'object',
  properties: {
    accession_number: { type: 'string' },
    cik: { type: 'string' },
    issuer_name: { type: 'string' },
    filing_date: { type: 'string' },
    is_amendment: { type: 'boolean' },
    total_offering_amount: { type: 'number' },
    total_amount_sold: { type: 'number' },
    total_remaining: { type: 'number' },
    filing_url: { type: 'string' },
  },
  required: ['accession_number', 'cik', 'is_amendment', 'filing_url'],
};

function listOutputSchema(listKey = 'offerings'): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      returned: { type: 'number' },
      [listKey]: { type: 'array', items: offeringOutputSchema },
    },
    required: ['returned', listKey],
  };
}

// form_d_recent_raises samples rather than enumerates, so `coverage` is part of
// its contract, not commentary — a model reading only the output schema has to
// be able to see that the list may be a slice of the window (fleet #1330).
function recentRaisesOutputSchema(): Record<string, unknown> {
  const base = listOutputSchema();
  const properties = base.properties as Record<string, unknown>;
  return {
    ...base,
    properties: {
      coverage: { type: 'string', enum: ['complete', 'sample'], description: '"complete" = every Form D in `window` was inspected. "sample" = only the newest `scanned` were and the rest of `window` was never looked at.' },
      coverage_note: { type: 'string' },
      window: { type: 'object', description: 'The date range asked for.' },
      scanned_window: { type: ['object', 'null'], description: 'The date range the inspected filings actually cover. Narrower than `window` whenever `coverage` is "sample".' },
      total_search_matches: { type: 'number', description: 'Form D notices filed in `window`. NOT the number examined — that is `scanned`.' },
      scanned: { type: 'number', description: 'How many notices were actually hydrated and examined.' },
      ...properties,
    },
    required: [...(base.required as string[]), 'coverage'],
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'form_d_recent_raises',
    description:
      'Recent SEC Form D exempt-offering notices, newest first, hydrated from official filing XML with offering amount, amount sold, investors, security types, industry, issuer and related persons. SAMPLE, NOT A CENSUS: this inspects only the newest few dozen notices counting back from `until`, no matter how wide a window you ask for — ask for a month and you get roughly its final day or two. `total_search_matches` is the SIZE OF THE WINDOW, not the number examined; `scanned` is the number examined and `scanned_window` is the date range those actually cover. To cover a period densely, step through it in short windows rather than widening `since`. A Form D is a self-reported offering notice—not proof that a financing round closed. Amendments are labeled and must not be double-counted.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Start filing date YYYY-MM-DD. Default: 7 days before `until` (NOT 7 days before today — so an `until` in the past gives a sensible window instead of erroring).' },
        until: { type: 'string', description: 'End filing date YYYY-MM-DD. Default today.' },
        days: { type: 'number', description: 'Look back this many days from `until` instead of supplying `since` (1-3650). An explicit `since` wins.' },
        industry: { type: 'string', description: 'Optional case-insensitive industry substring, e.g. "Biotechnology".' },
        minimum_sold: { type: 'number', description: 'Only return offerings reporting at least this much sold, in USD. Also accepted as `min_amount`.' },
        min_amount: { type: 'number', description: 'Alias for `minimum_sold`: minimum reported amount sold in USD.' },
        include_amendments: { type: 'boolean', description: 'Include amended notices (default true).' },
        limit: { type: 'number', description: 'Results to hydrate and return (1-10, default 8).' },
      },
    },
    outputSchema: recentRaisesOutputSchema(),
  },
  {
    name: 'form_d_search_issuers',
    description:
      'Search live SEC Form D filings by issuer, executive, fund, or other filing text and return normalized offering notices. Useful for private-company financing diligence and VC market scans. Results are notices, not independently verified closed rounds.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Issuer, person, fund, or filing text to search.' },
        since: { type: 'string', description: 'Start filing date YYYY-MM-DD. Default 5 years ago.' },
        until: { type: 'string', description: 'End filing date YYYY-MM-DD. Default today.' },
        limit: { type: 'number', description: 'Results to hydrate (1-10, default 5).' },
      },
      required: ['query'],
    },
    outputSchema: listOutputSchema(),
  },
  {
    name: 'form_d_offering_detail',
    description:
      'Retrieve and normalize one official Form D XML filing by SEC accession number. Returns offering amounts, first sale, investors, exemptions, securities, issuer identity, executives/related persons, commissions, and exact SEC provenance.',
    inputSchema: {
      type: 'object',
      properties: {
        accession_number: { type: 'string', description: 'SEC accession number, e.g. 0002036057-26-000002.' },
      },
      required: ['accession_number'],
    },
    outputSchema: offeringOutputSchema,
  },
  {
    name: 'form_d_issuer_history',
    description:
      'List one private issuer’s Form D filing and amendment history from SEC submissions data, with each notice hydrated from official XML. Do not sum amendments: later notices may restate the same offering rather than represent new capital.',
    inputSchema: {
      type: 'object',
      properties: {
        cik: { type: 'string', description: 'Issuer CIK, with or without leading zeros.' },
        limit: { type: 'number', description: 'Filings to hydrate (1-20, default 10).' },
      },
      required: ['cik'],
    },
    outputSchema: listOutputSchema('filings'),
  },
  {
    name: 'form_d_related_person_search',
    description:
      'Find Form D notices mentioning an executive, promoter, director, or other related person, then return only filings whose parsed related-person list matches the name. Useful for mapping repeat founders and fund managers; relationships are filer-supplied.',
    inputSchema: {
      type: 'object',
      properties: {
        person: { type: 'string', description: 'Person name or distinctive substring.' },
        since: { type: 'string', description: 'Start filing date YYYY-MM-DD. Default 5 years ago.' },
        until: { type: 'string', description: 'End filing date YYYY-MM-DD. Default today.' },
        limit: { type: 'number', description: 'Matching filings to return (1-10, default 5).' },
      },
      required: ['person'],
    },
    outputSchema: listOutputSchema(),
  },
  {
    name: 'form_d_amendment_chains',
    description: 'Group one issuer’s recent Form D notices into original-plus-amendment chains using each filing’s previous accession number. This prevents amendments from being mistaken for separate raises; incomplete SEC recent history can leave a chain without its original.',
    inputSchema: { type: 'object', properties: {
      cik: { type: 'string' }, limit: { type: 'number', description: 'Filings to inspect (1-20, default 20).' },
    }, required: ['cik'] },
    outputSchema: { type: 'object', properties: {
      cik: { type: 'string' }, issuer_name: { type: 'string' }, returned_chains: { type: 'number' },
      chains: { type: 'array', items: { type: 'object' } }, interpretation: { type: 'string' },
    }, required: ['cik', 'returned_chains', 'chains', 'interpretation'] },
  },
  {
    name: 'form_d_latest_offering_states',
    description: 'Return only the latest filing state from each amendment-aware Form D chain for an issuer. This is a normalized regulatory snapshot, not proof that the amount sold closed or that separate chains are economically distinct rounds.',
    inputSchema: { type: 'object', properties: { cik: { type: 'string' }, limit: { type: 'number' } }, required: ['cik'] },
    outputSchema: listOutputSchema('offerings'),
  },
  {
    name: 'form_d_related_person_network',
    description: 'Summarize filer-reported related persons across one issuer’s recent Form D history, with filing and chain counts. Related persons are executives, directors, promoters, or similar roles—not disclosed investors.',
    inputSchema: { type: 'object', properties: { cik: { type: 'string' }, limit: { type: 'number' } }, required: ['cik'] },
    outputSchema: { type: 'object', properties: {
      cik: { type: 'string' }, people: { type: 'array', items: { type: 'object' } },
      interpretation: { type: 'string' },
    }, required: ['cik', 'people', 'interpretation'] },
  },
];

interface EftsHit {
  _source?: {
    adsh?: string;
    ciks?: string[];
    display_names?: string[];
    file_date?: string;
  };
}

interface ParsedOffering extends Record<string, unknown> {
  accession_number: string;
  cik: string;
  issuer_name: string | null;
  filing_date: string | null;
  is_amendment: boolean;
  total_offering_amount: number | null;
  total_amount_sold: number | null;
  total_remaining: number | null;
  related_persons: Array<Record<string, unknown>>;
  filing_url: string;
}

const RECENT_RAISES_ARGS = [
  'since', 'until', 'days', 'industry', 'minimum_sold', 'min_amount', 'include_amendments', 'limit',
] as const;
const CIK_ARGS = ['cik', 'limit'] as const;
const SEARCH_ISSUERS_ARGS = ['query', 'since', 'until', 'limit'] as const;
const RELATED_PERSON_ARGS = ['person', 'since', 'until', 'limit'] as const;
const OFFERING_DETAIL_ARGS = ['accession_number'] as const;

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'form_d_recent_raises':
      return recentRaises(args);
    case 'form_d_search_issuers':
      checkArgs(args, SEARCH_ISSUERS_ARGS);
      return searchIssuers(args);
    case 'form_d_offering_detail':
      checkArgs(args, OFFERING_DETAIL_ARGS);
      return offeringDetail(requiredString(args, 'accession_number'));
    case 'form_d_issuer_history':
      checkArgs(args, CIK_ARGS);
      return issuerHistory(args);
    case 'form_d_related_person_search':
      checkArgs(args, RELATED_PERSON_ARGS);
      return relatedPersonSearch(args);
    case 'form_d_amendment_chains':
      checkArgs(args, CIK_ARGS);
      return amendmentChains(args);
    case 'form_d_latest_offering_states':
      checkArgs(args, CIK_ARGS);
      return latestOfferingStates(args);
    case 'form_d_related_person_network':
      checkArgs(args, CIK_ARGS);
      return relatedPersonNetwork(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function amendmentChains(args: Record<string, unknown>) {
  const history = await issuerHistory({ ...args, limit: intArg(args.limit, 20, 1, 20) }) as Record<string, any>;
  const filings = history.filings as ParsedOffering[];
  const byId = new Map(filings.map((f) => [f.accession_number, f]));
  const rootOf = (filing: ParsedOffering) => {
    let current = filing; const seen = new Set<string>();
    while (typeof current.previous_accession_number === 'string' && !seen.has(current.accession_number)) {
      seen.add(current.accession_number);
      const previous = byId.get(normalizeAccession(current.previous_accession_number));
      if (!previous) return normalizeAccession(current.previous_accession_number);
      current = previous;
    }
    return current.accession_number;
  };
  const grouped = new Map<string, ParsedOffering[]>();
  for (const filing of filings) {
    const root = rootOf(filing);
    grouped.set(root, [...(grouped.get(root) ?? []), filing]);
  }
  const chains = [...grouped.entries()].map(([root_accession_number, members]) => {
    members.sort((a, b) => String(a.filing_date ?? '').localeCompare(String(b.filing_date ?? '')));
    const latest = members.at(-1)!;
    return {
      root_accession_number,
      original_present: byId.has(root_accession_number),
      filing_count: members.length,
      latest_accession_number: latest.accession_number,
      latest_filing: latest,
      filings: members,
    };
  }).sort((a, b) => String(b.latest_filing.filing_date ?? '').localeCompare(String(a.latest_filing.filing_date ?? '')));
  return {
    cik: history.cik, issuer_name: history.issuer_name, returned_chains: chains.length, chains,
    interpretation: 'Filings are linked only through filer-supplied previous accession numbers within the bounded SEC history returned. Each chain is one notice plus amendments and should not be summed. Separate chains are notices, not verified closed rounds.',
  };
}

async function latestOfferingStates(args: Record<string, unknown>) {
  const result = await amendmentChains(args) as Record<string, any>;
  const offerings = result.chains.map((chain: Record<string, any>) => chain.latest_filing);
  return {
    cik: result.cik, issuer_name: result.issuer_name, returned: offerings.length, offerings,
    interpretation: result.interpretation,
  };
}

async function relatedPersonNetwork(args: Record<string, unknown>) {
  const result = await amendmentChains(args) as Record<string, any>;
  const people = new Map<string, { name: string; relationships: Set<string>; filings: Set<string>; chains: Set<string> }>();
  for (const chain of result.chains as Array<Record<string, any>>) {
    for (const filing of chain.filings as ParsedOffering[]) {
      for (const person of filing.related_persons) {
        const name = String(person.name ?? '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        const entry = people.get(key) ?? { name, relationships: new Set(), filings: new Set(), chains: new Set() };
        for (const role of (person.relationships as string[] ?? [])) entry.relationships.add(role);
        entry.filings.add(filing.accession_number); entry.chains.add(chain.root_accession_number);
        people.set(key, entry);
      }
    }
  }
  return {
    cik: result.cik,
    people: [...people.values()].map((p) => ({
      name: p.name, relationships: [...p.relationships], filing_count: p.filings.size,
      offering_chain_count: p.chains.size, accession_numbers: [...p.filings],
    })).sort((a, b) => b.offering_chain_count - a.offering_chain_count || b.filing_count - a.filing_count),
    interpretation: 'These are filer-reported related persons and roles, not investors or proof of employment. Amendment repetitions are collapsed into offering-chain counts.',
  };
}

async function recentRaises(args: Record<string, unknown>) {
  checkArgs(args, RECENT_RAISES_ARGS);
  const until = dateArg(args.until, today());
  // `days` is a relative window measured back from `until`. An explicit `since`
  // always wins, so passing both is unambiguous rather than silently one of them.
  const days = args.days == null ? null : intArg(args.days, 7, 1, 3650);
  // Both defaults hang off `until`, never off real today. They used to differ:
  // `days` measured back from `until` but a bare `since` fell back to 7 days
  // before TODAY, so any historical query — `until` older than a week, no
  // `since` — died on "since (2026-08-29) is after until (2026-08-21)", an
  // error about an argument the caller never passed (fleet #1330).
  const since = dateArg(args.since, daysBefore(until, days ?? 7));
  if (since > until) throw new Error(`since (${since}) is after until (${until})`);
  const limit = intArg(args.limit, 8, 1, 10);
  const industry = stringArg(args.industry)?.toLowerCase();
  const minimumSold = amountArg(args.minimum_sold ?? args.min_amount, 'minimum_sold');
  const includeAmendments = args.include_amendments !== false;
  // Filters run on hydrated XML, which is one SEC fetch per filing, so the scan
  // is bounded. Scan wider when a filter is on: at limit*3 an amount floor was
  // choosing from ~24 notices out of thousands and returning a near-empty list
  // that read as "almost nothing qualifies" (fleet #1004).
  const filtering = industry != null || minimumSold != null || !includeAmendments;
  const scan = filtering ? Math.min(60, limit * 6) : Math.min(30, limit * 3);
  const search = await searchFormD('', since, until, scan);
  const hydrated = await hydrateHits(search.hits);
  const matched = hydrated
    .filter((row) => includeAmendments || !row.is_amendment)
    .filter((row) => !industry || String(row.industry_group ?? '').toLowerCase().includes(industry)
      || String(row.investment_fund_type ?? '').toLowerCase().includes(industry))
    .filter((row) => minimumSold == null || (row.total_amount_sold ?? -1) >= minimumSold);
  const offerings = matched.slice(0, limit);
  // EDGAR full-text search saturates its total at 10,000 and reports the cap as
  // if it were a count: 30 days returns a true 4,578, 365 days returns exactly
  // 10,000. Handing that back unmarked gives the caller a wrong denominator —
  // they read "30 of 10,000" as 0.3% coverage of a year when the real
  // population is several times that. Measured 2026-09-07.
  const totalIsCapped = search.total >= EFTS_TOTAL_CAP;
  // The dates the scan ACTUALLY reached, as opposed to the dates asked for.
  // This is the whole defect in one field: hits come back newest-first, so a
  // 27-day window scanned 60 deep covers its last day or two and says nothing
  // about the other 25 — and the answer is well-formed, correctly sorted and
  // plausible either way (fleet #1330, failure_mode: silent). Reporting
  // `scanned` alongside `total_search_matches` was not enough: it made the
  // shortfall DERIVABLE by comparing two numbers, which is not the same as
  // stating it, and a caller who never suspected sampling has no reason to
  // divide one by the other.
  const scannedDates = hydrated.map((row) => String(row.filing_date ?? '')).filter(Boolean).sort();
  const scannedWindow = scannedDates.length
    ? { since: scannedDates[0], until: scannedDates[scannedDates.length - 1] }
    : null;
  // A census only when EDGAR's own count for the window fits inside what we
  // hydrated — and never when that count is the 10,000 ceiling, since then the
  // true population is unknown and larger.
  const isCensus = !totalIsCapped && search.total <= hydrated.length;
  return {
    window: { since, until },
    // 'complete' = every Form D in `window` was inspected. 'sample' = only the
    // newest `scanned` were, and the rest of `window` was never looked at.
    coverage: isCensus ? 'complete' : 'sample',
    coverage_note: isCensus
      ? `Complete: all ${search.total} Form D notices filed in ${since}..${until} were inspected.`
      : `SAMPLE, NOT A CENSUS. Inspected the ${hydrated.length} newest notices in ${since}..${until}${scannedWindow ? `, which only reach back to ${scannedWindow.since}` : ''} — out of ${totalIsCapped ? `${EFTS_TOTAL_CAP}+` : search.total} filed across the window you asked for. The rest of the window was NOT examined, so anything missing from this list may simply never have been looked at. Widening \`since\` widens the date range searched and does NOT scan more filings; step through the period in short windows to cover it densely.`,
    // The dates actually reached, so sample-vs-census does not have to be
    // inferred by comparing `scanned` against `total_search_matches`.
    scanned_window: scannedWindow,
    total_search_matches: search.total,
    total_search_matches_note: 'Size of the date window, NOT the number examined. Compare with `scanned`.',
    total_is_capped: totalIsCapped,
    // How far down the window we actually looked. `total_search_matches` counts
    // every Form D in the window, filtered or not — without these a caller
    // cannot tell "few qualify" from "we only inspected the newest few".
    scanned: hydrated.length,
    matched_in_scan: matched.length,
    filters_applied: compactFilters({ industry, minimum_sold: minimumSold, include_amendments: includeAmendments }),
    returned: offerings.length,
    // The coverage caveat used to appear ONLY when a filter was on, but the
    // bound is the same either way — `since`/`days` widen the DATE RANGE and
    // never the scan, so a caller asking for a year still inspects the newest
    // few dozen notices. Reported as a defect by a paying caller (feedback
    // #109) precisely because an unfiltered call disclosed nothing.
    interpretation: `${interpretation()} Inspected the ${hydrated.length} newest notices in this window, not all ${totalIsCapped ? `${EFTS_TOTAL_CAP}+` : search.total} — widening \`since\`/\`days\` widens the date range searched, it does NOT scan more filings, so a short list here means "few qualify among the newest inspected", never "few exist". Narrow the window to inspect a given period densely.${totalIsCapped
      ? ` Note ${EFTS_TOTAL_CAP} is EDGAR's reported-total ceiling, not the true count — the real population for this window is larger.`
      : ''}`,
    offerings,
  };
}

function compactFilters(filters: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(filters).filter(([key, value]) =>
    value != null && !(key === 'include_amendments' && value === true)));
}

async function searchIssuers(args: Record<string, unknown>) {
  const query = requiredString(args, 'query');
  const until = dateArg(args.until, today());
  const since = dateArg(args.since, yearsAgo(5));
  const limit = intArg(args.limit, 5, 1, 10);
  const search = await searchFormD(query, since, until, limit);
  const offerings = (await hydrateHits(search.hits)).slice(0, limit);
  return { query, window: { since, until }, total_search_matches: search.total, returned: offerings.length, offerings };
}

async function relatedPersonSearch(args: Record<string, unknown>) {
  const person = requiredString(args, 'person');
  const until = dateArg(args.until, today());
  const since = dateArg(args.since, yearsAgo(5));
  const limit = intArg(args.limit, 5, 1, 10);
  const search = await searchFormD(person, since, until, Math.min(30, limit * 3));
  const needle = person.toLowerCase();
  const offerings = (await hydrateHits(search.hits))
    .filter((row) => row.related_persons.some((p) => String(p.name ?? '').toLowerCase().includes(needle)))
    .slice(0, limit);
  return { person, window: { since, until }, returned: offerings.length, offerings };
}

async function issuerHistory(args: Record<string, unknown>) {
  const cik = normalizeCik(requiredString(args, 'cik'));
  const limit = intArg(args.limit, 10, 1, 20);
  const submission = await secJson(`${SEC_DATA}/submissions/CIK${cik}.json`) as {
    name?: string;
    filings?: { recent?: { accessionNumber?: string[]; filingDate?: string[]; form?: string[] } };
  };
  const recent = submission.filings?.recent;
  const accessions = (recent?.accessionNumber ?? [])
    .map((accession, index) => ({
      accession,
      filing_date: recent?.filingDate?.[index] ?? null,
      form: recent?.form?.[index] ?? '',
    }))
    .filter((row) => row.form === 'D' || row.form === 'D/A')
    .slice(0, limit);
  const filings = await Promise.all(accessions.map((row) => offeringDetail(row.accession, row.filing_date)));
  return {
    cik,
    issuer_name: submission.name ?? null,
    returned: filings.length,
    interpretation: `${interpretation()} Later filings may amend or restate an earlier offering; do not sum them.`,
    filings,
  };
}

async function searchFormD(query: string, since: string, until: string, requested: number) {
  const params = new URLSearchParams({
    q: query,
    forms: 'D',
    dateRange: 'custom',
    startdt: since,
    enddt: until,
    from: '0',
    size: String(Math.min(100, requested)),
  });
  const data = await secJson(`${EFTS}?${params}`) as {
    hits?: { total?: { value?: number }; hits?: EftsHit[] };
  };
  return {
    total: data.hits?.total?.value ?? 0,
    hits: (data.hits?.hits ?? []).slice(0, requested),
  };
}

async function hydrateHits(hits: EftsHit[]): Promise<ParsedOffering[]> {
  const settled = await Promise.allSettled(hits.map(async (hit) => {
    const source = hit._source ?? {};
    const accession = source.adsh;
    if (!accession) throw new Error('SEC search result omitted accession number');
    return offeringDetail(accession, source.file_date ?? null);
  }));
  return settled
    .filter((result): result is PromiseFulfilledResult<ParsedOffering> => result.status === 'fulfilled')
    .map((result) => result.value);
}

async function offeringDetail(accessionInput: string, filingDate: string | null = null): Promise<ParsedOffering> {
  const accession = normalizeAccession(accessionInput);
  const cik = accession.slice(0, 10);
  const filingUrl = `${SEC_ARCHIVES}/${Number(cik)}/${accession.replaceAll('-', '')}/primary_doc.xml`;
  const xml = await secText(filingUrl);
  const relatedPersons = blocks(xml, 'relatedPersonInfo').map((block) => ({
    name: [
      tag(block, 'firstName'),
      tag(block, 'middleName'),
      tag(block, 'lastName'),
    ].filter(Boolean).join(' ') || null,
    relationships: tags(block, 'relationship'),
    clarification: tag(block, 'relationshipClarification'),
  }));
  const securities = [
    ['isEquityType', 'Equity'],
    ['isDebtType', 'Debt'],
    ['isOptionToAcquireType', 'Option to Acquire'],
    ['isSecurityToBeAcquiredType', 'Security to be Acquired'],
    ['isPooledInvestmentFundType', 'Pooled Investment Fund'],
    ['isTenantInCommonType', 'Tenant in Common'],
    ['isMineralPropertyType', 'Mineral Property'],
    ['isOtherType', 'Other'],
  ].filter(([xmlTag]) => boolTag(xml, xmlTag)).map(([, label]) => label);
  return compact({
    accession_number: accession,
    cik,
    issuer_name: tag(xml, 'entityName'),
    filing_date: filingDate,
    submission_type: tag(xml, 'submissionType'),
    is_amendment: boolTag(xml, 'isAmendment'),
    previous_accession_number: tag(xml, 'previousAccessionNumber'),
    jurisdiction: tag(xml, 'jurisdictionOfInc'),
    entity_type: tag(xml, 'entityType'),
    year_of_incorporation: numberTag(block(xml, 'yearOfInc'), 'value'),
    industry_group: tag(xml, 'industryGroupType'),
    investment_fund_type: tag(xml, 'investmentFundType'),
    revenue_range: tag(xml, 'revenueRange'),
    federal_exemptions: tags(block(xml, 'federalExemptionsExclusions'), 'item'),
    date_of_first_sale: tag(block(xml, 'dateOfFirstSale'), 'value'),
    more_than_one_year: boolTag(xml, 'moreThanOneYear'),
    securities_offered: securities,
    minimum_investment: numberTag(xml, 'minimumInvestmentAccepted'),
    total_offering_amount: amountTag(xml, 'totalOfferingAmount'),
    total_amount_sold: amountTag(xml, 'totalAmountSold'),
    total_remaining: amountTag(xml, 'totalRemaining'),
    non_accredited_investors: boolTag(xml, 'hasNonAccreditedInvestors'),
    investors_already_invested: numberTag(xml, 'totalNumberAlreadyInvested'),
    sales_commissions: amountTag(block(xml, 'salesCommissions'), 'dollarAmount'),
    finders_fees: amountTag(block(xml, 'findersFees'), 'dollarAmount'),
    related_persons: relatedPersons,
    signer: tag(xml, 'nameOfSigner'),
    signature_date: tag(xml, 'signatureDate'),
    filing_url: filingUrl.replace(/primary_doc\.xml$/, ''),
    xml_url: filingUrl,
    interpretation: interpretation(),
  }) as ParsedOffering;
}

async function secJson(url: string): Promise<unknown> {
  const response = await pwFetch(url, { headers: { Accept: 'application/json', 'User-Agent': SEC_UA } });
  if (!response.ok) throw new Error(`SEC API ${response.status}: ${url}`);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES * 3) throw new Error('SEC response exceeds size limit');
  return response.json();
}

async function secText(url: string): Promise<string> {
  const response = await pwFetch(url, { headers: { Accept: 'application/xml,text/xml', 'User-Agent': SEC_UA } });
  if (response.status === 404) throw new Error(`Form D filing not found: ${url}`);
  if (!response.ok) throw new Error(`SEC archive ${response.status}: ${url}`);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) throw new Error('Form D XML exceeds 2 MB limit');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_BODY_BYTES) throw new Error('Form D XML exceeds 2 MB limit');
  return new TextDecoder().decode(bytes);
}

function tag(xml: string, name: string): string | null {
  const value = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1];
  return value == null ? null : decodeXml(value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()) || null;
}

function tags(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'gi'))]
    .map((match) => decodeXml(match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()))
    .filter(Boolean);
}

function block(xml: string, name: string): string {
  return xml.match(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}>`, 'i'))?.[0] ?? '';
}

function blocks(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}>`, 'gi'))].map((match) => match[0]);
}

function boolTag(xml: string, name: string): boolean {
  return tag(xml, name)?.toLowerCase() === 'true';
}

function numberTag(xml: string, name: string): number | null {
  const value = tag(xml, name);
  if (value == null || value === 'Indefinite') return null;
  const parsed = Number(value.replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function amountTag(xml: string, name: string): number | null {
  return numberTag(xml, name);
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function normalizeAccession(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 18) throw new Error('accession_number must contain 18 digits');
  return `${digits.slice(0, 10)}-${digits.slice(10, 12)}-${digits.slice(12)}`;
}

function normalizeCik(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (!digits || digits.length > 10) throw new Error('cik must contain 1-10 digits');
  return digits.padStart(10, '0');
}

function interpretation(): string {
  return 'Form D is a filer-supplied notice of an exempt offering, not independent verification that a financing closed. Amount sold is the amount reported as of this filing; amendments may restate the same offering.';
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) =>
    item !== null && item !== undefined && (!Array.isArray(item) || item.length > 0))) as T;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = stringArg(args[key]);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function stringArg(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// A misspelled or invented argument used to be dropped on the floor: the caller
// got a clean 200 computed from the defaults and no way to tell. Say so instead.
// Gateway-injected arguments are all underscore-prefixed and are not the caller's.
function checkArgs(args: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(args).filter((key) => !key.startsWith('_') && !allowed.includes(key));
  if (!unknown.length) return;
  throw new Error(
    `Unknown argument${unknown.length > 1 ? 's' : ''} ${unknown.map((key) => `"${key}"`).join(', ')} `
    + `for this tool. Accepted arguments: ${allowed.join(', ')}.`,
  );
}

// A non-numeric amount would otherwise compare false against every row and
// return an empty list that looks like a real answer.
function amountArg(value: unknown, name: string): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'string' ? Number(value.replace(/[$,_\s]/g, '')) : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number in USD, got ${JSON.stringify(value)}`);
  return Math.max(0, parsed);
}

function intArg(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
}

function dateArg(value: unknown, fallback: string): string {
  const result = stringArg(value) ?? fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new Error('dates must use YYYY-MM-DD');
  return result;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBefore(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

function yearsAgo(years: number): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

export default { tools, callTool, meter: { credits: 4 } } satisfies McpToolExport;
