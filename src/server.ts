/**
 * The MCP server itself — every tool, transport-agnostic.
 *
 * Split out of index.ts so the same tool definitions serve BOTH transports and
 * cannot drift apart. The stdio entry point (index.ts) and the HTTP entry point
 * (http.ts) each call `createServer` and differ only in where the key comes from.
 *
 * The API key is a PARAMETER, deliberately — it used to be a module-level
 * `process.env` read shared by one long-lived client. That is correct for stdio
 * (one user, one machine, their own key) and unsafe for anything network-facing:
 * a hosted instance built that way serves every anonymous caller on the
 * operator's key, at the operator's tier. Passing it in lets http.ts build one
 * server per request, bound to that caller's key and nothing else.
 *
 * Every tool returns BOTH prose and structured content
 * ----------------------------------------------------
 * The prose is what a model reads; the structured content is what a program
 * reads without re-parsing English. Declaring an `outputSchema` is what makes
 * the latter trustworthy — but it also makes the SDK THROW on any non-error
 * result that omits `structuredContent`. Since a tier wall, a missing key and an
 * empty result are all deliberately non-error here, that trap is easy to fall
 * into eleven times. So `guard()` below emits the structured half itself, and no
 * individual tool can forget.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  BadRequest,
  LiveTennisAPI,
  NotFound,
  RateLimited,
  Unauthorized,
  UpgradeRequired,
  formatScore,
  type ArchiveMatch,
  type ArchiveParticipant,
  type Match,
  type Tournament,
} from 'livetennisapi';
import { z } from 'zod';

export const VERSION = '1.3.0';

type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** What a tool body hands back: prose for the model, fields for the program. */
type Payload = { text: string; data?: Record<string, unknown> };

/**
 * Every tool is a read. Nothing here can modify anything, so these hints are
 * simply true — they are not a claim made to look agreeable to an indexer.
 * `openWorldHint` is true because the data comes from a live external API whose
 * contents change between calls.
 */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// -- shared output field definitions -----------------------------------------
// Declared once so all 12 tools describe the same concept the same way.

const okField = z
  .boolean()
  .describe(
    'True when the call returned data. False for a tier wall, a missing or rejected key, ' +
      'or an empty result — all of which are normal states with a clear remedy, not failures.',
  );

const messageField = z
  .string()
  .describe('Human-readable summary. Identical to the text content, so either half can be used alone.');

const MatchOut = z.object({
  // Nullable, not required: the upstream type allows a match without an id, and
  // asserting otherwise would make the schema lie rather than make the data safe.
  id: z.number().nullable().describe('Match id. Pass to get_match, get_match_score, get_match_events or get_match_odds.'),
  tournament: z.string().nullable().describe('Event name, e.g. "Wimbledon".'),
  round: z.string().nullable().describe('Round within the event, e.g. "QF".'),
  player1: z.string().nullable().describe('Name of player 1.'),
  player2: z.string().nullable().describe('Name of player 2.'),
  score: z.string().nullable().describe('Formatted score line, e.g. "6-4 3-6 2-1".'),
  status: z.string().nullable().describe('One of live, upcoming or completed.'),
  surface: z.string().nullable().describe('Court surface, e.g. hard, clay, grass.'),
  indoor: z.boolean().nullable().describe('True when played indoors.'),
  serving: z.number().nullable().describe('1 or 2 while a point is in play, otherwise null.'),
  winner: z.number().nullable().describe('1 or 2 once decided, otherwise null.'),
  win_probability_p1: z
    .number()
    .nullable()
    .describe('Model probability that player 1 wins, 0-1. Requires the ULTRA plan; null otherwise.'),
});

const PlayerOut = z.object({
  id: z.number().nullable().describe('Player id. Pass to get_player.'),
  name: z.string().nullable().describe('Player name.'),
  country: z.string().nullable().describe('Country code.'),
  ranking: z.number().nullable().describe('Current singles ranking.'),
  ranking_points: z.number().nullable().describe('Ranking points.'),
  ranking_movement: z.string().nullable().describe('Recent movement in the rankings.'),
  hand: z.string().nullable().describe('"R" or "L".'),
  birthday: z.string().nullable().describe('Date of birth, ISO date.'),
  tour: z.string().nullable().describe('ATP, WTA, Challenger or ITF.'),
});

const FixtureOut = z.object({
  event_date: z.string().nullable().describe('Scheduled start, ISO timestamp.'),
  tournament: z.string().nullable().describe('Event name.'),
  round: z.string().nullable().describe('Round within the event.'),
  player1: z.string().nullable().describe('Name of player 1.'),
  player2: z.string().nullable().describe('Name of player 2.'),
});

const PriceOut = z.object({
  side: z.number().nullable().describe('Which player this price is for, 1 or 2.'),
  mid: z.number().nullable().describe('Mid price, 0-1, readable as implied probability.'),
  bid: z.number().nullable().describe('Best bid.'),
  ask: z.number().nullable().describe('Best ask.'),
  timestamp: z.string().nullable().describe('When the price was observed.'),
});

const TournamentOut = z.object({
  id: z.string().nullable().describe('Stable tournament id — the same id match objects carry as tournament_id.'),
  name: z.string().nullable().describe('Tournament name.'),
  tour: z.string().nullable().describe('atp, wta, challenger, itf or juniors.'),
  surface: z.string().nullable().describe('Court surface: hard, clay or grass.'),
  indoor: z.boolean().nullable().describe('True when played indoors.'),
  city: z.string().nullable().describe('Host city, from a curated table — null where not curated.'),
  country: z.string().nullable().describe('Host country, ISO-3166 alpha-2 — null where not curated.'),
  category: z
    .string()
    .nullable()
    .describe(
      'Tournament category (grand_slam, masters_1000, tour_finals, atp_500, atp_250, wta_1000, ' +
        'wta_500, wta_250, wta_125, challenger, itf, juniors). Set only where the catalogues agree ' +
        'unambiguously — null otherwise, never derived from the name.',
    ),
});

const ArchiveSideOut = z.object({
  name: z.string().nullable().describe('Player name as the corpus records it.'),
  country: z.string().nullable().describe('3-letter country code.'),
  rank: z.number().nullable().describe('Rank AT THE TIME of the match, as published.'),
  seed: z.number().nullable().describe('Seeding, where seeded.'),
  player_id: z
    .number()
    .nullable()
    .describe('Corpus person id — pass to search_archive_players results to join bios. NOT a roster player id.'),
  hand: z.string().nullable().describe('"R" or "L".'),
  height_cm: z.number().nullable().describe('Height in cm, where recorded.'),
  age: z.number().nullable().describe('Age at the time of the match.'),
  entry: z.string().nullable().describe('Draw entry where recorded (WC, Q, LL, …) — null for direct acceptances.'),
});

