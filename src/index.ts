#!/usr/bin/env node
/**
 * MCP server for the Live Tennis API.
 *
 * Exposes real-time tennis data as tools any MCP client (Claude Desktop,
 * Claude Code, Cursor, Zed, …) can call.
 *
 *   claude mcp add livetennis -e LIVETENNISAPI_KEY=twjp_… -- npx -y livetennisapi-mcp
 *
 * Design note — **tier awareness is the point.** The API gates endpoints by
 * plan and returns a bare `403 {"error":"upgrade_required"}`. An LLM handed
 * that will usually either hallucinate a reason or retry pointlessly. So every
 * tool that can hit a tier wall returns a plain-English explanation naming the
 * tier required and where to upgrade, as a non-error result. The model can then
 * tell the user something true and actionable instead of guessing.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  LiveTennisAPI,
  NotFound,
  RateLimited,
  Unauthorized,
  UpgradeRequired,
  formatScore,
  type Match,
} from 'livetennisapi';
import { z } from 'zod';

const VERSION = '1.0.1';

const apiKey = (process.env.LIVETENNISAPI_KEY ?? '').trim();
const client = new LiveTennisAPI({
  apiKey,
  baseUrl: process.env.LIVETENNISAPI_BASE_URL,
});

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const text = (body: string): ToolResult => ({ content: [{ type: 'text', text: body }] });

/**
 * Run a tool body, translating API failures into text the model can act on.
 *
 * A tier wall is deliberately **not** an error result: it is a normal,
 * expected state with a clear remedy, and marking it as an error tends to make
 * clients retry or bail rather than relay the upgrade path to the user.
 */
