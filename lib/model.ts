// The token radar's model, v2: one snapshot in, one ranked board out.
//
// Every figure the model uses comes from the snapshot itself. The anchor is the market's own answer to
// "what is a token on this record worth": for each category the model reads the live-token protocols the
// snapshot already carries and takes the median market cap per dollar of TVL that their tokens actually
// trade at. A pre-token protocol's implied value is its TVL priced at its category's own comparable
// multiple, then adjusted by the four signals the snapshot carries: seven-day momentum, how long it has
// run with no token (the airdrop window), its scale, and how many chains it distributes across.
//
//   comparable = median(mcap_usd / tvl_usd) over live tokens of the same category   (snapshot-derived)
//   implied    = tvl x comparable x momentum x window x scale x chains
//
// No protocol name is ever special-cased: one function scores every row, and the category table is
// recomputed from the snapshot on every run. Live-token protocols are kept out of the ranked board and
// shown as the comparables that anchor it.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, stated in the dashboard's method panel and tuned there. */
export interface ModelConstants {
  comp_min_tvl: number;          // a comparable must hold at least this much TVL to speak
  comp_ratio_min: number;        // a comparable's mcap/tvl below this is noise, dropped
  comp_ratio_max: number;        // above this it is a mem multiple, dropped
  fallback_multiple: number;     // used when a category has no clean comparable
  global_min_sample: number;     // comparables needed before a category's own median is trusted
  growth_weight: number;         // seven-day change's pull, as a fraction of itself
  growth_floor: number;          // clamp: a crash is not a signal to short the airdrop
  growth_cap: number;
  window_min_days: number;       // below this the protocol is too young to have earned a launch
  window_peak_days: number;      // the sweet spot: long enough to prove itself, young enough to launch
  window_peak_mult: number;
  window_floor_mult: number;     // very young protocols
  window_old_mult: number;       // past the peak, the launch window has probably closed
  scale_soft_cap: number;        // TVL where a category multiple starts to mean-revert
  chain_full: number;            // chains at which the distribution bonus tops out
  chain_bonus_max: number;
}

export const MODEL: ModelConstants = {
  comp_min_tvl: 5_000_000,
  comp_ratio_min: 0.05,
  comp_ratio_max: 50,
  fallback_multiple: 0.30,
  global_min_sample: 3,
  growth_weight: 0.4,
  growth_floor: -60,
  growth_cap: 120,
  window_min_days: 0,
  window_peak_days: 480,
  window_peak_mult: 1.25,
  window_floor_mult: 0.85,
  window_old_mult: 0.9,
  scale_soft_cap: 3_000_000_000,
  chain_full: 6,
  chain_bonus_max: 1.15,
};

