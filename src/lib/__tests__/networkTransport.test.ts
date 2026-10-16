import { describe, it, expect } from "vitest";
import { pathLabelKey } from "@/lib/networkTransport";

describe("pathLabelKey", () => {
  it("relay e furo de NAT têm rótulo próprio; o resto é conexão direta", () => {
    expect(pathLabelKey("relay")).toBe("net.path.relay");
    expect(pathLabelKey("punched")).toBe("net.path.punched");
    expect(pathLabelKey("direct-v4")).toBe("net.path.direct");
    expect(pathLabelKey("direct-v6")).toBe("net.path.direct");
    expect(pathLabelKey("qualquer-outra-coisa")).toBe("net.path.direct");
  });
});
