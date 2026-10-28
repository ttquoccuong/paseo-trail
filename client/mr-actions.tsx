import { useRpc, type PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useMutation } from "@tanstack/react-query";
import { useMemo, type ComponentType } from "react";
import { Pressable, Text, View } from "react-native";
import {
  mergeMergeRequestRpc,
  rebaseMergeRequestRpc,
  type MergeRequestStatus,
  type SessionLink,
} from "../shared/links";
import { useTranslate } from "./i18n";
import { hostOf } from "./urls";

type ConfirmProps = PluginButtonContentProps & {
  heading: string;
  lines: string[];
  warning?: string;
  confirmLabel: string;
  run(): Promise<string>;
};

function Confirm({ theme, close, heading, lines, warning, confirmLabel, run }: ConfirmProps) {
  const toast = useToast();
  const t = useTranslate();
  const action = useMutation({
    mutationFn: run,
    onSuccess: (message) => {
      toast.show(message, { variant: "success" });
      close();
    },
    onError: (error) => toast.error(String(error instanceof Error ? error.message : error)),
  });
  const styles = useMemo(
    () => ({
      container: { gap: 8, maxWidth: 380 },
      heading: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
      line: { color: theme.colors.foregroundMuted, fontSize: 12 },
      warning: { color: theme.colors.statusWarning, fontSize: 12 },
      button: {
        marginTop: 4,
        paddingVertical: 8,
        borderRadius: 6,
        alignItems: "center" as const,
        backgroundColor: theme.colors.accent,
        opacity: action.isPending ? 0.6 : 1,
      },
      buttonText: { color: theme.colors.accentForeground, fontSize: 13, fontWeight: "600" as const },
    }),
    [theme, action.isPending],
  );
  return (
    <View style={styles.container}>
      <Text style={styles.heading}>{heading}</Text>
      {lines.map((line) => (
        <Text key={line} style={styles.line}>
          {line}
        </Text>
      ))}
      {warning ? <Text style={styles.warning}>{warning}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={confirmLabel}
        disabled={action.isPending}
        style={styles.button}
        onPress={() => action.mutate()}
      >
        <Text style={styles.buttonText}>{action.isPending ? t("confirm.running") : confirmLabel}</Text>
      </Pressable>
    </View>
  );
}

/**
 * What a confirmation names: the request's real project and number, and for GitLab its host,
 * taken from the URL rather than from any label, so a pinned link cannot pass for another one.
 */
function identity(link: SessionLink): string {
  const host = hostOf(link.url);
  return host === "github.com" ? link.title : `${host} ${link.title}`;
}

// Rebase and Update branch both push to the source branch, and many projects drop approvals on push.
export function rebaseConfirm(agentId: string, link: SessionLink, status: MergeRequestStatus) {
  const isGitHub = hostOf(link.url) === "github.com";
  const RebaseConfirm: ComponentType<PluginButtonContentProps> = (props) => {
    const rebase = useRpc(rebaseMergeRequestRpc);
    const t = useTranslate();
    return (
      <Confirm
        {...props}
        heading={t(isGitHub ? "confirm.updateHeading" : "confirm.rebaseHeading", { label: identity(link) })}
        lines={[
          t("confirm.behindLine", { source: status.sourceBranch, target: status.targetBranch, count: status.behind }),
          t(isGitHub ? "confirm.updateHow" : "confirm.rebaseHow"),
        ]}
        warning={status.approved ? t("confirm.approvalWarning", { who: status.approvedBy.join(", ") }) : undefined}
        confirmLabel={t(isGitHub ? "confirm.updateButton" : "confirm.rebaseButton")}
        run={async () => {
          await rebase({ agentId, url: link.url });
          return t(isGitHub ? "confirm.updateDone" : "confirm.rebaseDone", { label: identity(link) });
        }}
      />
    );
  };
  return RebaseConfirm;
}

export function mergeConfirm(agentId: string, link: SessionLink, status: MergeRequestStatus) {
  const MergeConfirm: ComponentType<PluginButtonContentProps> = (props) => {
    const merge = useRpc(mergeMergeRequestRpc);
    const t = useTranslate();
    const yesNo = (value: boolean) => t(value ? "confirm.yes" : "confirm.no");
    return (
      <Confirm
        {...props}
        heading={t("confirm.mergeHeading", { label: identity(link), target: status.targetBranch })}
        lines={[
          t("confirm.mergeBranches", {
            source: status.sourceBranch,
            target: status.targetBranch,
            sha: status.sha.slice(0, 8),
          }),
          t("confirm.mergeOptions", { squash: yesNo(status.squash), remove: yesNo(status.removeSourceBranch) }),
          t("confirm.approvedBy", { who: status.approvedBy.join(", ") || t("confirm.nobody") }),
        ]}
        warning={t("confirm.mergeWarning")}
        confirmLabel={t("confirm.mergeButton")}
        run={async () => {
          const result = await merge({
            agentId,
            url: link.url,
            sha: status.sha,
            squash: status.squash,
            removeSourceBranch: status.removeSourceBranch,
          });
          return t("confirm.mergeDone", { label: identity(link), state: result.state });
        }}
      />
    );
  };
  return MergeConfirm;
}
