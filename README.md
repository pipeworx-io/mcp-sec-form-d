# mcp-sec-form-d

SEC Form D fundraising intelligence.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1395+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `form_d_recent_raises` | Recent SEC Form D exempt-offering notices, newest first, hydrated from official filing XML with offering amount, amount sold, investors, security types, industry, issuer and related persons. A Form D is a self-reported offering notice—not proof that a financing round closed. Amendments are labeled and must not be double-counted. |
| `form_d_search_issuers` | Search live SEC Form D filings by issuer, executive, fund, or other filing text and return normalized offering notices. Useful for private-company financing diligence and VC market scans. Results are notices, not independently verified closed rounds. |
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

Or connect to the full Pipeworx gateway for access to all 1395+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Sec Form D data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [All tools and guides](https://github.com/pipeworx-io/examples)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
