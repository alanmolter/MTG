import { describe, it, expect, vi, beforeEach } from "vitest";
import { importMoxfieldDecks } from "./moxfieldScraper";

// Mock fetch
global.fetch = vi.fn();

const { dbMock } = vi.hoisted(() => ({
    dbMock: {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnValue([]),
        insert: vi.fn().mockReturnThis(),
        values: vi.fn().mockReturnThis(),
        onConflictDoUpdate: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{ id: 1 }]),
    }
}));

vi.mock("../db", () => ({
    getDb: vi.fn().mockResolvedValue(dbMock),
}));

describe("importMoxfieldDecks", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMock.limit.mockReturnValue([]); 
    });

    it("should handle 403 by using fallback data", async () => {
        (global.fetch as any).mockResolvedValueOnce({
            ok: false,
            status: 403,
            headers: new Map(),
        });

        const result = await importMoxfieldDecks("modern", 2);

        expect(result.decksImported).toBe(2);
        expect(result.errors).toHaveLength(0);
    });

    it("should import real data if API is OK", async () => {
        const mockApiResponse = {
            data: [
                { publicId: "123", name: "Deck A" },
                { publicId: "456", name: "Deck B" },
            ]
        };

        const mockDeckDetail = {
           publicId: "123",
           name: "Detailed Deck",
           boards: { mainboard: { cards: { "bolt": { card: { name: "Lightning Bolt" }, quantity: 4 } } } }
        };

        (global.fetch as any)
            .mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockApiResponse),
            })
            .mockResolvedValue({
                ok: true,
                json: () => Promise.resolve(mockDeckDetail),
            });

        const result = await importMoxfieldDecks("modern", 2);

        expect(result.decksImported).toBe(2);
    });
});