const ArchiveMatchOut = z.object({
  id: z.number().nullable().describe('Archive match id. Pass to get_archive_match for the detail read with stats.'),
  tour: z.string().nullable().describe('atp or wta — the results archive covers those two tours.'),
  tournament: z.string().nullable().describe('Tournament name.'),
  event_date: z
    .string()
    .nullable()
    .describe('The tournament START date — per-match dates do not exist in this era’s records.'),
  round: z.string().nullable().describe('Round code: F, SF, QF, R16 … Q1-Q4.'),
  level: z.string().nullable().describe('Source tier code: G, M, A, F, D, C, O, or a futures category code.'),
  surface: z.string().nullable().describe('Court surface.'),
  score: z.string().nullable().describe('The final score as published, e.g. "6-4 7-6(5)", "6-3 RET", "W/O".'),
  outcome: z
    .string()
    .nullable()
    .describe('completed, retired, walkover, default or abandoned — parsed, null when unparseable.'),
  winner: ArchiveSideOut.describe('The winner — a stored field in the corpus, never an inference.'),
  loser: ArchiveSideOut.describe('The loser.'),
});

const ArchiveBioOut = z.object({
  id: z
    .number()
    .nullable()
    .describe('Corpus person id — the id archive match rows carry as winner/loser player_id. NOT a roster id.'),
  tour: z.string().nullable().describe('atp or wta.'),
  name: z.string().nullable().describe('Player name.'),
  hand: z.string().nullable().describe('"R" or "L".'),
  dob: z.string().nullable().describe('Date of birth, ISO date.'),
  country: z.string().nullable().describe('3-letter country code.'),
  height_cm: z.number().nullable().describe('Height in cm.'),
  career_high_rank: z.number().nullable().describe('Career-high rank, from the corpus’s own weekly tables.'),
  career_high_date: z.string().nullable().describe('The earliest week the career-high rank was reached.'),
});

const H2HMeetingOut = z.object({
  era: z
    .string()
    .nullable()
    .describe('"archive" (results archive, 1968-2022) or "current" (our own completed matches, 2023 onward).'),
  date: z.string().nullable().describe('Match date (current era) or tournament start date (archive era).'),
  tournament: z.string().nullable().describe('Tournament name.'),
  round: z.string().nullable().describe('Round.'),
  surface: z.string().nullable().describe('Court surface.'),
  score: z.string().nullable().describe('Final score (archive rows only — read current rows from get_match).'),
  outcome: z.string().nullable().describe('completed, retired, walkover, … — exclude non-completed yourself if needed.'),
  winner: z
    .number()
    .nullable()
    .describe('1 or 2 OF THE REQUEST (player1/player2 as you passed them), not of the underlying match row.'),
  match_id: z.number().nullable().describe('Our match id (current era rows) — pass to get_match.'),
});

/** Normalise `undefined` to `null` — the schemas above are nullable, not optional. */
const n = <T,>(v: T | undefined | null): T | null => (v == null ? null : v);

function matchOut(m: Match): z.infer<typeof MatchOut> {
  return {
    id: n(m.id),
    tournament: n(m.tournament),
    round: n(m.round),
    player1: n(m.players?.p1?.name),
    player2: n(m.players?.p2?.name),
    score: n(formatScore(m.score)),
    status: n(m.status),
    surface: n(m.surface),
    indoor: n(m.indoor),
    serving: n(m.score?.server),
    winner: n(m.winner),
    win_probability_p1: n(m.score?.win_probability_p1),
  };
}

function tournamentOut(t: Tournament): z.infer<typeof TournamentOut> {
  return {
    id: n(t.id),
    name: n(t.name),
    tour: n(t.tour),
    surface: n(t.surface),
    indoor: n(t.indoor),
    city: n(t.city),
    country: n(t.country),
    category: n(t.category),
  };
}

function archiveSideOut(p: ArchiveParticipant | undefined): z.infer<typeof ArchiveSideOut> {
  return {
    name: n(p?.name),
    country: n(p?.country),
    rank: n(p?.rank),
    seed: n(p?.seed),
    player_id: n(p?.player_id),
    hand: n(p?.hand),
    height_cm: n(p?.height_cm),
    age: n(p?.age),
    entry: n(p?.entry),
  };
}

function archiveMatchOut(m: ArchiveMatch): z.infer<typeof ArchiveMatchOut> {
  return {
    id: n(m.id),
    tour: n(m.tour),
    tournament: n(m.tournament),
    event_date: n(m.event_date),
    round: n(m.round),
    level: n(m.level),
    surface: n(m.surface),
    score: n(m.score),
    outcome: n(m.outcome),
    winner: archiveSideOut(m.winner),
    loser: archiveSideOut(m.loser),
  };
}

/** Compact one-line archive-result summary, mirroring `summarise()` for live matches. */
function summariseArchive(m: ArchiveMatch): string {
  const w = m.winner?.name ?? '?';
  const l = m.loser?.name ?? '?';
  const rank = (p: ArchiveParticipant | undefined) => (p?.rank != null ? ` (rank ${p.rank})` : '');
  const bits = [
    `[${m.id}] ${m.event_date ?? '?'} ${m.tournament ?? 'Unknown event'}${m.round ? ` — ${m.round}` : ''}`,
    `  ${w}${rank(m.winner)} d. ${l}${rank(m.loser)}  ${m.score ?? ''}`.trimEnd(),
  ];
  if (m.surface) bits.push(`  Surface: ${m.surface}`);
  if (m.outcome && m.outcome !== 'completed') bits.push(`  Outcome: ${m.outcome}`);
  return bits.join('\n');
}

/** Compact one-line match summary — token-efficient for a model to read. */
function summarise(match: Match): string {
  const p1 = match.players?.p1?.name ?? '?';
  const p2 = match.players?.p2?.name ?? '?';
  const serving = match.score?.server === 1 ? ' (serving)' : '';
  const serving2 = match.score?.server === 2 ? ' (serving)' : '';
  const bits = [
    `[${match.id}] ${match.tournament ?? 'Unknown event'}${match.round ? ` — ${match.round}` : ''}`,
    `  ${p1}${serving} vs ${p2}${serving2}`,
    `  Score: ${formatScore(match.score)}`,
  ];
  if (match.surface) bits.push(`  Surface: ${match.surface}${match.indoor ? ' (indoor)' : ''}`);
  if (match.status && match.status !== 'live') bits.push(`  Status: ${match.status}`);
  if (match.winner) bits.push(`  Winner: ${match.winner === 1 ? p1 : p2}`);
  if (match.score?.win_probability_p1 != null) {
    bits.push(`  Model win probability (${p1}): ${(match.score.win_probability_p1 * 100).toFixed(1)}%`);
  }
  return bits.join('\n');
}

/**
 * Build a fully-configured MCP server bound to ONE API key.
 *
 * Everything that touches credentials — the client, the guard, all 12 tools —
 * is created inside this closure, so two servers built from two keys share no
 * mutable state. That property is what makes the HTTP transport safe to expose.
 */
