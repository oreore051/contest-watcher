import * as cheerio from "cheerio";
import type { Contest } from "./types.js";
import { deriveStatus } from "./types.js";
import {
  stripHTML,
  extractVideoLength,
  extractPrizeScale,
  extractSubmitMethod,
  extractMaxPrizeFromBody,
} from "./extract.js";
import { isVideoContest } from "./linkareer.js"; // 키워드 셋 공유

const BASE = "https://www.campuspick.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

export const buildDetailUrl = (id: string) => `${BASE}/contest/view?id=${id}`;
export { isVideoContest };

export interface CampuspickListItem {
  id: string;
  title: string;
  host: string | null;
  url: string;
}

async function fetchHTML(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}

/**
 * 캠퍼스픽은 /contest 최신 24개만 SSR로 노출 (JS 페이지네이션).
 * page 인자는 무시 (호환성 유지). 매일 cron이면 24개로 충분.
 */
export async function fetchList(_page = 1): Promise<{ items: CampuspickListItem[] }> {
  const html = await fetchHTML(`${BASE}/contest`);
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const items: CampuspickListItem[] = [];
  $('a[href^="/contest/view?id="]').each((_, el) => {
    const href = $(el).attr("href") || "";
    const m = href.match(/id=(\d+)/);
    if (!m) return;
    const id = m[1];
    if (seen.has(id)) return;
    const title = $(el).find("h3").text().trim();
    if (!title) return;
    const host = $(el).find("p").first().text().trim() || null;
    seen.add(id);
    items.push({ id, title, host, url: buildDetailUrl(id) });
  });
  return { items };
}

function extractInitialState(html: string): any {
  const m = html.match(/<script id="__INITIAL_STATE__"[^>]*>([\s\S]+?)<\/script>/);
  if (!m) throw new Error("__INITIAL_STATE__ not found");
  return JSON.parse(m[1]);
}

export async function fetchDetail(id: string): Promise<Contest> {
  const url = buildDetailUrl(id);
  const html = await fetchHTML(url);
  const state = extractInitialState(html);
  const a = state.activity ?? {};

  const title: string = a.title ?? "";
  const host: string | null = a.company ?? a.company2 ?? null;
  const closeAt: string | null = a.end_date ?? null;
  const prizeKRWStructured: number | null =
    typeof a.prize_top === "number" && a.prize_top > 0 ? a.prize_top : null;

  // description은 \n 보존 + HTML 엔티티 가벼움. stripHTML로 한 번 더.
  const rawDesc: string = a.description ?? "";
  const bodyText = stripHTML(rawDesc);

  const videoLength = extractVideoLength(bodyText);
  const prizeScale = extractPrizeScale(bodyText);
  const submitMethod = extractSubmitMethod(bodyText);
  const prizeKRW = prizeKRWStructured ?? extractMaxPrizeFromBody(bodyText);

  // 캠퍼스픽 이미지는 CDN 경로의 파일명
  const imageFile = (a.image || a.image_thumb) as string | undefined;
  const thumbnailURL = imageFile
    ? (imageFile.startsWith("http") ? imageFile : `https://cf-tabs-image.campuspick.com/activity/${imageFile}`)
    : null;

  return {
    source: "캠퍼스픽",
    externalId: id,
    url,
    title,
    host,
    closeAt,
    prizeKRW,
    prizeScale,
    eligibility: null, // 캠퍼스픽 detail JSON엔 명확한 대상 필드 없음 — 본문에서 추출 가능하나 MVP는 null
    topic: null, // 카테고리 ID만 있어서 라벨 매핑 필요 — MVP는 null
    videoLength,
    submitMethod,
    postSelectionDuty: null,
    awardSamplesURL: a.website || null,
    status: deriveStatus(closeAt),
    detailText: bodyText || null,
    thumbnailURL,
  };
}