export const MODEL_VERSION = 'radar-2-comparables';

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  on_watchlist: boolean;
  implied_value_usd: number;
  model: {
    comparable_multiple: number;
    comparable_sample: number;
    growth_pct: number;
    growth_multiplier: number;
    window_multiplier: number;
    scale_multiplier: number;
    chain_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's view of one row: every number the page shows, board and page agree by construction. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  implied_value_usd: number;
  comparable_multiple: number;
  comparable_sample: number;
  growth_multiplier: number;
  window_multiplier: number;
  scale_multiplier: number;
  chain_multiplier: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows it only as a comparable. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** One category's comparable pricing, derived from the snapshot's live tokens. */
export interface ComparableMultiple {
  category: string;
  sample: number;
  median_multiple: number;
  p25: number;
  p75: number;
}

/** Everything the dashboard needs: the board, the comparables, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  watchlist: string[];
  comparables: ComparableMultiple[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

export function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** The median of a sorted array (linear interpolation on even counts). */
function median(sorted: number[]): number {
  if (sorted.length === 0) return NaN;
  const mid = (sorted.length - 1) / 2;
  const lo = Math.floor(mid), hi = Math.ceil(mid);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (mid - lo);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

const WRAPPED = /\b(wrapped|staked|staking)\b/i;

/** Categories that hold wrapped, bridged or custodial products, not protocols waiting on a token. */
const PRODUCT_CATEGORIES = new Set([
  'bridge', 'canonical bridge', 'liquid staking', 'liquid restaking', 'restaked btc', 'cex',
]);

const EXCHANGE_NAMES = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/**
 * Whether a protocol is one the board may rank: no token of its own, not a wrapped/staked/bridged
 * product of one that trades, not an exchange's internal book and not a versioned pool of a parent.
 * The rule mirrors the house's own watchlist reading so the board speaks the same language as the
 * floor it covers, and it is computed from each record, never from a list of names.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  const category = (p.category ?? '').toLowerCase();
  if (PRODUCT_CATEGORIES.has(category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED.test(p.name)) return false;
  if (EXCHANGE_NAMES.test(p.name)) return false;
  return true;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/**
 * The category pricing table: for each category with at least `global_min_sample` clean live tokens,
 * the median, 25th and 75th percentile of mcap/tvl. Categories with no clean sample fall back to the
 * global median across every clean live token, then to `fallback_multiple`.
 */
export function comparableTable(snapshot: Snapshot, model: ModelConstants = MODEL): { table: Map<string, ComparableMultiple>; globalMultiple: number } {
  const clean: { category: string; ratio: number }[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd < model.comp_min_tvl) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (ratio < model.comp_ratio_min || ratio > model.comp_ratio_max) continue;
    clean.push({ category: (p.category ?? 'Uncategorized').toLowerCase(), ratio });
  }
  const ratios = clean.map((c) => c.ratio).sort((a, b) => a - b);
  const globalMultiple = ratios.length > 0 ? median(ratios) : model.fallback_multiple;
  const byCategory = new Map<string, number[]>();
  for (const c of clean) {
    const list = byCategory.get(c.category) ?? [];
    list.push(c.ratio);
    byCategory.set(c.category, list);
  }
  const table = new Map<string, ComparableMultiple>();
  for (const [category, list] of byCategory) {
    if (list.length < model.global_min_sample) continue;
    const sorted = [...list].sort((a, b) => a - b);
    table.set(category, {
      category,
      sample: sorted.length,
      median_multiple: median(sorted),
      p25: percentile(sorted, 0.25),
      p75: percentile(sorted, 0.75),
    });
  }
  return { table, globalMultiple };
}

/** The three multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  comps: { table: Map<string, ComparableMultiple>; globalMultiple: number },
  model: ModelConstants = MODEL,
): { implied: number; growthPct: number; growthMult: number; windowMult: number; scaleMult: number; chainMult: number; age: number | null; comp: ComparableMultiple | null } {
  const age = ageDays(asOf, p.listed_at);
  const category = (p.category ?? 'Uncategorized').toLowerCase();
  const comp = comps.table.get(category) ?? null;
  const comparableMult = comp ? comp.median_multiple : comps.globalMultiple;

  // Momentum: seven-day TVL change, clamped, worth a fraction of itself.
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, finite(p.change_7d, 0)));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;

  // The launch window: too young has not earned it, past the peak it has probably missed it.
  const ageForModel = age ?? model.window_peak_days * 0.75;
  let windowMult: number;
  if (ageForModel <= model.window_peak_days) {
    const t = model.window_peak_days > 0 ? ageForModel / model.window_peak_days : 1;
    windowMult = model.window_floor_mult + (model.window_peak_mult - model.window_floor_mult) * t;
  } else {
    windowMult = model.window_old_mult;
  }

  // Scale: a category multiple stops meaning anything at very large TVL, so discount toward it.
  const scaleMult = p.tvl_usd <= model.scale_soft_cap ? 1
    : Math.max(0.6, 1 - Math.log10(p.tvl_usd / model.scale_soft_cap) * 0.25);

  // Distribution: a token that lands on six chains has more holders than one that lands on one.
  const chainMult = Math.min(model.chain_bonus_max, 1 + (Math.max(0, p.chains.length - 1) / (model.chain_full - 1)) * (model.chain_bonus_max - 1));

  const implied = Math.max(1, Math.round(p.tvl_usd * comparableMult * growthMult * windowMult * scaleMult * chainMult));
  return { implied, growthPct, growthMult, windowMult, scaleMult, chainMult, age, comp };
}

/** The board: every rankable pre-token protocol in the snapshot, strongest first, ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const onList = new Set(snapshot.watchlist);
  const comps = comparableTable(snapshot, model);

  // The watchlist is the floor: every slug, even one isRankable would wave past, stays on the board.
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The floor is never the ceiling: every other rankable pre-token protocol joins the board.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => ({ p, ...impliedValue(p, snapshot.as_of, comps, model) }));
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    age_days: s.age,
    on_watchlist: onList.has(s.p.slug),
    implied_value_usd: s.implied,
    model: {
      comparable_multiple: round4(s.comp ? s.comp.median_multiple : comps.globalMultiple),
      comparable_sample: s.comp ? s.comp.sample : 0,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      window_multiplier: round4(s.windowMult),
      scale_multiplier: round4(s.scaleMult),
      chain_multiplier: round4(s.chainMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one core action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC as collateral on ${name} (${chain}), then borrow the smallest stable amount it allows and repay it once.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Swap $${capital / 2 | 0} into the pool's main asset and provide $${capital} of two-sided liquidity in ${name}'s deepest pool on ${chain}.`;
  if (c.includes('bridge')) return `Move $${capital} of USDC across ${name} between ${chain} and a second chain it supports, and leave half on each side.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's native asset through ${name} on ${chain} and keep the liquid receipt token in your wallet.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} as margin on ${name}, open one small long and one small short at different times, and close both.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position and one long-shot position on ${name}, then hold both to settlement.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('vault')) return `Deposit $${capital} into the highest-TVL ${name} vault on ${chain} and leave the shares untouched.`;
  if (c.includes('stable')) return `Mint $${capital} of the stable asset through ${name} on ${chain}, redeem a third of it, and keep the rest.`;
  if (c.includes('rwa')) return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it across at least one accrual period.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover on ${name}'s largest market on ${chain} and keep the policy active.`;
  if (c.includes('launchpad') || c.includes('ido')) return `Join one sale or participation round on ${name} with $${capital / 2 | 0} and complete every eligibility task it lists.`;
  if (c.includes('nft') || c.includes('collectible')) return `Trade once each way on ${name}'s main market on ${chain}: list one item and buy one item under $${capital / 4 | 0}.`;
  if (c.includes('wallet') || c.includes('infrastructure')) return `Use ${name} as your default interface on ${chain} for a week: send, receive and swap $${capital / 5 | 0} at least twice.`;
  if (c.includes('gaming') || c.includes('betting')) return `Play or participate on ${name} for $${capital / 4 | 0} across several sessions in one week.`;
  if (c.includes('privacy') || c.includes('messaging') || c.includes('social')) return `Use ${name}'s core action (a send, a post, a proof) at least five times from one wallet.`;
  return `Deposit $${capital} of USDC into ${name}'s core product on ${chain} and use its main action once.`;
}

/** A second action on another chain the protocol runs, when it runs more than one. */
function secondChainStep(p: SnapshotProtocol, capital: number): FarmStep | null {
  if (p.chains.length < 2) return null;
  const chain = p.chains[1]!;
  return {
    text: `Repeat a smaller version of the core action on ${chain}: ${p.name} runs there too, and multi-chain users are the easiest cohort to reward.`,
    cost: `$${Math.max(10, capital / 4 | 0)} plus gas on ${chain}`,
    time: '15 minutes',
  };
}

/**
 * A protocol's farm plan: seven to eight concrete steps, each with a cost and a time, derived from the
 * protocol's own record (category, chains, TVL, age) and never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const steps: FarmStep[] = [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm on ${chain}, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
  ];
  const second = secondChainStep(p, capital);
  if (second) steps.push(second);
  steps.push(
    {
      text: `Return once a week and repeat the core action: a deposit, a swap, a borrow or a vote, so the wallet's activity spans several weekly snapshots.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days. ${age !== null && age < 180 ? `${p.name} is only ${age} days old on DefiLlama, so an early, consistent record is exactly what a launch would reward.` : 'A record that spans months survives sybil filters better than one burst of activity.'}`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Watch ${p.name}'s own announcements channel and governance forum for snapshot, points-programme or token talks, and act on official links only.`,
      cost: 'free to read, and never pay anyone to claim',
      time: '5 minutes a week',
    },
    {
      text: `Keep the position alive but de-risked: if TVL drops more than half or an exploit is reported, withdraw to the fresh wallet and stop farming it.`,
      cost: 'a withdrawal, about $4 of gas',
      time: '10 minutes',
    },
    {
      text: `Log the wallet address, every date and every transaction hash, so you can prove the record when a claim opens or unwind without losing track.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  );
  return steps;
}

/** The live-token protocols, by market cap: the comparables the board is priced against. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd !== null)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, 40)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** The dashboard's view of one row. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    on_watchlist: row.on_watchlist,
    implied_value_usd: row.implied_value_usd,
    comparable_multiple: row.model.comparable_multiple,
    comparable_sample: row.model.comparable_sample,
    growth_multiplier: row.model.growth_multiplier,
    window_multiplier: row.model.window_multiplier,
    scale_multiplier: row.model.scale_multiplier,
    chain_multiplier: row.model.chain_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const { table } = comparableTable(snapshot, model);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    watchlist: [...snapshot.watchlist],
    comparables: [...table.values()].sort((a, b) => b.median_multiple - a.median_multiple),
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
