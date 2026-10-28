import {
  openExternalUrl,
  type PluginButton,
  type PluginButtonMenuEntry,
} from "@getpaseo/plugin/client";
import { isUsable, type CredentialStatus, type MergeRequestStatus, type SessionLink } from "../shared/links";
import { credentialHeadline, credentialPopover } from "./credentials-view";
import type { Translate } from "./i18n";
import { pipelineText, summary } from "./status-text";
import { mergeConfirm, rebaseConfirm } from "./mr-actions";
import { hostOf, openableUrl } from "./urls";

function hasProblem(status: MergeRequestStatus | undefined): boolean {
  if (status?.state !== "opened") return false;
  return status.hasConflicts || status.pipeline?.status === "failed";
}

function stateIcon(status: MergeRequestStatus | undefined): string {
  if (hasProblem(status)) return "TriangleAlert";
  if (status?.state === "merged") return "GitMerge";
  if (status?.state === "closed") return "GitPullRequestClosed";
  if (status?.draft) return "GitPullRequestDraft";
  return "GitPullRequest";
}

function isGitHub(link: SessionLink): boolean {
  return hostOf(link.url) === "github.com";
}

/** The credential that reads and acts on this MR/PR: one GitHub token, one GitLab token per host. */
export function credentialIdOf(link: SessionLink): string {
  return isGitHub(link) ? "github:github.com" : `gitlab:${hostOf(link.url)}`;
}

function forgeName(link: SessionLink): string {
  return isGitHub(link) ? "GitHub" : "GitLab";
}

function mergeRequestEntries(agentId: string, link: SessionLink, canWrite: boolean, t: Translate): PluginButtonMenuEntry[] {
  const status = link.status;
  const linkUrl = openableUrl(link.url, link.url);
  const entries: PluginButtonMenuEntry[] = linkUrl
    ? [
        {
          kind: "item",
          id: "open",
          title: t("mr.open", { forge: forgeName(link) }),
          icon: "Globe",
          behavior: { kind: "action", onPress: () => openExternalUrl(linkUrl) },
        },
      ]
    : [];
  const pipelineUrl = status?.pipeline ? openableUrl(status.pipeline.url, link.url) : null;
  if (status?.pipeline && pipelineUrl) {
    entries.push({
      kind: "item",
      id: "pipeline",
      title: t("mr.pipeline", { status: pipelineText(status.pipeline.status, t) }),
      icon: "Workflow",
      behavior: { kind: "action", onPress: () => openExternalUrl(pipelineUrl) },
    });
  }
  if (status?.state !== "opened" || !canWrite) return entries;
  // Offer an action only when the forge itself says it applies, so the menu never invites a call
  // that the API would refuse.
  const canRebase = status.behind > 0 || status.mergeStatus === "need_rebase";
  const canMerge = status.mergeStatus === "mergeable";
  if (canRebase || canMerge) entries.push({ kind: "separator", id: "actions" });
  if (canRebase) {
    entries.push({
      kind: "item",
      id: "rebase",
      // GitHub's equivalent merges the base into the branch instead of rewriting it.
      title: isGitHub(link) ? t("mr.updateBranch") : t("mr.rebase"),
      icon: "GitBranch",
      behavior: { kind: "popover", Content: rebaseConfirm(agentId, link, status) },
    });
  }
  if (canMerge) {
    entries.push({
      kind: "item",
      id: "merge",
      title: t("mr.merge"),
      icon: "GitMerge",
      behavior: { kind: "popover", Content: mergeConfirm(agentId, link, status) },
    });
  }
  return entries;
}

/** The token status for each forge these MRs/PRs live on, in first-seen order. */
export function gitLabStatuses(mergeRequests: SessionLink[], credentials: CredentialStatus[]): CredentialStatus[] {
  const ids = [...new Set(mergeRequests.map(credentialIdOf))];
  return ids.flatMap((id) => credentials.filter((status) => status.id === id));
}

// The store keeps only the most recent MRs, oldest first; one menu lists them newest first.
export function mergeRequestsButton(
  agentId: string,
  mergeRequests: SessionLink[],
  credentials: CredentialStatus[],
  t: Translate,
): PluginButton {
  const tokens = gitLabStatuses(mergeRequests, credentials);
  const tokenFor = (link: SessionLink) => tokens.find((status) => status.id === credentialIdOf(link));
  const forges = new Set(mergeRequests.map(forgeName));
  const label =
    forges.size > 1 ? t("mr.buttonMixed") : forges.has("GitHub") ? t("mr.buttonGitHub") : t("mr.buttonGitLab");
  // Without a usable token there is no status to show, so say why at the top of the menu.
  const needsAttention = tokens.filter((status) => status.state !== "ok" || status.limits.length > 0);
  const warning: PluginButtonMenuEntry[] =
    needsAttention.length > 0
      ? [
          ...needsAttention.map((status, index) => ({
            kind: "item" as const,
            id: `token-warning-${index}`,
            title: `⚠ ${credentialHeadline(status, t)}`,
            icon: "KeyRound",
            behavior: { kind: "popover" as const, Content: credentialPopover(status) },
          })),
          { kind: "separator", id: "after-warning" },
        ]
      : [];
  const anyUnusable = tokens.some((status) => !isUsable(status));
  return {
    title: t("mr.title"),
    label,
    icon: anyUnusable || mergeRequests.some((link) => hasProblem(link.status)) ? "TriangleAlert" : "GitPullRequest",
    behavior: {
      kind: "menu",
      items: [
        ...warning,
        ...[...mergeRequests].reverse().map((link, index) => {
          const detail = summary(link.status, t);
          const token = tokenFor(link);
          return {
            kind: "item" as const,
            id: `mr-${index}`,
            title: detail ? t("mr.item", { label: link.label, detail }) : link.label,
            icon: stateIcon(link.status),
            behavior: {
              kind: "menu" as const,
              items: mergeRequestEntries(agentId, link, isUsable(token) && token?.limits.length === 0, t),
            },
          };
        }),
      ],
    },
  };
}

/** What a rebuilt MR pill depends on; `fetchedAt` alone changes every minute and is left out. */
export function mergeRequestsSignature(mergeRequests: SessionLink[], credentials: CredentialStatus[]): string {
  return JSON.stringify({
    tokens: gitLabStatuses(mergeRequests, credentials),
    mergeRequests: mergeRequests.map(({ status, ...link }) => ({
      ...link,
      status: status && { ...status, fetchedAt: "" },
    })),
  });
}
