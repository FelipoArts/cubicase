import { describe, expect, it } from "vitest";
import { generateShortCode, SHORT_CODE_ALPHABET } from "@/lib/shortCode";

describe("generateShortCode", () => {
  it("gera 6 caracteres do alfabeto sem ambíguos, compatível com o Worker ([A-Z0-9]{4,12})", () => {
    for (let i = 0; i < 500; i++) {
      const c = generateShortCode();
      expect(c).toMatch(/^[A-Z0-9]{6}$/);
      expect([...c].every((ch) => SHORT_CODE_ALPHABET.includes(ch))).toBe(true);
      expect(c).not.toMatch(/[01OI]/);
    }
  });

  it("não repete (entropia real: 32^6 combinações)", () => {
    const seen = new Set(Array.from({ length: 2000 }, () => generateShortCode()));
    expect(seen.size).toBe(2000);
  });
});