export function createServer(apiKey: string, baseUrl?: string): McpServer {
  const client = new LiveTennisAPI({ apiKey, baseUrl });

  /** A non-error, no-data result: tier walls, key problems, empty responses. */
  const fail = (message: string): ToolResult => ({
    content: [{ type: 'text', text: message }],
    structuredContent: { ok: false, message },
  });

  /**
   * Run a tool body, translating API failures into text the model can act on.
   *
   * A tier wall is deliberately **not** an error result: it is a normal,
   * expected state with a clear remedy, and marking it as an error tends to make
   * clients retry or bail rather than relay the upgrade path to the user.
   *
   * Every return path carries `structuredContent`, because each tool declares an
   * output schema and the SDK throws on a non-error result without one.
   */
  async function guard(run: () => Promise<Payload>): Promise<ToolResult> {
    if (!apiKey) {
      return fail(
        'No API key configured. Set LIVETENNISAPI_KEY in your MCP client config, or — if you ' +
          'are calling the hosted endpoint over HTTP — send it as "Authorization: Bearer twjp_…". ' +
          'Get a free key, no card, at https://livetennisapi.com/subscribe/free',
      );
    }
    try {
      const { text: body, data } = await run();
      return {
        content: [{ type: 'text', text: body }],
        structuredContent: { ok: true, message: body, ...(data ?? {}) },
      };
    } catch (err) {
      if (err instanceof UpgradeRequired) {
        return fail(
          `This data requires the ${err.requiredTier ?? 'a higher'} plan, and the configured ` +
            `API key is on a lower tier. Nothing is wrong with the key — the endpoint is ` +
            `simply not included in the current plan. Upgrade at https://livetennisapi.com/#pricing\n\n` +
            `Tiers: FREE = live & upcoming matches, scores, players, fixtures, tournaments · ` +
            `BASIC = + historical results, the results archive (1968–2022) and head-to-head · ` +
            `PRO = + match events and market prices · ` +
            `ULTRA = + model analysis, win probability and the live WebSocket feed.`,
        );
      }
      if (err instanceof Unauthorized) {
        return fail(
          'The API key was rejected — it is missing, unknown, or disabled. Check the key in ' +
            'your MCP client config. Keys are at https://livetennisapi.com',
        );
      }
      if (err instanceof NotFound) {
        return fail('No data found for that request. The id may be wrong, or there may be no data yet.');
      }
      if (err instanceof RateLimited) {
        const wait = err.retryAfter ? ` Retry in about ${err.retryAfter}s.` : '';
        return fail(`Rate limit reached for this plan.${wait}`);
      }
      if (err instanceof BadRequest && err.errorCode === 'ambiguous_name') {
        // /h2h and /history/archive/career refuse a fragment matching more
        // than one player — two people summed into one record would be a
        // wrong answer, not a convenience. Relay the candidates so the model
        // can disambiguate instead of retrying blind.
        const candidates = (err.body as { candidates?: unknown } | undefined)?.candidates;
        const list = Array.isArray(candidates) ? candidates.join(', ') : '';
        return fail(
          `That name fragment matches more than one player${list ? `: ${list}` : ''}. ` +
            'The API refuses to sum two people into one record, so nothing was guessed — ' +
            'retry with a more specific name (one of the candidates above).',
        );
      }
      // A genuine fault, unlike everything above. isError exempts it from output
      // validation, so no structured content is required here.
      return {
        content: [{ type: 'text', text: `Request failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }

  const server = new McpServer({ name: 'livetennisapi', version: VERSION });

  // This server exposes tools only — no resources, no prompts. The SDK registers
  // the `resources/*` and `prompts/*` handlers lazily, i.e. only once you add one,
  // so without this block those methods answer `-32601 Method not found`.
  //
  // That is spec-correct: we do not advertise the capabilities, so a conforming
  // client should never call them. Automated indexers are not conforming clients.
  // Glama, for one, documents its introspection pass as `tools/list`,
  // `resources/list`, `prompts/list` unconditionally — and a run that errors twice
  // is a plausible way to end up unscored.
  //
  // So answer them honestly instead: the capability is supported, the collection
  // is empty. Preferable to registering a placeholder resource just to keep an
  // indexer happy, which would put a fake entry in front of real users.
  server.server.registerCapabilities({ resources: {}, prompts: {} });
  server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [],
  }));
  server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));

  const limitField = (max: number, fallback: number, what: string) =>
    z.number().int().min(1).max(max).default(fallback).describe(`Maximum ${what} to return (1-${max}).`);

  const matchIdField = z
    .number()
    .int()
    .describe('Match id, as returned by get_live_matches, get_upcoming_matches or get_recent_results.');

  // -- BASIC --------------------------------------------------------------------

  server.registerTool(
    'get_live_matches',
    {
      title: 'Live matches',
      description:
        'List tennis matches currently in progress, with live scores. Covers ATP, WTA, ' +
        'Challenger and ITF. Use this for "what tennis is on right now".',
      inputSchema: { limit: limitField(200, 20, 'matches') },
      outputSchema: {
        ok: okField,
        message: messageField,
        matches: z.array(MatchOut).optional().describe('The live matches, most relevant first.'),
      },
      annotations: READ_ONLY,
    },
    ({ limit }) =>
      guard(async () => {
        const page = await client.listMatches({ status: 'live', limit });
        if (!page.data.length) return { text: 'No matches are live right now.', data: { matches: [] } };
        return {
          text: `${page.data.length} live match(es):\n\n${page.data.map(summarise).join('\n\n')}`,
          data: { matches: page.data.map(matchOut) },
        };
      }),
  );

  server.registerTool(
    'get_upcoming_matches',
    {
      title: 'Upcoming matches',
      description: 'List tennis matches scheduled to start soon, with players and tournament.',
      inputSchema: { limit: limitField(200, 20, 'matches') },
      outputSchema: {
        ok: okField,
        message: messageField,
        matches: z.array(MatchOut).optional().describe('Matches due to start, soonest first.'),
      },
      annotations: READ_ONLY,
    },
    ({ limit }) =>
      guard(async () => {
        const page = await client.listMatches({ status: 'upcoming', limit });
        if (!page.data.length) return { text: 'No upcoming matches are scheduled.', data: { matches: [] } };
        return {
          text: `${page.data.length} upcoming match(es):\n\n${page.data.map(summarise).join('\n\n')}`,
          data: { matches: page.data.map(matchOut) },
        };
      }),
  );

  server.registerTool(
    'get_match',
    {
      title: 'Match detail',
      description:
        'Full detail for one match by id: players, score, surface, round and status. ' +
        'Includes market prices on PRO and model analysis on ULTRA.',
      inputSchema: { match_id: matchIdField },
      outputSchema: {
        ok: okField,
        message: messageField,
        match: MatchOut.optional().describe('The match.'),
        market: z
          .object({
            question: z.string().nullable().describe('The market being priced.'),
            prices: z.array(PriceOut).describe('Current prices per player.'),
          })
          .optional()
          .describe('Match-winner market. Requires the PRO plan; absent otherwise.'),
        analysis: z
          .object({
            win_probability_p1: z.number().nullable().describe('Model probability player 1 wins, 0-1.'),
            key_factors: z.array(z.string()).describe('Drivers behind the model view.'),
          })
          .optional()
          .describe('Model analysis. Requires the ULTRA plan; absent otherwise.'),
      },
      annotations: READ_ONLY,
    },
    ({ match_id }) =>
      guard(async () => {
        const match = await client.getMatch(match_id);
        if (!match) return { text: 'No data returned for that match id.' };
        let out = summarise(match);
        const data: Record<string, unknown> = { match: matchOut(match) };
        if (match.market) {
          out += `\n\nMarket: ${match.market.question ?? '-'}`;
          for (const price of match.market.prices ?? []) {
            out += `\n  Side ${price.side}: mid ${price.mid ?? '-'} (bid ${price.bid ?? '-'} / ask ${price.ask ?? '-'})`;
          }
          data.market = {
            question: n(match.market.question),
            prices: (match.market.prices ?? []).map((p) => ({
              side: n(p.side),
              mid: n(p.mid),
              bid: n(p.bid),
              ask: n(p.ask),
              timestamp: n(p.timestamp),
            })),
          };
        }
        if (match.analysis?.profile) {
          const profile = match.analysis.profile;
          out += `\n\nModel analysis:`;
          if (profile.win_probability_p1 != null) {
            out += `\n  Win probability (player 1): ${(profile.win_probability_p1 * 100).toFixed(1)}%`;
          }
          if (profile.key_factors?.length) out += `\n  Key factors: ${profile.key_factors.join('; ')}`;
          data.analysis = {
            win_probability_p1: n(profile.win_probability_p1),
            key_factors: profile.key_factors ?? [],
          };
        }
        return { text: out, data };
      }),
  );

  server.registerTool(
    'get_match_score',
    {
      title: 'Match score',
      description:
        'Current score for one match — the fastest, lowest-latency read. Use this when ' +
        'you only need the score and already know the match id.',
      inputSchema: { match_id: matchIdField },
      outputSchema: {
        ok: okField,
        message: messageField,
        score: z
          .object({
            formatted: z.string().describe('Formatted score line.'),
            sets: z.array(z.number()).nullable().describe('Sets won per player.'),
            serving: z.number().nullable().describe('Which player is serving, 1 or 2.'),
            is_tiebreak: z.boolean().nullable().describe('True during a tiebreak.'),
            win_probability_p1: z.number().nullable().describe('Model probability player 1 wins, 0-1. ULTRA only.'),
          })
          .optional()
          .describe('The current score.'),
      },
      annotations: READ_ONLY,
    },
    ({ match_id }) =>
      guard(async () => {
        const score = await client.getMatchScore(match_id);
        if (!score) return { text: 'No score available for that match yet.' };
        const parts = [`Score: ${formatScore(score)}`];
        if (score.sets) parts.push(`Sets: ${score.sets.join('-')}`);
        if (score.server) parts.push(`Serving: player ${score.server}`);
        if (score.is_tiebreak) parts.push('In a tiebreak');
        if (score.win_probability_p1 != null) {
          parts.push(`Model win probability (player 1): ${(score.win_probability_p1 * 100).toFixed(1)}%`);
        }
        return {
          text: parts.join('\n'),
          data: {
            score: {
              formatted: formatScore(score),
              sets: n(score.sets),
              serving: n(score.server),
              is_tiebreak: n(score.is_tiebreak),
              win_probability_p1: n(score.win_probability_p1),
            },
          },
        };
      }),
  );

  server.registerTool(
    'search_players',
    {
      title: 'Search players',
      description:
        'Search tennis players by name. Returns id, country, ranking and tour. Use the ' +
        'returned id with get_player.',
      inputSchema: {
        query: z.string().min(1).describe('Full or partial player name, e.g. "alcaraz".'),
        limit: limitField(200, 10, 'players'),
      },
      outputSchema: {
        ok: okField,
        message: messageField,
        players: z.array(PlayerOut).optional().describe('Matching players, best match first.'),
      },
      annotations: READ_ONLY,
    },
    ({ query, limit }) =>
      guard(async () => {
        const page = await client.searchPlayers(query, { limit });
        if (!page.data.length) return { text: `No players matched "${query}".`, data: { players: [] } };
        return {
          text: page.data
            .map(
              (p) =>
                `[${p.id}] ${p.name ?? '?'}${p.country ? ` (${p.country})` : ''}` +
                `${p.ranking != null ? ` — rank ${p.ranking}` : ''}${p.tour ? ` · ${p.tour}` : ''}`,
            )
            .join('\n'),
          data: {
            players: page.data.map((p) => ({
              id: n(p.id),
              name: n(p.name),
              country: n(p.country),
              ranking: n(p.ranking),
              ranking_points: n(p.ranking_points),
              ranking_movement: n(p.ranking_movement),
              hand: n(p.hand),
              birthday: n(p.birthday),
              tour: n(p.tour),
            })),
          },
        };
      }),
  );

  server.registerTool(
    'get_player',
    {
      title: 'Player profile',
      description: "One player's profile: ranking, country, handedness, date of birth and cached stats.",
      inputSchema: { player_id: z.number().int().describe('Player id, as returned by search_players.') },
      outputSchema: {
        ok: okField,
        message: messageField,
        player: PlayerOut.optional().describe('The player.'),
      },
      annotations: READ_ONLY,
    },
    ({ player_id }) =>
      guard(async () => {
        const p = await client.getPlayer(player_id);
        if (!p) return { text: 'No data returned for that player id.' };
        const rows = [
          `${p.name ?? 'Unknown'} [${p.id}]`,
          p.country ? `Country: ${p.country}` : null,
          p.ranking != null ? `Ranking: ${p.ranking}${p.ranking_points ? ` (${p.ranking_points} pts)` : ''}` : null,
          p.ranking_movement ? `Movement: ${p.ranking_movement}` : null,
          p.hand ? `Plays: ${p.hand === 'R' ? 'right-handed' : 'left-handed'}` : null,
          p.birthday ? `Born: ${p.birthday}` : null,
          p.tour ? `Tour: ${p.tour}` : null,
        ].filter(Boolean);
        return {
          text: rows.join('\n'),
          data: {
            player: {
              id: n(p.id),
              name: n(p.name),
              country: n(p.country),
              ranking: n(p.ranking),
              ranking_points: n(p.ranking_points),
              ranking_movement: n(p.ranking_movement),
              hand: n(p.hand),
              birthday: n(p.birthday),
              tour: n(p.tour),
            },
          },
        };
      }),
  );

  server.registerTool(
    'get_fixtures',
    {
      title: 'Fixture schedule',
      description: 'Upcoming scheduled tennis fixtures, earliest first — the forward schedule.',
      inputSchema: { limit: limitField(200, 20, 'fixtures') },
      outputSchema: {
        ok: okField,
        message: messageField,
        fixtures: z.array(FixtureOut).optional().describe('Scheduled fixtures, earliest first.'),
      },
      annotations: READ_ONLY,
    },
    ({ limit }) =>
      guard(async () => {
        const page = await client.listFixtures({ limit });
        if (!page.data.length) return { text: 'No upcoming fixtures.', data: { fixtures: [] } };
        return {
          text: page.data
            .map(
              (f) =>
                `${f.event_date ?? '?'} — ${f.tournament ?? '?'}` +
                `${f.round ? ` (${f.round})` : ''}: ${f.player1_name ?? '?'} vs ${f.player2_name ?? '?'}`,
            )
            .join('\n'),
          data: {
            fixtures: page.data.map((f) => ({
              event_date: n(f.event_date),
              tournament: n(f.tournament),
              round: n(f.round),
              player1: n(f.player1_name),
              player2: n(f.player2_name),
            })),
          },
        };
      }),
  );

  server.registerTool(
    'search_tournaments',
    {
      title: 'Tournament catalogue',
      description:
        'Search the tournament catalogue — the stable id space that match objects carry as ' +
        'tournament_id. Returns surface, indoor, host city/country and category where curated.',
      inputSchema: {
        query: z.string().optional().describe('Full or partial tournament name, e.g. "wimbledon". Omit to list all.'),
        tour: z
          .enum(['atp', 'wta', 'challenger', 'itf', 'juniors'])
          .optional()
          .describe('Restrict to one tour.'),
        limit: limitField(200, 20, 'tournaments'),
      },
      outputSchema: {
        ok: okField,
        message: messageField,
        tournaments: z.array(TournamentOut).optional().describe('Matching tournaments, name order.'),
      },
      annotations: READ_ONLY,
    },
    ({ query, tour, limit }) =>
      guard(async () => {
        const page = await client.listTournaments({ search: query, tour, limit });
        if (!page.data.length) {
          return { text: query ? `No tournaments matched "${query}".` : 'No tournaments found.', data: { tournaments: [] } };
        }
        return {
          text: page.data
            .map(
              (t) =>
                `[${t.id}] ${t.name ?? '?'}${t.tour ? ` · ${t.tour}` : ''}` +
                `${t.surface ? ` · ${t.surface}${t.indoor ? ' (indoor)' : ''}` : ''}` +
                `${t.city ? ` · ${t.city}${t.country ? `, ${t.country}` : ''}` : ''}` +
                `${t.category ? ` · ${t.category}` : ''}`,
            )
            .join('\n'),
          data: { tournaments: page.data.map(tournamentOut) },
        };
      }),
  );

  server.registerTool(
    'get_tournament',
    {
      title: 'Tournament detail',
      description:
        'One tournament by its stable id — the tournament_id carried on match objects. ' +
        'Name, tour, surface, indoor, plus host city/country and category where curated.',
      inputSchema: {
        tournament_id: z
          .string()
          .describe('Stable tournament id, as returned by search_tournaments or carried on a match as tournament_id.'),
      },
      outputSchema: {
        ok: okField,
        message: messageField,
        tournament: TournamentOut.optional().describe('The tournament.'),
      },
      annotations: READ_ONLY,
    },
    ({ tournament_id }) =>
      guard(async () => {
        const t = await client.getTournament(tournament_id);
        if (!t) return { text: 'No data returned for that tournament id.' };
        const rows = [
          `${t.name ?? 'Unknown'} [${t.id}]`,
          t.tour ? `Tour: ${t.tour}` : null,
          t.surface ? `Surface: ${t.surface}${t.indoor ? ' (indoor)' : ''}` : null,
          t.city ? `Location: ${t.city}${t.country ? `, ${t.country}` : ''}` : null,
          t.category ? `Category: ${t.category}` : null,
        ].filter(Boolean);
        return { text: rows.join('\n'), data: { tournament: tournamentOut(t) } };
      }),
  );

  server.registerTool(
    'get_recent_results',
    {
      title: 'Recent results',
      description: 'Recently completed tennis matches with final scores and winners.',
      inputSchema: { limit: limitField(200, 20, 'matches') },
      outputSchema: {
        ok: okField,
        message: messageField,
        matches: z.array(MatchOut).optional().describe('Completed matches, most recent first.'),
      },
      annotations: READ_ONLY,
    },
    ({ limit }) =>
      guard(async () => {
        const page = await client.listCompletedMatches({ limit });
        if (!page.data.length) return { text: 'No completed matches available.', data: { matches: [] } };
        return {
          text: page.data.map(summarise).join('\n\n'),
          data: { matches: page.data.map(matchOut) },
        };
      }),
  );

  server.registerTool(
    'search_archive_matches',
    {
      title: 'Results archive (1968–2022)',
      description:
        'Search the results archive — completed-match RESULTS from 1968 through 2022: ATP and WTA, ' +
        'main draws, qualifying and the ITF/futures tiers. Winner/loser-shaped records with final ' +
        'score, seeds and ranks AT THE TIME of the match. Use this for historical questions ' +
        '("Borg\'s Wimbledon finals"); the archive ends 2022-12-31 where our own results ' +
        '(get_recent_results) begin. Requires the BASIC plan or any History plan.',
      inputSchema: {
        player_name: z
          .string()
          .min(3)
          .optional()
          .describe('Case-insensitive fragment of EITHER player\'s name, min 3 chars, e.g. "borg".'),
        tour: z.enum(['atp', 'wta']).optional().describe('atp or wta.'),
        from: z.string().optional().describe('Earliest tournament START date, YYYY-MM-DD.'),
        to: z.string().optional().describe('Latest tournament START date, YYYY-MM-DD.'),
        round: z
          .enum(['F', 'SF', 'QF', 'R16', 'R32', 'R64', 'R128', 'RR', 'BR', 'Q1', 'Q2', 'Q3', 'Q4', 'ER'])
          .optional()
          .describe('Round code, e.g. F for finals.'),
        level: z
          .string()
          .optional()
          .describe('Source tier code: G=grand slam, M=masters, A=tour, F=finals, D=davis cup, C=challenger, O=olympics, or a futures category code (e.g. 15).'),
        limit: limitField(200, 20, 'results'),
      },
      outputSchema: {
        ok: okField,
        message: messageField,
        results: z.array(ArchiveMatchOut).optional().describe('Archive results, newest tournament first.'),
      },
      annotations: READ_ONLY,
    },
    ({ player_name, tour, from, to, round, level, limit }) =>
      guard(async () => {
        const page = await client.listArchiveMatches({ name: player_name, tour, from, to, round, level, limit });
        if (!page.data.length) {
          return { text: 'No archive results matched. The results archive covers 1968 through 2022 — for 2023 onward use get_recent_results.', data: { results: [] } };
        }
        return {
          text: page.data.map(summariseArchive).join('\n\n'),
          data: { results: page.data.map(archiveMatchOut) },
        };
      }),
  );

  server.registerTool(
    'get_archive_match',
    {
      title: 'Archive result detail',
      description:
        'One result from the results archive (1968–2022), with per-match serve statistics where ' +
        'the era recorded them — stats are null for most rows before 1991, honestly, never ' +
        'synthesised. Requires the BASIC plan or any History plan.',
      inputSchema: {
        archive_match_id: z.number().int().describe('Archive match id, as returned by search_archive_matches.'),
      },
      outputSchema: {
        ok: okField,
        message: messageField,
        result: ArchiveMatchOut.optional().describe('The archive result.'),
        stats: z
          .object({
            winner: z.record(z.number().nullable()).nullable().describe('Serve stats for the winner, where recorded.'),
            loser: z.record(z.number().nullable()).nullable().describe('Serve stats for the loser, where recorded.'),
          })
          .nullable()
          .optional()
          .describe('Per-match serve statistics (aces, double_faults, serve_points, first_in, first_won, second_won, serve_games, bp_saved, bp_faced). Null for most pre-1991 rows.'),
      },
      annotations: READ_ONLY,
    },
    ({ archive_match_id }) =>
      guard(async () => {
        const m = await client.getArchiveMatch(archive_match_id);
        if (!m) return { text: 'No data returned for that archive match id.' };
        let out = summariseArchive(m);
        const data: Record<string, unknown> = { result: archiveMatchOut(m) };
        if (m.stats) {
          const line = (label: string, s: Record<string, unknown> | null | undefined) =>
            s ? `  ${label}: ${Object.entries(s).map(([k, v]) => `${k}=${v ?? '-'}`).join(' · ')}` : null;
          out += ['\n\nServe statistics:', line('winner', m.stats.winner), line('loser', m.stats.loser)]
            .filter(Boolean)
            .join('\n');
          data.stats = { winner: n(m.stats.winner), loser: n(m.stats.loser) };
        } else {
          out += '\n\nNo serve statistics — the corpus records them from 1991 only, and this null is honest.';
          data.stats = null;
        }
        return { text: out, data };
      }),
  );

  server.registerTool(
    'search_archive_players',
    {
      title: 'Archive player bios',
      description:
        'The people of the results archive (1968–2022): hand, date of birth, country, height, and ' +
        'career-high rank with the week it was first reached. Their ids are corpus person ids ' +
        '(the winner/loser player_id on archive results), not roster ids — for current players ' +
        'use search_players. Requires the BASIC plan or any History plan.',
      inputSchema: {
        query: z.string().min(3).describe('Full or partial player name, min 3 chars, e.g. "navratilova".'),
        tour: z.enum(['atp', 'wta']).optional().describe('atp or wta.'),
        limit: limitField(200, 10, 'players'),
      },
      outputSchema: {
        ok: okField,
        message: messageField,
        players: z.array(ArchiveBioOut).optional().describe('Matching archive people, ordered by name.'),
      },
      annotations: READ_ONLY,
    },
    ({ query, tour, limit }) =>
      guard(async () => {
        const page = await client.listArchivePlayers({ name: query, tour, limit });
        if (!page.data.length) return { text: `No archive players matched "${query}".`, data: { players: [] } };
        return {
          text: page.data
            .map(
              (p) =>
                `[${p.id}] ${p.name ?? '?'}${p.country ? ` (${p.country})` : ''}${p.tour ? ` · ${p.tour}` : ''}` +
                `${p.hand ? ` · ${p.hand}` : ''}${p.dob ? ` · b. ${p.dob}` : ''}` +
                `${p.career_high_rank != null ? ` · career high ${p.career_high_rank}${p.career_high_date ? ` (${p.career_high_date})` : ''}` : ''}`,
            )
            .join('\n'),
          data: {
            players: page.data.map((p) => ({
              id: n(p.id),
              tour: n(p.tour),
              name: n(p.name),
              hand: n(p.hand),
              dob: n(p.dob),
              country: n(p.country),
              height_cm: n(p.height_cm),
              career_high_rank: n(p.career_high_rank),
              career_high_date: n(p.career_high_date),
            })),
          },
        };
      }),
  );

  server.registerTool(
    'get_archive_career',
    {
      title: 'Archive career aggregates',
      description:
        "One player's whole career over the results archive (1968–2022): W-L record overall and by " +
        'surface/level/year, titles, and summed serve statistics with honest coverage — the corpus ' +
        'records serve stats from 1991 only, so matches_with_stats states how many matches the serve ' +
        'block covers. The name must resolve to one person; an ambiguous fragment returns the ' +
        'candidate list to choose from. Requires the BASIC plan or any History plan.',
      inputSchema: {
        name: z.string().min(3).describe('Player name fragment, min 3 chars — must resolve to exactly one person.'),
      },
      outputSchema: {
        ok: okField,
        message: messageField,
        player_name: z.string().nullable().optional().describe('The resolved player.'),
        span: z
          .object({
            first: z.string().nullable().describe('First archive match date.'),
            last: z.string().nullable().describe('Last archive match date.'),
          })
          .optional()
          .describe('Career span inside the archive.'),
        record: z
          .object({
            wins: z.number().nullable().describe('Career wins.'),
            losses: z.number().nullable().describe('Career losses.'),
            titles: z.number().nullable().describe('Finals won (excluding abandoned finals).'),
            by_surface: z
              .record(z.object({ wins: z.number().nullable(), losses: z.number().nullable() }))
              .nullable()
              .describe('W-L per surface.'),
            by_level: z
              .record(z.object({ wins: z.number().nullable(), losses: z.number().nullable() }))
              .nullable()
              .describe('W-L per source tier code.'),
          })
          .optional()
          .describe('The W-L record.'),
        by_year: z
          .array(z.object({ year: z.number().nullable(), wins: z.number().nullable(), losses: z.number().nullable() }))
          .optional()
          .describe('Per-season W-L.'),
        serve: z
          .record(z.number().nullable())
          .nullable()
          .optional()
          .describe('Summed serve stats + derived ratios. matches_with_stats states the coverage; ratios are null where the denominator is zero.'),
      },
      annotations: READ_ONLY,
    },
    ({ name }) =>
      guard(async () => {
        const career = await client.getArchiveCareer(name);
        if (!career) return { text: 'No archive career found for that name.' };
        const rec = career.record ?? {};
        const lines = [
          `${career.player?.name ?? name} — results archive (1968–2022)`,
          `Record: ${rec.wins ?? 0}-${rec.losses ?? 0}, ${rec.titles ?? 0} title(s)` +
            `${career.span?.first ? ` · ${career.span.first} → ${career.span.last ?? '?'}` : ''}`,
        ];
        if (rec.by_surface && Object.keys(rec.by_surface).length) {
          lines.push(
            `By surface: ${Object.entries(rec.by_surface)
              .map(([s, wl]) => `${s} ${wl?.wins ?? 0}-${wl?.losses ?? 0}`)
              .join(' · ')}`,
          );
        }
        const serve = career.serve;
        if (serve?.matches_with_stats) {
          lines.push(
            `Serve (over ${serve.matches_with_stats} matches with stats): ` +
              `${serve.aces ?? 0} aces (${serve.aces_per_match ?? '-'}/match) · ` +
              `1st in ${serve.first_in_pct ?? '-'} · 1st won ${serve.first_won_pct ?? '-'} · ` +
              `BP saved ${serve.bp_saved_pct ?? '-'}`,
          );
        } else {
          lines.push('Serve stats: none — the corpus records them from 1991 only.');
        }
        return {
          text: lines.join('\n'),
          data: {
            player_name: n(career.player?.name),
            span: { first: n(career.span?.first), last: n(career.span?.last) },
            record: {
              wins: n(rec.wins),
              losses: n(rec.losses),
              titles: n(rec.titles),
              by_surface: n(rec.by_surface as Record<string, { wins: number | null; losses: number | null }> | undefined),
              by_level: n(rec.by_level as Record<string, { wins: number | null; losses: number | null }> | undefined),
            },
            by_year: (career.by_year ?? []).map((y) => ({ year: n(y.year), wins: n(y.wins), losses: n(y.losses) })),
            serve: n(serve as Record<string, number | null> | undefined),
          },
        };
      }),
  );

  server.registerTool(
    'get_h2h',
    {
      title: 'Head-to-head',
      description:
        'The all-time record between two players, across BOTH halves of the product: the results ' +
        'archive (1968–2022) plus our own completed matches (2023 onward). Names are the keys — an ' +
        'ambiguous fragment returns the candidate list to choose from rather than guessing. Totals ' +
        'count only meetings with a known winner; walkovers and retirements are part of the record ' +
        'and each meeting carries its outcome. Requires the BASIC plan or any History plan.',
      inputSchema: {
        player1: z.string().min(3).describe('First player name (fragment, min 3 chars), e.g. "federer".'),
        player2: z.string().min(3).describe('Second player name (fragment, min 3 chars), e.g. "nadal".'),
      },
      outputSchema: {
        ok: okField,
        message: messageField,
        players: z
          .object({
            p1: z.string().nullable().describe('Resolved name for player1.'),
            p2: z.string().nullable().describe('Resolved name for player2.'),
          })
          .nullable()
          .optional()
          .describe('The resolved names; null when no player matches the fragments.'),
        totals: z
          .object({
            p1_wins: z.number().nullable().describe('Wins for player1 (of the request).'),
            p2_wins: z.number().nullable().describe('Wins for player2 (of the request).'),
            meetings: z.number().nullable().describe('Meetings with a known winner.'),
            undecided: z.number().nullable().describe('Meetings with no derivable winner — never counted in wins.'),
          })
          .optional()
          .describe('The headline record.'),
        by_surface: z
          .record(z.object({ p1: z.number().nullable(), p2: z.number().nullable() }))
          .optional()
          .describe('Decided wins per surface; keys are surface names plus "unknown".'),
        meetings: z.array(H2HMeetingOut).optional().describe('Individual meetings, newest first, capped at 200.'),
      },
      annotations: READ_ONLY,
    },
    ({ player1, player2 }) =>
      guard(async () => {
        const h2h = await client.getH2H(player1, player2);
        if (!h2h || !h2h.players) {
          return { text: `No player matched "${player1}" and/or "${player2}" in either era.`, data: { players: null } };
        }
        const p1 = h2h.players.p1?.name ?? player1;
        const p2 = h2h.players.p2?.name ?? player2;
        const t = h2h.totals ?? {};
        const lines = [
          `${p1} vs ${p2}: ${t.p1_wins ?? 0}-${t.p2_wins ?? 0}` +
            `${t.undecided ? ` (+${t.undecided} undecided)` : ''}`,
        ];
        if (h2h.by_surface && Object.keys(h2h.by_surface).length) {
          lines.push(
            `By surface: ${Object.entries(h2h.by_surface)
              .map(([s, wl]) => `${s} ${wl?.p1 ?? 0}-${wl?.p2 ?? 0}`)
              .join(' · ')}`,
          );
        }
        const meetings = h2h.meetings ?? [];
        if (meetings.length) {
          lines.push('', `Meetings (newest first, ${meetings.length}):`);
          for (const m of meetings.slice(0, 20)) {
            const who = m.winner === 1 ? p1 : m.winner === 2 ? p2 : '?';
            lines.push(
              `  ${m.date ?? '?'} ${m.tournament ?? '?'}${m.round ? ` (${m.round})` : ''} — ` +
                `${who} won${m.score ? ` ${m.score}` : ''}${m.era === 'archive' ? ' · archive' : ''}` +
                `${m.outcome && m.outcome !== 'completed' ? ` · ${m.outcome}` : ''}`,
            );
          }
          if (meetings.length > 20) lines.push(`  … ${meetings.length - 20} more in the structured half.`);
        }
        return {
          text: lines.join('\n'),
          data: {
            players: { p1: n(h2h.players.p1?.name), p2: n(h2h.players.p2?.name) },
            totals: {
              p1_wins: n(t.p1_wins),
              p2_wins: n(t.p2_wins),
              meetings: n(t.meetings),
              undecided: n(t.undecided),
            },
            by_surface: Object.fromEntries(
              Object.entries(h2h.by_surface ?? {}).map(([s, wl]) => [s, { p1: n(wl?.p1), p2: n(wl?.p2) }]),
            ),
            meetings: meetings.map((m) => ({
              era: n(m.era),
              date: n(m.date),
              tournament: n(m.tournament),
              round: n(m.round ?? m.round_code),
              surface: n(m.surface),
              score: n(m.score),
              outcome: n(m.outcome),
              winner: n(m.winner),
              match_id: n(m.match_id),
            })),
          },
        };
      }),
  );

  // -- PRO ----------------------------------------------------------------------

  server.registerTool(
    'get_match_events',
    {
      title: 'Match timeline',
      description:
        'Timeline of events for a match — breaks, games won, sets won, momentum runs. ' +
        'Requires the PRO plan.',
      inputSchema: { match_id: matchIdField, limit: limitField(200, 30, 'events') },
      outputSchema: {
        ok: okField,
        message: messageField,
        events: z
          .array(
            z.object({
              timestamp: z.string().nullable().describe('When the event occurred.'),
              type: z.string().nullable().describe('Event type, e.g. break, game, set.'),
              player: z.number().nullable().describe('Player the event belongs to, 1 or 2.'),
            }),
          )
          .optional()
          .describe('Events in chronological order.'),
      },
      annotations: READ_ONLY,
    },
    ({ match_id, limit }) =>
      guard(async () => {
        const page = await client.listMatchEvents(match_id, { limit });
        if (!page.data.length) return { text: 'No events recorded for this match.', data: { events: [] } };
        return {
          text: page.data
            .map((e) => `${e.timestamp ?? '?'} — ${e.type ?? '?'}${e.player ? ` (player ${e.player})` : ''}`)
            .join('\n'),
          data: {
            events: page.data.map((e) => ({ timestamp: n(e.timestamp), type: n(e.type), player: n(e.player) })),
          },
        };
      }),
  );

  server.registerTool(
    'get_match_odds',
    {
      title: 'Match market prices',
      description:
        'Match-winner market prices for a match — implied probability per player, with ' +
        'bid, ask and mid. Requires the PRO plan.',
      inputSchema: { match_id: matchIdField, limit: limitField(200, 10, 'price points') },
      outputSchema: {
        ok: okField,
        message: messageField,
        market: z
          .object({
            question: z.string().nullable().describe('The market being priced.'),
            status: z.string().nullable().describe('Market status, e.g. open or resolved.'),
            volume: z.number().nullable().describe('24h traded volume.'),
            liquidity: z.number().nullable().describe('Resting liquidity.'),
            prices: z.array(PriceOut).describe('Recent prices, newest first.'),
          })
          .optional()
          .describe('The match-winner market.'),
      },
      annotations: READ_ONLY,
    },
    ({ match_id, limit }) =>
      guard(async () => {
        const market = await client.getMarketPrices(match_id, { limit });
        if (!market) return { text: 'No market data for that match.' };
        const lines = [`Market: ${market.question ?? '-'}`];
        if (market.status) lines.push(`Status: ${market.status}`);
        if (market.volume != null) lines.push(`24h volume: ${market.volume}`);
        if (market.liquidity != null) lines.push(`Liquidity: ${market.liquidity}`);
        lines.push('', 'Recent prices (newest first):');
        for (const p of market.prices ?? []) {
          lines.push(
            `  side ${p.side}: mid ${p.mid ?? '-'} · bid ${p.bid ?? '-'} · ask ${p.ask ?? '-'}` +
              `${p.timestamp ? ` @ ${p.timestamp}` : ''}`,
          );
        }
        return {
          text: lines.join('\n'),
          data: {
            market: {
              question: n(market.question),
              status: n(market.status),
              volume: n(market.volume),
              liquidity: n(market.liquidity),
              prices: (market.prices ?? []).map((p) => ({
                side: n(p.side),
                mid: n(p.mid),
                bid: n(p.bid),
                ask: n(p.ask),
                timestamp: n(p.timestamp),
              })),
            },
          },
        };
      }),
  );

  // -- ULTRA --------------------------------------------------------------------

  server.registerTool(
    'get_match_analysis',
    {
      title: 'Model analysis',
      description:
        "Model analysis for a match: predicted win probability, the model's thesis and " +
        'the key factors behind it. Requires the ULTRA plan.',
      inputSchema: { match_id: matchIdField },
      outputSchema: {
        ok: okField,
        message: messageField,
        profile: z
          .object({
            win_probability_p1: z.number().nullable().describe('Model probability player 1 wins, 0-1.'),
            expected_closeness: z.number().nullable().describe('How close the model expects the match to be.'),
            volatility_rating: z.string().nullable().describe('Expected swing in the match state.'),
            key_factors: z.array(z.string()).describe('Drivers behind the model view.'),
          })
          .optional()
          .describe('Quantitative view.'),
        thesis: z
          .object({
            pick_side: z.number().nullable().describe('Player the model favours, 1 or 2.'),
            confidence: z.number().nullable().describe('Model confidence, 0-1.'),
            state: z.string().nullable().describe('Current state of the thesis.'),
            reasoning: z.string().nullable().describe('Narrative reasoning.'),
          })
          .optional()
          .describe('Narrative view.'),
      },
      annotations: READ_ONLY,
    },
    ({ match_id }) =>
      guard(async () => {
        const analysis = await client.getMatchAnalysis(match_id);
        if (!analysis || (!analysis.thesis && !analysis.profile)) {
          return { text: 'No model analysis exists for this match yet.' };
        }
        const lines: string[] = [];
        const data: Record<string, unknown> = {};
        if (analysis.profile) {
          const p = analysis.profile;
          lines.push('Profile:');
          if (p.win_probability_p1 != null) {
            lines.push(`  Win probability (player 1): ${(p.win_probability_p1 * 100).toFixed(1)}%`);
          }
          if (p.expected_closeness != null) lines.push(`  Expected closeness: ${p.expected_closeness}`);
          if (p.volatility_rating) lines.push(`  Volatility: ${p.volatility_rating}`);
          if (p.key_factors?.length) lines.push(`  Key factors: ${p.key_factors.join('; ')}`);
          data.profile = {
            win_probability_p1: n(p.win_probability_p1),
            expected_closeness: n(p.expected_closeness),
            volatility_rating: n(p.volatility_rating),
            key_factors: p.key_factors ?? [],
          };
        }
        if (analysis.thesis) {
          const t = analysis.thesis;
          lines.push('', 'Thesis:');
          if (t.pick_side) lines.push(`  Pick: player ${t.pick_side}`);
          if (t.confidence != null) lines.push(`  Confidence: ${(t.confidence * 100).toFixed(0)}%`);
          if (t.state) lines.push(`  State: ${t.state}`);
          if (t.reasoning) lines.push(`  Reasoning: ${t.reasoning}`);
          data.thesis = {
            pick_side: n(t.pick_side),
            confidence: n(t.confidence),
            state: n(t.state),
            reasoning: n(t.reasoning),
          };
        }
        return { text: lines.join('\n'), data };
      }),
  );

  // -- meta ---------------------------------------------------------------------

  server.registerTool(
    'check_api_status',
    {
      title: 'API status and plan',
      description:
        'Check whether the Live Tennis API is reachable and which plan the configured ' +
        'key is on. Useful for diagnosing why other tools are refusing data.',
      inputSchema: {},
      outputSchema: {
        ok: okField,
        message: messageField,
        reachable: z.boolean().optional().describe('True when the API answered its health check.'),
        api_version: z.string().nullable().optional().describe('API version reported by the health check.'),
        tier: z
          .string()
          .nullable()
          .optional()
          .describe('Detected plan: FREE, BASIC, PRO or ULTRA. Null when no key is configured.'),
        has_key: z.boolean().optional().describe('Whether a key was supplied with this call.'),
      },
      annotations: READ_ONLY,
    },
    async (): Promise<ToolResult> => {
      const structured = (message: string, extra: Record<string, unknown>): ToolResult => ({
        content: [{ type: 'text', text: message }],
        structuredContent: { ok: true, message, ...extra },
      });
      try {
        const health = await client.health();
        if (!apiKey) {
          return structured(
            `API is reachable (status: ${health.status}, version: ${health.version}).\n` +
              'No API key is configured, so only this check will work. Set LIVETENNISAPI_KEY in ' +
              'your MCP client config, or send "Authorization: Bearer twjp_…" if you are calling ' +
              'the hosted endpoint — get a free key at https://livetennisapi.com/subscribe/free',
            { reachable: true, api_version: n(health.version), tier: null, has_key: false },
          );
        }
        // Probe upward to discover the tier without asking the user.
        let tier = 'BASIC';
        try {
          await client.listMatches({ status: 'completed', limit: 1 });
        } catch (err) {
          if (err instanceof Unauthorized) {
            return structured('API is reachable, but the configured key was rejected (unauthorized).', {
              reachable: true,
              api_version: n(health.version),
              tier: null,
              has_key: true,
            });
          }
          throw err;
        }
        // FREE stops short of history, so an UpgradeRequired HERE identifies it —
        // and MUST be caught. Uncaught it escaped to the outer handler, which
        // reported a perfectly valid free key as "Could not reach the API".
        let historyPage: Awaited<ReturnType<typeof client.listCompletedMatches>> | null = null;
        try {
          historyPage = await client.listCompletedMatches({ limit: 1 });
        } catch (err) {
          if (err instanceof UpgradeRequired) tier = 'FREE';
          else throw err;
        }
        const id = historyPage?.data[0]?.id;
        // A FREE key cannot hold PRO/ULTRA, so skip the climb entirely.
        if (tier !== 'FREE' && id != null) {
          // Climb the ladder. Only UpgradeRequired proves a tier is NOT held --
          // NotFound means the call was allowed but that match has no data, so
          // it is evidence of entitlement, not of a missing plan.
          try {
            await client.listMatchEvents(id, { limit: 1 });
            tier = 'PRO';
          } catch (err) {
            if (err instanceof NotFound) tier = 'PRO';
            else if (!(err instanceof UpgradeRequired)) throw err;
          }
          if (tier === 'PRO') {
            try {
              await client.getMatchAnalysis(id);
              tier = 'ULTRA';
            } catch (err) {
              if (err instanceof NotFound) tier = 'ULTRA';
              else if (!(err instanceof UpgradeRequired)) throw err;
            }
          }
        }
        return structured(
          `API is reachable (status: ${health.status}, version: ${health.version}).\n` +
            `The configured key appears to be on the ${tier} plan.\n\n` +
            'FREE  = live & upcoming matches, scores, players, fixtures, tournaments\n' +
            'BASIC = + historical results, the results archive (1968–2022), head-to-head\n' +
            'PRO   = + match events and market prices\n' +
            'ULTRA = + model analysis, win probability and the live feed',
          { reachable: true, api_version: n(health.version), tier, has_key: true },
        );
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `Could not reach the API: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}