async function guard(run: () => Promise<string>): Promise<ToolResult> {
  if (!apiKey) {
    return text(
      'No API key configured. Set the LIVETENNISAPI_KEY environment variable in your ' +
        'MCP client config. Get a key at https://livetennisapi.com/#pricing',
    );
  }
  try {
    return text(await run());
  } catch (err) {
    if (err instanceof UpgradeRequired) {
      return text(
        `This data requires the ${err.requiredTier ?? 'a higher'} plan, and the configured ` +
          `API key is on a lower tier. Nothing is wrong with the key — the endpoint is ` +
          `simply not included in the current plan. Upgrade at https://livetennisapi.com/#pricing\n\n` +
          `Tiers: BASIC = matches, scores, players, fixtures, history · ` +
          `PRO = + match events and market prices · ` +
          `ULTRA = + model analysis, win probability and the live WebSocket feed.`,
      );
    }
    if (err instanceof Unauthorized) {
      return text(
        'The API key was rejected — it is missing, unknown, or disabled. Check ' +
          'LIVETENNISAPI_KEY in your MCP client config. Keys are at https://livetennisapi.com',
      );
    }
    if (err instanceof NotFound) {
      return text('No data found for that request. The id may be wrong, or there may be no data yet.');
    }
    if (err instanceof RateLimited) {
      const wait = err.retryAfter ? ` Retry in about ${err.retryAfter}s.` : '';
      return text(`Rate limit reached for this plan.${wait}`);
    }
    return { ...text(`Request failed: ${err instanceof Error ? err.message : String(err)}`), isError: true };
  }
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

const server = new McpServer({ name: 'livetennisapi', version: VERSION });

// -- BASIC --------------------------------------------------------------------

server.tool(
  'get_live_matches',
  'List tennis matches currently in progress, with live scores. Covers ATP, WTA, ' +
    'Challenger and ITF. Use this for "what tennis is on right now".',
  { limit: z.number().int().min(1).max(200).default(20).describe('Maximum matches to return') },
  ({ limit }) =>
    guard(async () => {
      const page = await client.listMatches({ status: 'live', limit });
      if (!page.data.length) return 'No matches are live right now.';
      return `${page.data.length} live match(es):\n\n${page.data.map(summarise).join('\n\n')}`;
    }),
);

server.tool(
  'get_upcoming_matches',
  'List tennis matches scheduled to start soon, with players and tournament.',
  { limit: z.number().int().min(1).max(200).default(20) },
  ({ limit }) =>
    guard(async () => {
      const page = await client.listMatches({ status: 'upcoming', limit });
      if (!page.data.length) return 'No upcoming matches are scheduled.';
      return `${page.data.length} upcoming match(es):\n\n${page.data.map(summarise).join('\n\n')}`;
    }),
);

server.tool(
  'get_match',
  'Full detail for one match by id: players, score, surface, round and status. ' +
    'Includes market prices on PRO and model analysis on ULTRA.',
  { match_id: z.number().int().describe('Match id, from get_live_matches or search') },
  ({ match_id }) =>
    guard(async () => {
      const match = await client.getMatch(match_id);
      let out = summarise(match);
      if (match.market) {
        out += `\n\nMarket: ${match.market.question ?? '-'}`;
        for (const price of match.market.prices ?? []) {
          out += `\n  Side ${price.side}: mid ${price.mid ?? '-'} (bid ${price.bid ?? '-'} / ask ${price.ask ?? '-'})`;
        }
      }
      if (match.analysis?.profile) {
        const profile = match.analysis.profile;
        out += `\n\nModel analysis:`;
        if (profile.win_probability_p1 != null) {
          out += `\n  Win probability (player 1): ${(profile.win_probability_p1 * 100).toFixed(1)}%`;
        }
        if (profile.key_factors?.length) out += `\n  Key factors: ${profile.key_factors.join('; ')}`;
      }
      return out;
    }),
);

server.tool(
  'get_match_score',
  'Current score for one match — the fastest, lowest-latency read. Use this when ' +
    'you only need the score and already know the match id.',
  { match_id: z.number().int() },
  ({ match_id }) =>
    guard(async () => {
      const score = await client.getMatchScore(match_id);
      const parts = [`Score: ${formatScore(score)}`];
      if (score.sets) parts.push(`Sets: ${score.sets.join('-')}`);
      if (score.server) parts.push(`Serving: player ${score.server}`);
      if (score.is_tiebreak) parts.push('In a tiebreak');
      if (score.win_probability_p1 != null) {
        parts.push(`Model win probability (player 1): ${(score.win_probability_p1 * 100).toFixed(1)}%`);
      }
      return parts.join('\n');
    }),
);

server.tool(
  'search_players',
  'Search tennis players by name. Returns id, country, ranking and tour. Use the ' +
    'returned id with get_player.',
  {
    query: z.string().min(1).describe('Full or partial player name, e.g. "alcaraz"'),
    limit: z.number().int().min(1).max(200).default(10),
  },
  ({ query, limit }) =>
    guard(async () => {
      const page = await client.searchPlayers(query, { limit });
      if (!page.data.length) return `No players matched "${query}".`;
      return page.data
        .map(
          (p) =>
            `[${p.id}] ${p.name ?? '?'}${p.country ? ` (${p.country})` : ''}` +
            `${p.ranking != null ? ` — rank ${p.ranking}` : ''}${p.tour ? ` · ${p.tour}` : ''}`,
        )
        .join('\n');
    }),
);

server.tool(
  'get_player',
  "One player's profile: ranking, country, handedness, date of birth and cached stats.",
  { player_id: z.number().int().describe('Player id, from search_players') },
  ({ player_id }) =>
    guard(async () => {
      const p = await client.getPlayer(player_id);
      const rows = [
        `${p.name ?? 'Unknown'} [${p.id}]`,
        p.country ? `Country: ${p.country}` : null,
        p.ranking != null ? `Ranking: ${p.ranking}${p.ranking_points ? ` (${p.ranking_points} pts)` : ''}` : null,
        p.ranking_movement ? `Movement: ${p.ranking_movement}` : null,
        p.hand ? `Plays: ${p.hand === 'R' ? 'right-handed' : 'left-handed'}` : null,
        p.birthday ? `Born: ${p.birthday}` : null,
        p.tour ? `Tour: ${p.tour}` : null,
      ].filter(Boolean);
      return rows.join('\n');
    }),
);

server.tool(
  'get_fixtures',
  'Upcoming scheduled tennis fixtures, earliest first — the forward schedule.',
  { limit: z.number().int().min(1).max(200).default(20) },
  ({ limit }) =>
    guard(async () => {
      const page = await client.listFixtures({ limit });
      if (!page.data.length) return 'No upcoming fixtures.';
      return page.data
        .map(
          (f) =>
            `${f.event_date ?? '?'} — ${f.tournament ?? '?'}` +
            `${f.round ? ` (${f.round})` : ''}: ${f.player1_name ?? '?'} vs ${f.player2_name ?? '?'}`,
        )
        .join('\n');
    }),
);

server.tool(
  'get_recent_results',
  'Recently completed tennis matches with final scores and winners.',
  { limit: z.number().int().min(1).max(200).default(20) },
  ({ limit }) =>
    guard(async () => {
      const page = await client.listCompletedMatches({ limit });
      if (!page.data.length) return 'No completed matches available.';
      return page.data.map(summarise).join('\n\n');
    }),
);

// -- PRO ----------------------------------------------------------------------

server.tool(
  'get_match_events',
  'Timeline of events for a match — breaks, games won, sets won, momentum runs. ' +
    'Requires the PRO plan.',
  { match_id: z.number().int(), limit: z.number().int().min(1).max(200).default(30) },
  ({ match_id, limit }) =>
    guard(async () => {
      const page = await client.listMatchEvents(match_id, { limit });
      if (!page.data.length) return 'No events recorded for this match.';
      return page.data
        .map((e) => `${e.timestamp ?? '?'} — ${e.type ?? '?'}${e.player ? ` (player ${e.player})` : ''}`)
        .join('\n');
    }),
);

server.tool(
  'get_match_odds',
  'Match-winner market prices for a match — implied probability per player, with ' +
    'bid, ask and mid. Requires the PRO plan.',
  { match_id: z.number().int(), limit: z.number().int().min(1).max(200).default(10) },
  ({ match_id, limit }) =>
    guard(async () => {
      const market = await client.getMarketPrices(match_id, { limit });
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
      return lines.join('\n');
    }),
);

// -- ULTRA --------------------------------------------------------------------

server.tool(
  'get_match_analysis',
  "Model analysis for a match: predicted win probability, the model's thesis and " +
    'the key factors behind it. Requires the ULTRA plan.',
  { match_id: z.number().int() },
  ({ match_id }) =>
    guard(async () => {
      const analysis = await client.getMatchAnalysis(match_id);
      if (!analysis.thesis && !analysis.profile) return 'No model analysis exists for this match yet.';
      const lines: string[] = [];
      if (analysis.profile) {
        const p = analysis.profile;
        lines.push('Profile:');
        if (p.win_probability_p1 != null) {
          lines.push(`  Win probability (player 1): ${(p.win_probability_p1 * 100).toFixed(1)}%`);
        }
        if (p.expected_closeness != null) lines.push(`  Expected closeness: ${p.expected_closeness}`);
        if (p.volatility_rating) lines.push(`  Volatility: ${p.volatility_rating}`);
        if (p.key_factors?.length) lines.push(`  Key factors: ${p.key_factors.join('; ')}`);
      }
      if (analysis.thesis) {
        const t = analysis.thesis;
        lines.push('', 'Thesis:');
        if (t.pick_side) lines.push(`  Pick: player ${t.pick_side}`);
        if (t.confidence != null) lines.push(`  Confidence: ${(t.confidence * 100).toFixed(0)}%`);
        if (t.state) lines.push(`  State: ${t.state}`);
        if (t.reasoning) lines.push(`  Reasoning: ${t.reasoning}`);
      }
      return lines.join('\n');
    }),
);

// -- meta ---------------------------------------------------------------------

server.tool(
  'check_api_status',
  'Check whether the Live Tennis API is reachable and which plan the configured ' +
    'key is on. Useful for diagnosing why other tools are refusing data.',
  {},
  async () => {
    try {
      const health = await client.health();
      if (!apiKey) {
        return text(
          `API is reachable (status: ${health.status}, version: ${health.version}).\n` +
            'No API key is configured, so only this check will work. Set LIVETENNISAPI_KEY ' +
            'in your MCP client config — get a key at https://livetennisapi.com/#pricing',
        );
      }
      // Probe upward to discover the tier without asking the user.
      let tier = 'BASIC';
      try {
        await client.listMatches({ status: 'completed', limit: 1 });
      } catch (err) {
        if (err instanceof Unauthorized) {
          return text('API is reachable, but the configured key was rejected (unauthorized).');
        }
        throw err;
      }
      const probe = await client.listCompletedMatches({ limit: 1 });
      const id = probe.data[0]?.id;
      if (id != null) {
        try {
          await client.listMatchEvents(id, { limit: 1 });
          tier = 'PRO';
          await client.getMatchAnalysis(id);
          tier = 'ULTRA';
        } catch (err) {
          if (!(err instanceof UpgradeRequired) && !(err instanceof NotFound)) throw err;
          if (err instanceof NotFound && tier === 'PRO') tier = 'ULTRA'; // entitled, just no analysis
        }
      }
      return text(
        `API is reachable (status: ${health.status}, version: ${health.version}).\n` +
          `The configured key appears to be on the ${tier} plan.\n\n` +
          'BASIC = matches, scores, players, fixtures, history\n' +
          'PRO   = + match events and market prices\n' +
          'ULTRA = + model analysis, win probability and the live feed',
      );
    } catch (err) {
      return {
        ...text(`Could not reach the API: ${err instanceof Error ? err.message : String(err)}`),
        isError: true,
      };
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel — anything logged there corrupts the protocol.
  console.error(`livetennisapi-mcp ${VERSION} ready${apiKey ? '' : ' (no API key configured)'}`);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
