import { describe, expect, it } from "vitest";
import { guestRouteFromDiscovery, pathLabelKey } from "@/lib/networkTransport";

describe("guestRouteFromDiscovery", () => {
  it("host P2P: o convidado não precisa de IP, só pede o launcher link-v1", () => {
    expect(guestRouteFromDiscovery(true, { provider: "link-v1", hostIp: "" })).toEqual({ launcher: "link-v1", targetIp: null });
  });

  it("host antigo (Tailscale): usa o IP publicado e não pede launcher", () => {
    expect(guestRouteFromDiscovery(true, { provider: "tsnet-v1", hostIp: "100.64.0.9" })).toEqual({ launcher: null, targetIp: "100.64.0.9" });
    expect(guestRouteFromDiscovery(true, { hostIp: "100.64.0.9" })).toEqual({ launcher: null, targetIp: "100.64.0.9" });
  });

  it("sem servidor, ou modelo antigo sem IP publicado: não há rota", () => {
    expect(guestRouteFromDiscovery(false, { provider: "link-v1" })).toBeNull();
    expect(guestRouteFromDiscovery(true, { provider: "tsnet-v1", hostIp: "" })).toBeNull();
    expect(guestRouteFromDiscovery(true, null)).toBeNull();
  });
});

describe("pathLabelKey", () => {
  it("agrupa os caminhos em direto / furo de NAT / relay", () => {
    expect(pathLabelKey("direct-v4")).toBe("net.path.direct");
    expect(pathLabelKey("direct-v6")).toBe("net.path.direct");
    expect(pathLabelKey("punched")).toBe("net.path.punched");
    expect(pathLabelKey("relay")).toBe("net.path.relay");
  });
});
