interface McpToolDefinition {
  name: string;
  description: string;
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
 * SEC Form D fundraising intelligence.
 *
 * Live data comes from SEC EDGAR full-text search, filer submissions JSON,
 * and the official Form D XML filing. A Form D is a notice of an exempt
 * offering; it is not evidence that a financing round closed.
 */


const EFTS = 'https://efts.sec.gov/LATEST/search-index';
const SEC_DATA = 'https://data.sec.gov';
const SEC_ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';
const SEC_UA = 'Pipeworx/1.0 (support@pipeworx.io)';
const MAX_BODY_BYTES = 2_000_000;

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

const tools: McpToolExport['tools'] = [
  {
    name: 'form_d_recent_raises',
    description:
      'Recent SEC Form D exempt-offering notices, newest first, hydrated from official filing XML with offering amount, amount sold, investors, security types, industry, issuer and related persons. A Form D is a self-reported offering notice—not proof that a financing round closed. Amendments are labeled and must not be double-counted.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Start filing date YYYY-MM-DD. Default 7 days ago.' },
        until: { type: 'string', description: 'End filing date YYYY-MM-DD. Default today.' },
        industry: { type: 'string', description: 'Optional case-insensitive industry substring, e.g. "Biotechnology".' },
        minimum_sold: { type: 'number', description: 'Optional minimum reported amount sold in USD.' },
        include_amendments: { type: 'boolean', description: 'Include amended notices (default true).' },
        limit: { type: 'number', description: 'Results to hydrate and return (1-10, default 8).' },
      },
    },
    outputSchema: listOutputSchema(),
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

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'form_d_recent_raises':
      return recentRaises(args);
    case 'form_d_search_issuers':
      return searchIssuers(args);
    case 'form_d_offering_detail':
      return offeringDetail(requiredString(args, 'accession_number'));
    case 'form_d_issuer_history':
      return issuerHistory(args);
    case 'form_d_related_person_search':
      return relatedPersonSearch(args);
    case 'form_d_amendment_chains':
      return amendmentChains(args);
    case 'form_d_latest_offering_states':
      return latestOfferingStates(args);
    case 'form_d_related_person_network':
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
  const until = dateArg(args.until, today());
  const since = dateArg(args.since, daysAgo(7));
  const limit = intArg(args.limit, 8, 1, 10);
  const industry = stringArg(args.industry)?.toLowerCase();
  const minimumSold = args.minimum_sold == null ? null : Math.max(0, Number(args.minimum_sold));
  const includeAmendments = args.include_amendments !== false;
  const search = await searchFormD('', since, until, Math.min(30, limit * 3));
  const hydrated = await hydrateHits(search.hits);
  const offerings = hydrated
    .filter((row) => includeAmendments || !row.is_amendment)
    .filter((row) => !industry || String(row.industry_group ?? '').toLowerCase().includes(industry)
      || String(row.investment_fund_type ?? '').toLowerCase().includes(industry))
    .filter((row) => minimumSold == null || (row.total_amount_sold ?? -1) >= minimumSold)
    .slice(0, limit);
  return {
    window: { since, until },
    total_search_matches: search.total,
    returned: offerings.length,
    interpretation: interpretation(),
    offerings,
  };
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
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': SEC_UA } });
  if (!response.ok) throw new Error(`SEC API ${response.status}: ${url}`);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES * 3) throw new Error('SEC response exceeds size limit');
  return response.json();
}

async function secText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { Accept: 'application/xml,text/xml', 'User-Agent': SEC_UA } });
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

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function yearsAgo(years: number): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

export default { tools, callTool, meter: { credits: 4 } } satisfies McpToolExport;
