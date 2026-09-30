import { describe, it, expect } from "vitest";
import { tutorialUrl } from "../help";

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
