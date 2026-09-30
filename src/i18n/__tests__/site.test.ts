import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { checkSite, buildSite } from "../../../scripts/site-i18n.mjs";

describe("i18n do site (docs/)", () => {
  it("todo texto das páginas e todo i18n.t() está no dicionário", () => {
    expect(checkSite()).toEqual([]);
  });

  it("as páginas /en/ versionadas estão em dia com o dicionário (rode `npm run site:i18n`)", () => {
    const root = path.resolve(__dirname, "../../..");
    // Normaliza CRLF -> LF: em checkouts Windows com core.autocrlf=true o arquivo
    // no disco tem \r\n, mas buildSite() sempre escreve \n puro — sem isso, o teste
    // falha por causa da quebra de linha mesmo quando o conteúdo está idêntico.
    const readNormalized = (f: string) => fs.readFileSync(path.join(root, f), "utf8").replace(/\r\n/g, "\n");
    const before = ["docs/en/index.html", "docs/en/download/index.html"].map(readNormalized);
    buildSite();
    const after = ["docs/en/index.html", "docs/en/download/index.html"].map(readNormalized);
    expect(after).toEqual(before);
  });
});
