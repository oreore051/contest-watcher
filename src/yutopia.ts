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

const BASE = "https://yutopia.yu.ac.kr";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
// 사용자 지정: 카테고리 160 + 키워드 "영상"
const LIST_PATH = "/ko/program/8?category=160&keyword=영상";

export const buildDetailUrl = (id: string) => `${BASE}/ko/program/8/view/${id}`;

export interface YutopiaListItem {
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

export async function fetchList(_page = 1): Promise<{ items: YutopiaListItem[] }> {
  const html = await fetchHTML(BASE + LIST_PATH);
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const items: YutopiaListItem[] = [];

  $('a[href*="/ko/program/8/view/"]').each((_, el) => {
    const href = $(el).attr("href") || "";
    const m = href.match(/\/view\/(\d+)/);
    if (!m) return;
    const id = m[1];
    if (seen.has(id)) return;
    // anchor 내부에서 title 후보 추출 — institution은 host
    const $a = $(el);
    const title = ($a.find(".title, h3, h4, .program-title").first().text().trim()) ||
      $a.attr("title") ||
      "";
    const host = $a.find(".institution").first().text().trim() || null;
    if (!title && !host) return;
    seen.add(id);
    items.push({ id, title: title || `(제목 미파악 #${id})`, host, url: buildDetailUrl(id) });
  });
  return { items };
}

function metaContent($: cheerio.CheerioAPI, prop: string): string {
  return $(`meta[property="${prop}"], meta[name="${prop}"]`).first().attr("content") ?? "";
}

export async function fetchDetail(id: string): Promise<Contest> {
  const url = buildDetailUrl(id);
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);

  const title = metaContent($, "og:title").replace(/\s*\|\s*.*$/, "").trim();
  const ogDesc = metaContent($, "og:description");
  const thumbnailURL = metaContent($, "og:image") || null;

  // 본문 영역 — eco/program 디테일에서 description 클래스 또는 description-like div
  // 안 찾히면 og:description만이라도 사용
  let bodyHTML = $('[data-role="description"], .description, .editor-output, .view-content').first().html() ?? "";
  // 첨부파일 정보 같이 본문에
  const attachments = $('div[data-module="attachment"] a').map((_, a) => {
    const $a = $(a);
    const name = $a.text().trim();
    const href = $a.attr("href") || "";
    return name && href ? `첨부: ${name} (${href.startsWith("http") ? href : BASE + href})` : "";
  }).get().filter(Boolean).join("\n");

  let bodyText = stripHTML(bodyHTML);
  if (bodyText.length < 50 && ogDesc) bodyText = ogDesc; // 본문 빈약하면 og 메타 fallback
  if (attachments) bodyText += "\n\n" + attachments;

  // 마감일 추출 — "~ 2026-05-30" "~ 2026. 05. 30" 같은 패턴
  let closeAt: string | null = null;
  const dateM = bodyText.match(/(?:~|마감|종료)\s*(\d{4})[.\-\s]+(\d{1,2})[.\-\s]+(\d{1,2})/);
  if (dateM) {
    const [, y, mo, d] = dateM;
    closeAt = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  const videoLength = extractVideoLength(bodyText);
  const prizeScale = extractPrizeScale(bodyText);
  const submitMethod = extractSubmitMethod(bodyText);
  const prizeKRW = extractMaxPrizeFromBody(bodyText);

  return {
    source: "유토피아",
    externalId: id,
    url,
    title: title || "(제목 미파악)",
    host: "영남대학교",
    closeAt,
    prizeKRW,
    prizeScale,
    eligibility: "영남대 재학생", // 교내 공모전이라 기본값
    topic: null,
    videoLength,
    submitMethod,
    postSelectionDuty: null,
    awardSamplesURL: null,
    status: deriveStatus(closeAt),
    detailText: bodyText || null,
    thumbnailURL,
  };
}
