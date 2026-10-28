import type { MergeRequestStatus } from "../shared/links";
import type { Translate } from "./i18n";
import type { MessageKey } from "./messages";

const PIPELINE_KEY: Record<string, MessageKey> = {
  success: "mr.ciSuccess",
  failed: "mr.ciFailed",
  running: "mr.ciRunning",
  pending: "mr.ciPending",
  created: "mr.ciPending",
  canceled: "mr.ciCanceled",
  skipped: "mr.ciSkipped",
  manual: "mr.ciManual",
};

export function pipelineText(status: string, t: Translate): string {
  const key = PIPELINE_KEY[status];
  return key ? t(key) : t("mr.ciOther", { status });
}

export function summary(status: MergeRequestStatus | undefined, t: Translate): string {
  if (!status) return "";
  if (status.state === "merged") return t("mr.merged");
  if (status.state === "closed") return t("mr.closed");
  const parts = [
    status.draft ? t("mr.draft") : undefined,
    status.pipeline ? pipelineText(status.pipeline.status, t) : undefined,
    status.hasConflicts ? t("mr.conflict") : undefined,
    status.behind > 0 ? t("mr.behind", { count: status.behind }) : undefined,
    status.approved ? t("mr.approved") : t("mr.awaitingApproval"),
    status.mergeStatus === "mergeable" ? t("mr.mergeable") : undefined,
  ];
  return parts.filter(Boolean).join(" · ");
}
