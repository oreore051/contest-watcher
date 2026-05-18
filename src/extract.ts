/**
 * 사이트 어댑터 공통 — HTML 본문에서 자유 텍스트 필드 추출
 */

export function stripHTML(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<\/div\s*>/gi, "\n")
    .replace(/<\/li\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

// 헤딩 마커 타입별 — symbol(○●■…) / numeric(1./1)) / bracket([…])
type MarkerType = "symbol" | "numeric" | "bracket";

const SYMBOL_HEADING_RE = /^\s*[○●■◆▶◎◇▣☆★]\s*\S/;
const NUMERIC_HEADING_RE = /^\s*\d+[.)]\s+\S/;
const BRACKET_HEADING_RE = /^\s*[\[【［]\s*\S/;

function isHeadingLine(line: string, type: MarkerType): boolean {
  if (type === "symbol") return SYMBOL_HEADING_RE.test(line);
  if (type === "numeric") return NUMERIC_HEADING_RE.test(line);
  return BRACKET_HEADING_RE.test(line);
}

function matchHeading(
  line: string,
  heading: string,
): MarkerType | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`^\\s*[○●■◆▶◎◇▣☆★]\\s*${escaped}`, "i").test(line)) return "symbol";
  if (new RegExp(`^\\s*\\d+[.)]\\s*${escaped}`, "i").test(line)) return "numeric";
  if (new RegExp(`^\\s*[\\[【［]\\s*${escaped}\\s*[\\]】］]`, "i").test(line)) return "bracket";
  return null;
}

/**
 * 헤딩 행을 찾아 다음 동일 타입 헤딩 직전까지 본문 반환.
 * 한 공모전 본문은 보통 한 가지 마커 타입을 일관되게 씀 — 그래서
 * "■ 접수방법" 본문 안의 "1) ...", "2) ..."는 헤딩으로 보지 않는다.
 */
export function findSection(text: string, headings: string[]): string | null {
  const lines = text.split("\n");
  for (const heading of headings) {
    let start = -1;
    let markerType: MarkerType = "symbol";
    for (let i = 0; i < lines.length; i++) {
      const t = matchHeading(lines[i], heading);
      if (t) {
        start = i + 1;
        markerType = t;
        break;
      }
    }
    if (start === -1) continue;
    let end = lines.length;
    for (let i = start; i < lines.length; i++) {
      if (isHeadingLine(lines[i], markerType)) {
        end = i;
        break;
      }
    }
    const body = lines.slice(start, end).join("\n").trim();
    if (body) return body;
  }
  return null;
}

// 시간 단위 토큰: "5분", "30초", "1분 30초"
const DUR = String.raw`\d+\s*분(?:\s*\d+\s*초)?|\d+\s*초`;

const TIME_PATTERNS: { re: RegExp; format: (m: RegExpMatchArray) => string }[] = [
  // "최소 1분 ~ 최대 3분"
  {
    re: new RegExp(`최소\\s*(${DUR})\\s*[-~–]\\s*최대\\s*(${DUR})`),
    format: (m) => `${m[1].replace(/\s+/g, " ")} ~ ${m[2].replace(/\s+/g, " ")}`,
  },
  // "5 - 30초 이내" / "1분 ~ 3분"
  {
    re: new RegExp(`(${DUR})\\s*[-~–]\\s*(${DUR})(?:\\s*(?:이내|이하|미만|분량))?`),
    format: (m) => `${m[1].replace(/\s+/g, " ")} ~ ${m[2].replace(/\s+/g, " ")}`,
  },
  // "5 - 30초 이내" (단위 한 번만)
  {
    re: /(\d+\s*[-~–]\s*\d+\s*[분초](?:\s*(?:이내|이하|미만|분량))?)/,
    format: (m) => m[1].replace(/\s+/g, " "),
  },
  // "30초 이내" / "5분 이하"
  {
    re: new RegExp(`(${DUR})\\s*(?:이내|이하|미만)`),
    format: (m) => m[1].replace(/\s+/g, " "),
  },
  // 마지막 폴백: 시간 단위 토큰 하나만 (덜 정확)
  {
    re: new RegExp(`(?:재생\\s*시간|영상\\s*길이|영상\\s*분량|러닝\\s*타임|분량)\\s*:?\\s*(${DUR})`),
    format: (m) => m[1].replace(/\s+/g, " "),
  },
];

export function extractVideoLength(text: string): string | null {
  const focus =
    findSection(text, [
      "출품규격",
      "공모규격",
      "제출형식",
      "제출 형식",
      "영상규격",
      "영상 규격",
      "공모내용",
      "공모 내용",
      "분량",
      "제출 규격",
      "규격",
    ]) ?? text;
  for (const { re, format } of TIME_PATTERNS) {
    const m = focus.match(re);
    if (m) return format(m);
  }
  return null;
}

