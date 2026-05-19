export type Source = "링커리어" | "위비티" | "캠퍼스픽" | "유토피아";
export type VideoForm = "쇼츠" | "일반" | "혼합" | "미상";
export type AIVideo = "AI" | "일반" | "미상";

export interface Contest {
  source: Source;
  externalId: string;
  url: string;
  title: string;
  host: string | null;
  closeAt: string | null;
  prizeKRW: number | null;
  prizeScale: string | null;
  eligibility: string | null;
  topic: string | null; // 본문에서 추출한 공모 주제 (예: "어린이 의약정보 홍보 콘텐츠")
  videoForm: VideoForm; // 영상 형태 — 쇼츠(≤60s)/일반/혼합/미상
  aiVideo: AIVideo;     // AI 영상 여부
  videoLength: string | null;
  submitMethod: string | null;
  postSelectionDuty: string | null;
  awardSamplesURL: string | null;
  status: "모집중" | "마감임박" | "마감";
  detailText: string | null;
  thumbnailURL: string | null;
}

export function deriveStatus(closeAt: string | null): "모집중" | "마감임박" | "마감" {
  if (!closeAt) return "모집중";
  const days = Math.ceil((Date.parse(closeAt) - Date.now()) / 86400000);
  if (days < 0) return "마감";
  if (days <= 7) return "마감임박";
  return "모집중";
}
