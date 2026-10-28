import { describe, expect, it } from "vitest";
import { resources } from "../client/messages";

type Tree = { readonly [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Record<string, string> {
  return Object.entries(tree).reduce<Record<string, string>>(
    (all, [key, value]) =>
      Object.assign(all, typeof value === "string" ? { [prefix + key]: value } : flatten(value, `${prefix}${key}.`)),
    {},
  );
}

const placeholders = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

describe("translations", () => {
  const en = flatten(resources.en);
  const vi = flatten(resources.vi);

  it("only translates keys that exist in English", () => {
    expect(Object.keys(vi).filter((key) => !(key in en))).toEqual([]);
  });

  it("keeps every placeholder of the English text", () => {
    const mismatched = Object.keys(vi).filter((key) => placeholders(vi[key]).join() !== placeholders(en[key]).join());
    expect(mismatched).toEqual([]);
  });
});