/**
 * 한국어 금액 표현을 원 단위 숫자로.
 * "3천만원", "500만원", "1억", "1억 5천만원" 등 지원.
 * 범위 "3천만원~1천만원"이면 첫번째(최대) 값만.
 */
export function parseKRW(s: string | null | undefined): number | null {
  if (!s) return null;
  const first = String(s).split(/[~∼〜]/)[0].trim();
  let total = 0;
  const taken: Array<[number, number]> = []; // [start, end] consumed ranges
  const overlaps = (a: number, b: number) => taken.some(([s, e]) => !(b <= s || a >= e));
  // 큰 단위부터 — overlap 처리로 "3천만"이 "만" 패턴에 다시 잡히지 않게
  const patterns: Array<[RegExp, number]> = [
    [/(\d+(?:\.\d+)?)\s*억/g, 100_000_000],
    [/(\d+(?:\.\d+)?)\s*천만/g, 10_000_000],
    [/(\d+(?:\.\d+)?)\s*백만/g, 1_000_000],
    [/(\d+(?:\.\d+)?)\s*십만/g, 100_000],
    [/(\d+(?:\.\d+)?)\s*만/g, 10_000],
    [/(\d+(?:\.\d+)?)\s*천(?!만)/g, 1_000],
  ];
  for (const [re, unit] of patterns) {
    const re2 = new RegExp(re.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re2.exec(first)) !== null) {
      if (overlaps(m.index, m.index + m[0].length)) continue;
      taken.push([m.index, m.index + m[0].length]);
      total += parseFloat(m[1]) * unit;
    }
  }
  return total > 0 ? total : null;
}

export function extractSubmitMethod(text: string, max = 600): string | null {
  const section = findSection(text, [
    "접수방법",
    "응모방법",
    "제출방법",
    "참여방법",
    "참가방법",
    "신청방법",
    "지원방법",
    "참가 방법",
    "참여 방법",
    "지원 방법",
    "신청 방법",
    "접수 방법",
    "응모 방법",
    "제출 방법",
  ]);
  if (!section) return null;
  const trimmed = section.trim();
  if (trimmed.length < 3) return null;
  return trimmed.length > max ? trimmed.slice(0, max - 1) + "…" : trimmed;
}

const PRIZE_HEADINGS = [
  "시상내역",
  "시상 내역",
  "시상안내",
  "시상 안내",
  "시상혜택",
  "시상 혜택",
  "공모전 시상혜택",
  "공모전 시상 혜택",
  "혜택 및 시상",
  "시상 및 혜택",
  "상금 및 시상",
  "시상규모",
  "시상 규모",
  "상금내역",
  "상금 내역",
  "수상내역",
  "수상 내역",
  "시상",
];

export function extractPrizeScale(text: string, max = 600): string | null {
  const section = findSection(text, PRIZE_HEADINGS);
  if (!section) return null;
  const trimmed = section.trim();
  if (trimmed.length < 3) return null; // "-" 같은 잡음 컷
  return trimmed.length > max ? trimmed.slice(0, max - 1) + "…" : trimmed;
}

// 1등 상금 라인을 식별하는 라벨
const TOP_PRIZE_LABEL = /(대상|1\s*등|1\s*위|최우수|그랑\s*프리|grand|gold|금상)/i;

/**
 * 시상내역 섹션에서 1등 상금 추출 (없으면 max).
 * "대상", "1등", "최우수상" 같은 라벨이 포함된 라인을 우선 — 그 안에 명시된 KRW.
 * "1등 애플워치"(상품)이면 못 잡지만, 시상이 작은 등급만 잡히는 오류는 막음.
 */
export function extractMaxPrizeFromBody(text: string): number | null {
  const section = findSection(text, PRIZE_HEADINGS);
  if (!section) return null;
  const lines = section.split("\n");

  // 1) 우선순위 라벨 라인의 max
  let topMax: number | null = null;
  for (const line of lines) {
    if (!TOP_PRIZE_LABEL.test(line)) continue;
    const val = parseKRW(line);
    if (val != null && (topMax === null || val > topMax)) topMax = val;
  }
  if (topMax != null) return topMax;

  // 2) 폴백: 전체 라인 max
  let anyMax: number | null = null;
  for (const line of lines) {
    const val = parseKRW(line);
    if (val != null && (anyMax === null || val > anyMax)) anyMax = val;
  }
  return anyMax;
}
