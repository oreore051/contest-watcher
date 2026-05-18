import * as cheerio from "cheerio";
import type { Contest } from "./types.js";
import { deriveStatus } from "./types.js";
import {
  stripHTML,
  extractVideoLength,
  extractPrizeScale,
  extractSubmitMethod,
  extractMaxPrizeFromBody,
  parseKRW,
} from "./extract.js";

const BASE = "https://www.wevity.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const VIDEO_CATEGORY = "gub=1&cidx=10"; // 영상/UCC/사진

export const buildDetailUrl = (ix: string) =>
  `${BASE}/?c=find&s=1&${VIDEO_CATEGORY}&gbn=view&ix=${ix}`;

export interface WevityListItem {
  ix: string;
  title: string;
  url: string;
}

async function fetchHTML(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}

export async function fetchList(page = 1): Promise<{ items: WevityListItem[] }> {
  const url = `${BASE}/?c=find&s=1&${VIDEO_CATEGORY}&gbn=list&gp=${page}`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const items: WevityListItem[] = [];
  $('a[href*="gbn=view"][href*="ix="]').each((_, el) => {
    const href = $(el).attr("href") || "";
    // cidx=10 컨텍스트만 (광고 배너 등 외부 ix 제외)
    if (!/cidx=10/.test(href)) return;
    const m = href.match(/ix=(\d+)/);
    if (!m) return;
    const ix = m[1];
    if (seen.has(ix)) return;
    const title = $(el).text().trim();
    if (!title || title.length < 4) return; // 이미지 anchor 등 빈 텍스트 skip
    seen.add(ix);
    items.push({ ix, title, url: buildDetailUrl(ix) });
  });
  return { items };
}

export async function fetchDetail(ix: string): Promise<Contest> {
  const url = buildDetailUrl(ix);
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);

  const ogTitle = $('meta[property="og:title"]').attr("content") || "";
  const thumbnailURL = $('meta[property="og:image"]').attr("content") || null;
  const title = ogTitle.replace(/\s*\|\s*공모전 대외활동.*$/, "").trim() ||
    $("h2").first().text().trim();

  const info: Record<string, string> = {};
  $(".cd-info-list > li").each((_, li) => {
    const $li = $(li);
    const tit = $li.find(".tit").first().text().trim();
    if (!tit) return;
    const homepage = $li.find("a").first().attr("href");
    const val = $li
      .clone()
      .find(".tit, .cil-dday, script, .cd-sns, .sns")
      .remove()
      .end()
      .text()
      .replace(/\s+/g, " ")
      .trim();
    info[tit] = val;
    if (tit === "홈페이지" && homepage) info["홈페이지URL"] = homepage;
  });

  const host = info["주최/주관"] || null;

  // 접수기간 "2026-06-01 ~ 2026-07-30"
  let closeAt: string | null = null;
  const period = info["접수기간"] || "";
  const periodM = period.match(/(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/);
  if (periodM) closeAt = periodM[2];

  // 1등 상금 우선 → 총 상금 → 본문 시상내역에서 max
  const prizeKRW =
    parseKRW(info["1등 상금"]) ??
    parseKRW(info["총 상금"]) ??
    null;

  const topic = info["분야"] || null;
  const eligibility = info["응모대상"] ? `대상: ${info["응모대상"]}` : null;
  const homepage = info["홈페이지URL"] || null;

  const bodyRaw = $("#viewContents").html() || "";
  const bodyText = stripHTML(bodyRaw);
  const videoLength = extractVideoLength(bodyText);
  const prizeScale = extractPrizeScale(bodyText);
  const submitMethod = extractSubmitMethod(bodyText);
  const prizeKRWFinal = prizeKRW ?? extractMaxPrizeFromBody(bodyText);

  return {
    source: "위비티",
    externalId: ix,
    url,
    title,
    host,
    closeAt,
    prizeKRW: prizeKRWFinal,
    prizeScale,
    eligibility,
    topic,
    videoLength,
    submitMethod,
    postSelectionDuty: null,
    awardSamplesURL: null,
    status: deriveStatus(closeAt),
    detailText: bodyText || null,
    thumbnailURL,
  };
}
