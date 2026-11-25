import { describe, it, expect } from "vitest";
import { pathLabelKey } from "@/lib/networkTransport";

describe("pathLabelKey", () => {
  it("furo de NAT tem rótulo próprio; o resto é conexão direta", () => {
    expect(pathLabelKey("punched")).toBe("net.path.punched");
    expect(pathLabelKey("direct-v4")).toBe("net.path.direct");
    expect(pathLabelKey("direct-v6")).toBe("net.path.direct");
    expect(pathLabelKey("qualquer-outra-coisa")).toBe("net.path.direct");
  });
});
