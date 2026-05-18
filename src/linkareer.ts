import type { Contest } from "./types.js";
import {
  stripHTML,
  extractVideoLength,
  extractPrizeScale,
  extractSubmitMethod,
  extractMaxPrizeFromBody,
} from "./extract.js";

const BASE = "https://linkareer.com";

export const buildActivityUrl = (id: string) => `${BASE}/activity/${id}`;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

// 영상 명백한 키워드만 (라이브커머스/콘텐츠/광고/크리에이터 같은 오버브로드 단어 제외)
const VIDEO_KEYWORDS = [
  "영상", "동영상", "비디오", "UCC",
  "쇼츠", "숏폼", "숏츠", "Shorts",
  "광고제", "CF공모",
  "다큐", "다큐멘터리",
  "단편영화", "단편 영화", "영화제",
  "뮤직비디오", "MV공모",
  "브이로그", "Vlog",
  "릴스", "Reels",
  "트레일러",
  "유튜브", "YouTube",
];

interface ApolloActivityList {
  __typename: "Activity";
  id: string;
  title: string;
  organizationName: string | null;
  recruitCloseAt: number | null;
}

async function fetchHTML(path: string): Promise<string> {
  const res = await fetch(BASE + path, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.text();
}

function extractNextData(html: string): any {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
  if (!m) throw new Error("__NEXT_DATA__ not found");
  return JSON.parse(m[1]);
}

function getApolloState(html: string): Record<string, any> {
  const data = extractNextData(html);
  const state = data?.props?.pageProps?.__APOLLO_STATE__;
  if (!state) throw new Error("__APOLLO_STATE__ missing");
  return state;
}

function resolveRef(state: Record<string, any>, ref: any): any {
  if (!ref) return null;
  if (Array.isArray(ref)) return ref.map((r) => resolveRef(state, r));
  if (typeof ref === "object" && ref.__ref) return state[ref.__ref] ?? null;
  return ref;
}

export function isVideoContest(title: string, categoryNames: string[] = []): boolean {
  const hay = [title, ...categoryNames].join(" ");
  return VIDEO_KEYWORDS.some((kw) => hay.includes(kw));
}

export interface LinkareerListItem {
  id: string;
  title: string;
  organizationName: string | null;
  recruitCloseAt: number | null;
}

export async function fetchList(page = 1): Promise<{ items: LinkareerListItem[]; totalCount: number }> {
  const html = await fetchHTML(`/list/contest?page=${page}`);
  const state = getApolloState(html);
  const rq = state.ROOT_QUERY ?? {};
  const actKey = Object.keys(rq).find((k) => k.startsWith("activities"));
  if (!actKey) throw new Error("activities query not found in ROOT_QUERY");
  const result = rq[actKey];
  const nodes: ApolloActivityList[] = (result.nodes ?? []).map((ref: any) => resolveRef(state, ref));
  const items: LinkareerListItem[] = nodes.map((n) => ({
    id: n.id,
    title: n.title,
    organizationName: n.organizationName,
    recruitCloseAt: n.recruitCloseAt,
  }));
  return { items, totalCount: result.totalCount ?? 0 };
}

export async function fetchDetail(id: string): Promise<Contest> {
  const html = await fetchHTML(`/activity/${id}`);
  const state = getApolloState(html);
  const act = Object.values(state).find(
    (v: any) => v?.__typename === "Activity" && v.id === id
  ) as any;
  if (!act) throw new Error(`Activity ${id} not found in detail page state`);

  const categories = (resolveRef(state, act.categories) ?? []) as Array<{ name: string }>;
  const targets = (resolveRef(state, act.targets) ?? []) as Array<{ name?: string }>;
  const applyTypes = (resolveRef(state, act.applyTypes) ?? []) as Array<{ name?: string }>;
  const detailTextObj = resolveRef(state, act.detailText) as { text?: string } | null;
  const rawBody = detailTextObj?.text ?? null;
  const bodyText = rawBody ? stripHTML(rawBody) : null;
  const videoLength = bodyText ? extractVideoLength(bodyText) : null;
  const prizeScaleFromBody = bodyText ? extractPrizeScale(bodyText) : null;
  const submitMethodFromBody = bodyText ? extractSubmitMethod(bodyText) : null;

  const closeAt = act.recruitCloseAt
    ? new Date(act.recruitCloseAt).toISOString().slice(0, 10)
    : null;
  const prizeKRWStructured = act.tenThousandUnitOfReward
    ? Number(act.tenThousandUnitOfReward) * 10000
    : null;
  const prizeKRW =
    prizeKRWStructured ?? (bodyText ? extractMaxPrizeFromBody(bodyText) : null);

  const eligibilityParts: string[] = [];
  if (targets.length) eligibilityParts.push("대상: " + targets.map((t) => t.name).filter(Boolean).join(", "));
  if (Array.isArray(act.regions) && act.regions.length) eligibilityParts.push("지역: " + act.regions.join(", "));
  if (Array.isArray(act.educationTypes) && act.educationTypes.length) eligibilityParts.push("학력: " + act.educationTypes.join(", "));

  return {
    source: "링커리어",
    externalId: id,
    url: `${BASE}/activity/${id}`,
    title: act.title,
    host: act.organizationName ?? act.company ?? null,
    closeAt,
    prizeKRW,
    prizeScale: prizeScaleFromBody ?? act.additionalBenefit ?? (act.recruitScale && Number(act.recruitScale) > 0 ? `${act.recruitScale}명` : null),
    eligibility: eligibilityParts.length ? eligibilityParts.join(" / ") : null,
    topic: categories.map((c) => c.name).filter(Boolean).join(", ") || null,
    videoLength,
    submitMethod: submitMethodFromBody ?? (applyTypes.map((t) => t.name).filter(Boolean).join(", ") || null),
    postSelectionDuty: null,
    awardSamplesURL: act.youtubeURL ?? null,
    status: "모집중",
    detailText: bodyText,
  };
}

export function filterVideo(items: LinkareerListItem[], categoryHints: Map<string, string[]> = new Map()): LinkareerListItem[] {
  return items.filter((it) => isVideoContest(it.title, categoryHints.get(it.id) ?? []));
}

export function isVideoByContest(c: Contest): boolean {
  return isVideoContest(c.title, c.topic ? c.topic.split(",").map((s) => s.trim()) : []);
}
