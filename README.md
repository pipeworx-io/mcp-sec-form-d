# mcp-sec-form-d

SEC Form D fundraising intelligence.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1857+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

| Tool | Description |
|------|-------------|
| `form_d_recent_raises` | Recent SEC Form D exempt-offering notices, newest first, hydrated from official filing XML with offering amount, amount sold, investors, security types, industry, issuer and related persons. SAMPLE, NOT A CENSUS: this inspects only the newest few dozen notices counting back from `until`, no matter how wide a window you ask for — ask for a month and you get roughly its final day or two. `total_search_matches` is the SIZE OF THE WINDOW, not the number examined; `scanned` is the number examined and `scanned_window` is the date range those actually cover. To cover a period densely, step through it in short windows rather than widening `since`. A Form D is a self-reported offering notice—not proof that a financing round closed. Amendments are labeled and must not be double-counted. |
| `form_d_search_issuers` | Look up a named company's or fund's SEC Form D filing by the issuer's name — what it reported: total offering amount, amount sold, number of investors already invested, date of first sale, the federal exemption claimed (Rule 506(b), 506(c), Investment Company Act 3(c)(1)/3(c)(7)), securities offered and related persons. Pass the name, e.g. "YCA26, L.P." or "Chickadee Biomedicines"; SEC EDGAR full-text search covers every Form D on file (default the last 5 years), so the issuer's filing is found wherever it sits. Also finds filings naming an executive or fund. A Form D is a self-reported offering notice, not an independently verified closed round. |
| `form_d_offering_detail` | Retrieve and normalize one official Form D XML filing by SEC accession number. Returns offering amounts, first sale, investors, exemptions, securities, issuer identity, executives/related persons, commissions, and exact SEC provenance. |
| `form_d_issuer_history` | List one private issuer’s Form D filing and amendment history from SEC submissions data, with each notice hydrated from official XML. Do not sum amendments: later notices may restate the same offering rather than represent new capital. |
| `form_d_related_person_search` | Find Form D notices mentioning an executive, promoter, director, or other related person, then return only filings whose parsed related-person list matches the name. Useful for mapping repeat founders and fund managers; relationships are filer-supplied. |
| `form_d_amendment_chains` | Group one issuer’s recent Form D notices into original-plus-amendment chains using each filing’s previous accession number. This prevents amendments from being mistaken for separate raises; incomplete SEC recent history can leave a chain without its original. |
| `form_d_latest_offering_states` | Return only the latest filing state from each amendment-aware Form D chain for an issuer. This is a normalized regulatory snapshot, not proof that the amount sold closed or that separate chains are economically distinct rounds. |
| `form_d_related_person_network` | Summarize filer-reported related persons across one issuer’s recent Form D history, with filing and chain counts. Related persons are executives, directors, promoters, or similar roles—not disclosed investors. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "sec-form-d": {
      "url": "https://gateway.pipeworx.io/sec-form-d/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/sec-form-d/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1857+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/form_d_recent_raises \
  -H 'Content-Type: application/json' \
  -d '{"since":"2026-07-01","minimum_sold":1000000,"limit":8}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/form_d_recent_raises`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-sec-form-d` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/sec-form-d/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "sec-form-d": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-sec-form-d"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Sec Form D data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
