import { useSettings, useTranslation, type PluginClientContext } from "@getpaseo/plugin/client";
import { useCallback } from "react";
import { preferences } from "../shared/links";
import { messages, resources, type MessageKey } from "./messages";

export type Language = "app" | "en" | "vi";
export type Values = Record<string, string | number>;
export type Translate = (key: MessageKey, values?: Values) => string;

function lookup(language: "en" | "vi", key: string): string | undefined {
  let node: unknown = resources[language];
  for (const part of key.split(".")) node = (node as Record<string, unknown> | undefined)?.[part];
  return typeof node === "string" ? node : undefined;
}

// Paseo's own languages do not include Vietnamese, so an explicit choice is resolved here with
// the same `{{name}}` syntax; English fills any key the chosen language lacks.
function translateExplicit(language: "en" | "vi", key: MessageKey, values: Values = {}): string {
  const template = lookup(language, key) ?? lookup("en", key) ?? key;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => String(values[name] ?? ""));
}

/** For code outside React: pill labels are rebuilt when the language changes. */
export function translator(client: PluginClientContext, language: Language): Translate {
  if (language !== "app") return (key, values) => translateExplicit(language, key, values);
  return (key, values) => (client.i18n.t as (m: typeof messages, k: string, v?: Values) => string)(messages, key, values);
}

/** For React components: follows both the plugin setting and Paseo's language. */
export function useTranslate(): Translate {
  const settings = useSettings(preferences);
  const { t } = useTranslation(messages);
  const language: Language = settings.status === "ready" ? settings.values.language : "app";
  return useCallback<Translate>(
    (key, values) =>
      language === "app"
        ? (t as (k: string, v?: Values) => string)(key, values)
        : translateExplicit(language, key, values),
    [language, t],
  );
}
