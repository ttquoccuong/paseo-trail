import {
  useRpc,
  useSettings,
  type PluginButtonContentProps,
  type PluginHostProps,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import {
  Loading,
  ScrollView,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ComponentType } from "react";
import { Text, View } from "react-native";
import {
  credentialStatusRpc,
  preferences,
  setTokenRpc,
  type CredentialSource,
  type CredentialStatus,
  type DisplayMode,
} from "../shared/links";
import { useTranslate, type Language, type Translate } from "./i18n";
import type { MessageKey } from "./messages";

const STATE_KEY: Record<CredentialStatus["state"], MessageKey> = {
  ok: "credential.stateOk",
  missing: "credential.stateMissing",
  invalid: "credential.stateInvalid",
  expiring: "credential.stateExpiring",
  unchecked: "credential.stateUnchecked",
};

const DETAIL_KEY: Record<CredentialStatus["detail"]["code"], MessageKey> = {
  ok: "credential.detailOk",
  okExpires: "credential.detailOkExpires",
  expiring: "credential.detailExpiring",
  unauthorized: "credential.detailUnauthorized",
  httpError: "credential.detailHttpError",
  unreachable: "credential.detailUnreachable",
  redirected: "credential.detailRedirected",
  malformed: "credential.detailMalformed",
  tooManyHosts: "credential.detailTooManyHosts",
  noScope: "credential.detailNoScope",
  missing: "credential.detailMissing",
};

export function credentialLabel(status: CredentialStatus, t: Translate): string {
  return status.kind === "github" ? t("credential.labelGitHub") : t("credential.labelGitLab", { host: status.host });
}

export function credentialHeadline(status: CredentialStatus, t: Translate): string {
  return `${credentialLabel(status, t)}: ${t(STATE_KEY[status.state])}`;
}

function describeSource(source: CredentialSource, t: Translate): string {
  if (source.type === "stored") return t("credential.sourceStored");
  if (source.type === "file") return t("credential.sourceFile", { key: source.key, path: source.path });
  if (source.type === "env") return t("credential.sourceEnv", { name: source.name });
  return t("credential.sourceCli", { command: source.command });
}

function fixText(status: CredentialStatus, t: Translate): string {
  if (status.kind === "github") return t("credential.fixGitHub");
  // Only a file the user configured is worth suggesting; otherwise Settings or the CLI.
  const file = status.checked.find((source) => source.type === "file");
  if (file?.type === "file") return t("credential.fixGitLabFile", { file: file.path, key: file.key, host: status.host });
  // glab is only asked about hosts in the personal config.
  return status.checked.some((source) => source.type === "cli")
    ? t("credential.fixGitLab", { host: status.host })
    : t("credential.fixGitLabUnlisted", { host: status.host });
}

function useStyles(theme: PluginHostProps["theme"]) {
  return useMemo(
    () => ({
      block: { gap: 4, paddingVertical: 6 },
      heading: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
      ok: { color: theme.colors.statusSuccess, fontSize: 13 },
      warn: { color: theme.colors.statusWarning, fontSize: 13 },
      text: { color: theme.colors.foreground, fontSize: 12 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
    }),
    [theme],
  );
}

function CredentialBlock({ status, theme }: { status: CredentialStatus; theme: PluginHostProps["theme"] }) {
  const styles = useStyles(theme);
  const t = useTranslate();
  const healthy = status.state === "ok" && status.limits.length === 0;
  return (
    <View style={styles.block}>
      <Text style={styles.heading}>{credentialLabel(status, t)}</Text>
      <Text style={healthy ? styles.ok : styles.warn}>
        {t(STATE_KEY[status.state])} · {t(DETAIL_KEY[status.detail.code], status.detail.values)}
      </Text>
      {status.origin?.kind === "project" || status.origin?.kind === "link" ? (
        <Text style={styles.warn}>
          {status.origin.kind === "project"
            ? t("credential.originProject", { file: status.origin.file ?? "" })
            : t("credential.originLink")}
        </Text>
      ) : null}
      {status.limits.map((limit) => (
        <Text key={limit} style={styles.warn}>
          {t(status.kind === "github" ? "credential.readOnlyGitHub" : "credential.readOnlyGitLab")}
        </Text>
      ))}
      {status.source ? (
        <Text style={styles.muted}>{t("credential.from", { source: describeSource(status.source, t) })}</Text>
      ) : null}
      <Text style={styles.muted}>
        {t("credential.usedFor", {
          features: t(status.kind === "github" ? "credential.featuresGitHub" : "credential.featuresGitLab"),
        })}
      </Text>
      {healthy ? null : (
        <>
          <Text style={styles.muted}>
            {t("credential.searched", { list: status.checked.map((source) => describeSource(source, t)).join(" → ") })}
          </Text>
          <Text style={styles.text}>{t("credential.fix", { fix: fixText(status, t) })}</Text>
        </>
      )}
    </View>
  );
}

/**
 * Paste a token for one credential. The daemon keeps it readable only by its own user and never
 * sends it back; the field starts empty even when a token is saved.
 */
function TokenEntry({ status }: { status: CredentialStatus }) {
  const t = useTranslate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const setToken = useRpc(setTokenRpc);
  const [draft, setDraft] = useState("");
  const save = useMutation({
    mutationFn: (token: string | null) => setToken({ id: status.id, token }),
    onSuccess: (_, token) => {
      setDraft("");
      toast.show(t(token === null ? "credential.tokenRemoved" : "credential.tokenSaved"), { variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["credentials"] });
    },
    onError: (error) => toast.error(String(error instanceof Error ? error.message : error)),
  });
  return (
    <SettingsCard>
      <SettingsInput
        label={t("credential.tokenLabel", { name: credentialLabel(status, t) })}
        hint={t("credential.tokenHint")}
        placeholder={t("credential.tokenPlaceholder")}
        secureTextEntry
        onChangeText={setDraft}
      />
      <SettingsAction
        label={t("credential.tokenSaveLabel")}
        actionLabel={t("credential.tokenSave")}
        disabled={draft.trim() === "" || save.isPending}
        onPress={() => save.mutate(draft.trim())}
      />
      {status.source?.type === "stored" ? (
        <SettingsAction
          label={t("credential.tokenRemoveLabel")}
          actionLabel={t("credential.tokenRemove")}
          disabled={save.isPending}
          onPress={() => save.mutate(null)}
        />
      ) : null}
    </SettingsCard>
  );
}

/** Popover behind the warning row of a menu, for one credential. */
export function credentialPopover(status: CredentialStatus): ComponentType<PluginButtonContentProps> {
  const CredentialPopover: ComponentType<PluginButtonContentProps> = ({ theme }) => (
    <View style={{ maxWidth: 420 }}>
      <CredentialBlock status={status} theme={theme} />
    </View>
  );
  return CredentialPopover;
}

function PreferenceSettings() {
  const settings = useSettings(preferences);
  const t = useTranslate();
  if (settings.status !== "ready") return null;
  const modes: Array<{ label: string; value: DisplayMode }> = [
    { label: t("settings.modeTask"), value: "task" },
    { label: t("settings.modeAll"), value: "all" },
  ];
  const languages: Array<{ label: string; value: Language }> = [
    { label: t("settings.languageApp"), value: "app" },
    { label: "English", value: "en" },
    { label: "Tiếng Việt", value: "vi" },
  ];
  return (
    <SettingsSection title={t("settings.display")}>
      <SettingsCard>
        <SettingsSelect
          label={t("settings.defaultMode")}
          hint={t("settings.defaultModeHint")}
          value={settings.values.defaultMode}
          options={modes}
          onValueChange={(value) =>
            void settings.save({ ...settings.values, defaultMode: value as DisplayMode }, settings.revision)
          }
        />
        <SettingsSelect
          label={t("settings.language")}
          hint={t("settings.languageHint")}
          value={settings.values.language}
          options={languages}
          onValueChange={(value) =>
            void settings.save({ ...settings.values, language: value as Language }, settings.revision)
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}

/** Settings → Trail: preferences, then every credential, config file and resolved path. */
export function TrailSettings({ theme, layout }: PluginSurfaceProps) {
  const styles = useStyles(theme);
  const t = useTranslate();
  const getStatus = useRpc(credentialStatusRpc);
  const query = useQuery({ queryKey: ["credentials"], queryFn: () => getStatus({}) });
  if (query.isLoading) return <Loading />;
  if (!query.data) return <Text style={styles.warn}>{t("settings.statusError", { error: String(query.error) })}</Text>;
  const { credentials, environment, configs } = query.data;
  return (
    <ScrollView contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 12 }}>
      <PreferenceSettings />
      {credentials.length === 0 ? <Text style={styles.muted}>{t("settings.noCredentials")}</Text> : null}
      {credentials.map((status) => (
        <View key={status.id} style={{ gap: 8 }}>
          <CredentialBlock status={status} theme={theme} />
          <TokenEntry status={status} />
        </View>
      ))}
      <View style={styles.block}>
        <Text style={styles.heading}>{t("settings.configHeading")}</Text>
        {configs.loaded.length === 0 && configs.problems.length === 0 ? (
          <Text style={styles.muted}>{t("settings.noConfig", { file: configs.personalFile })}</Text>
        ) : null}
        {configs.loaded.map((file) => (
          <Text key={file} style={styles.muted} selectable>
            {file}
          </Text>
        ))}
        {configs.problems.map((problem) => (
          <Text key={problem.file} style={styles.warn} selectable>
            {problem.file}: {problem.error}
          </Text>
        ))}
      </View>
      <View style={styles.block}>
        <Text style={styles.heading}>{t("settings.paths")}</Text>
        <Text style={environment.pluginDir ? styles.muted : styles.warn} selectable>
          {environment.pluginDir
            ? t("settings.pluginDir", { path: environment.pluginDir })
            : t("settings.pluginDirMissing")}
        </Text>
        <Text style={styles.muted} selectable>
          {t("settings.state", { path: environment.stateDir })}
        </Text>
      </View>
    </ScrollView>
  );
}
