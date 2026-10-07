import { describe, it, expect } from "vitest";
import { tutorialUrl, legalUrl } from "../help";

describe("tutorialUrl", () => {
  it("português usa /tutorial/ e inglês usa /en/tutorial/", () => {
    expect(tutorialUrl("pt-BR")).toBe("https://cubicase.net/tutorial/");
    expect(tutorialUrl("en")).toBe("https://cubicase.net/en/tutorial/");
    expect(tutorialUrl("en-US")).toBe("https://cubicase.net/en/tutorial/");
  });

  it("acrescenta o artigo como âncora", () => {
    expect(tutorialUrl("pt-BR", "faq")).toBe("https://cubicase.net/tutorial/#faq");
    expect(tutorialUrl("en", "criar-servidor")).toBe("https://cubicase.net/en/tutorial/#criar-servidor");
  });
});

describe("legalUrl", () => {
  it("aponta para as páginas legais no idioma da interface", () => {
    expect(legalUrl("pt-BR", "privacy")).toBe("https://cubicase.net/privacidade/");
    expect(legalUrl("pt-BR", "terms")).toBe("https://cubicase.net/termos/");
    expect(legalUrl("pt-BR", "licenses")).toBe("https://cubicase.net/licencas/");
    expect(legalUrl("en", "privacy")).toBe("https://cubicase.net/en/privacy/");
    expect(legalUrl("en-US", "terms")).toBe("https://cubicase.net/en/terms/");
    expect(legalUrl("en", "licenses")).toBe("https://cubicase.net/en/licenses/");
  });
});
