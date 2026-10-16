import { describe, expect, it } from "vitest";
import { CardNameResolver, fixMojibake, unaccent } from "./cardNameResolver";

const catalog = [
  { name: "Lórien Revealed", oracleId: "11111111-1111-1111-1111-111111111111" },
  { name: "Troll of Khazad-dûm", oracleId: "22222222-2222-2222-2222-222222222222" },
  { name: "Jötun Grunt", oracleId: "33333333-3333-3333-3333-333333333333" },
  { name: "Fire // Ice", oracleId: "44444444-4444-4444-4444-444444444444" },
  { name: "Lightning Bolt", oracleId: null },
];

describe("card name resolution", () => {
  const r = new CardNameResolver(catalog);

  it("repairs UTF-8 read as Latin-1", () => {
    expect(fixMojibake("JÃ¶tun Grunt")).toBe("Jötun Grunt");
    expect(fixMojibake("Lightning Bolt")).toBe("Lightning Bolt");
  });

  it("strips accents", () => {
    expect(unaccent("Troll of Khazad-dûm")).toBe("Troll of Khazad-dum");
  });

  it("resolves the three names left unresolved in the real database", () => {
    expect(r.resolve("Lorien Revealed")).toMatchObject({ method: "unaccent", oracleId: catalog[0].oracleId, name: "Lórien Revealed" });
    expect(r.resolve("Troll of Khazad-dum")).toMatchObject({ method: "unaccent", oracleId: catalog[1].oracleId });
    expect(r.resolve("J´┐¢tun Grunt")).toMatchObject({ method: "wildcard", name: "Jötun Grunt" });
    expect(r.resolve("JÃ¶tun Grunt")).toMatchObject({ method: "mojibake", oracleId: catalog[2].oracleId });
  });

  it("matches exact names, faces and A/B split notation", () => {
    expect(r.resolve("lightning bolt")).toMatchObject({ method: "exact", oracleId: null });
    expect(r.resolve("Fire")?.name).toBe("Fire // Ice");
    expect(r.resolve("Fire/Ice")?.name).toBe("Fire // Ice");
  });

  it("returns null for unknown cards and keeps the input as canonical name", () => {
    expect(r.resolve("Totally Made Up")).toBeNull();
    expect(r.canonicalName("  Totally Made Up ")).toBe("Totally Made Up");
  });
});
