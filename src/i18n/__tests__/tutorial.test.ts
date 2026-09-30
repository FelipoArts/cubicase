import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// O tutorial existe em duas páginas escritas à mão (docs/tutorial/ em português
// e docs/en/tutorial/ em inglês), com o mesmo conjunto de artigos. Este teste não
// compara o texto: só garante que as duas versões não divergem na estrutura e que
// a inglesa não deixou trechos em português para trás.

const root = path.resolve(__dirname, "../../..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8").replace(/\r\n/g, "\n");
const pt = read("docs/tutorial/index.html");
const en = read("docs/en/tutorial/index.html");

const articles = (html: string) => [...html.matchAll(/<article class="tut-article" id="([^"]+)" data-title="([^"]*)" data-group="([^"]*)"/g)].map((m) => ({ id: m[1], title: m[2], group: m[3] }));
const bodyText = (html: string) =>
  html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");

describe("tutorial (pt e en)", () => {
  it("têm os mesmos artigos, na mesma ordem", () => {
    expect(articles(en).map((a) => a.id)).toEqual(articles(pt).map((a) => a.id));
  });

  it("agrupam os artigos da mesma forma", () => {
    const shape = (html: string) => articles(html).map((a) => a.group);
    const groupsPt = shape(pt), groupsEn = shape(en);
    // Nomes diferem por idioma; o que precisa bater é onde cada grupo começa e termina.
    const boundaries = (g: string[]) => g.map((x, i) => (i === 0 || x !== g[i - 1] ? 1 : 0));
    expect(boundaries(groupsEn)).toEqual(boundaries(groupsPt));
  });

  it("todo link interno (#artigo) aponta para um artigo existente", () => {
    for (const html of [pt, en]) {
      const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
      const broken = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]).filter((id) => !ids.has(id));
      expect(broken).toEqual([]);
    }
  });

  it("têm a mesma quantidade de links, passos numerados e tabelas por artigo", () => {
    const count = (html: string, re: RegExp) => articles(html).map((a) => {
      const start = html.indexOf(`id="${a.id}"`);
      const next = html.indexOf('<article class="tut-article"', start + 1);
      return (html.slice(start, next === -1 ? undefined : next).match(re) ?? []).length;
    });
    for (const re of [/href="#/g, /class="tut-steps"/g, /<table\b/g, /class="tut-callout/g]) {
      expect(count(en, re)).toEqual(count(pt, re));
    }
  });

  it("a versão em inglês está marcada como inglês e aponta para a portuguesa", () => {
    expect(en).toContain('<html lang="en">');
    expect(en).toContain('hreflang="pt-BR" href="/tutorial/"');
    expect(pt).toContain('hreflang="en" href="/en/tutorial/"');
  });

  it("a versão em inglês não deixou texto em português (acentos)", () => {
    const leftovers = bodyText(en).match(/[^\s<>]*[áàâãéêíóôõúç][^\s<>]*/gi) ?? [];
    expect(leftovers).toEqual([]);
  });
});
