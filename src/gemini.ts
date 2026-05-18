import { GoogleGenerativeAI, type GenerativeModel } from "@google/generative-ai";
import type { Contest } from "./types.js";

let modelCache: GenerativeModel | null = null;

function getModel(): GenerativeModel | null {
  if (modelCache) return modelCache;
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;
  const client = new GoogleGenerativeAI(apiKey);
  modelCache = client.getGenerativeModel({
    model: "gemini-2.0-flash",
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
    },
  });
  return modelCache;
}

export interface EnhanceResult {
  contest: Contest;
  isVideoContest: boolean;
  reasoning: string;
  usedLLM: boolean;
}

interface LLMResponse {
  is_video_contest: boolean;
  reasoning: string;
  video_length: string | null;
  prize_scale: string | null;
  submit_method: string | null;
  post_selection_duty: string | null;
}

const SYSTEM_PROMPT = `당신은 한국 공모전 데이터 정리 전문가입니다. 주어진 공모전 정보를 분석해서 JSON으로 응답하세요.

판단 기준:
- is_video_contest=true: 영상/UCC/쇼츠/숏폼/광고영상/뮤직비디오/다큐/단편영화 등 영상 출품 공모전
- is_video_contest=false: 사진(영상 X), 봉사단·홍보단·서포터즈·교육 프로그램 모집, 캐릭터/디자인/문학 등 영상 무관 공모전

각 필드는 본문에 명시된 경우만 채우고, 없으면 null:
- video_length: 출품 영상 길이 ("60초 이내", "3분 ~ 5분" 등)
- prize_scale: 시상 등급 요약 ("대상 1명 500만원/우수상 3명 100만원" 식, 200자 이내)
- submit_method: 제출 방법 1~2문장 요약 ("유튜브 업로드 후 신청 폼 작성")
- post_selection_duty: 선정 후 활동 의무 ("수상자 시상식 참석", "본선 진출팀 멘토링 5회" 등)

JSON만 응답:
{"is_video_contest": bool, "reasoning": "1문장", "video_length": str|null, "prize_scale": str|null, "submit_method": str|null, "post_selection_duty": str|null}`;

function buildPrompt(c: Contest): string {
  const body = (c.detailText ?? "").slice(0, 5000);
  return `[공모전 정보]
제목: ${c.title}
주최: ${c.host ?? "미상"}
분야: ${c.topic ?? "미상"}

[본문]
${body || "(본문 없음)"}`;
}

export async function enhance(c: Contest): Promise<EnhanceResult> {
  const model = getModel();
  if (!model) {
    // 키 없으면 LLM 스킵 — regex 결과 그대로 사용, 영상 여부는 통과 처리
    return { contest: c, isVideoContest: true, reasoning: "LLM 미사용", usedLLM: false };
  }

  try {
    const result = await model.generateContent({
      contents: [
        { role: "user", parts: [{ text: SYSTEM_PROMPT + "\n\n" + buildPrompt(c) }] },
      ],
    });
    const text = result.response.text();
    const parsed = JSON.parse(text) as LLMResponse;

    return {
      contest: {
        ...c,
        videoLength: c.videoLength ?? parsed.video_length,
        prizeScale: c.prizeScale ?? parsed.prize_scale,
        submitMethod: c.submitMethod ?? parsed.submit_method,
        postSelectionDuty: c.postSelectionDuty ?? parsed.post_selection_duty,
      },
      isVideoContest: parsed.is_video_contest,
      reasoning: parsed.reasoning,
      usedLLM: true,
    };
  } catch (e: any) {
    console.error(`  [gemini] ❌ ${e.message ?? e} — regex 결과 그대로 사용`);
    return { contest: c, isVideoContest: true, reasoning: "LLM 오류", usedLLM: false };
  }
}
