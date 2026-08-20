import { describe, it, expect, vi } from "vitest";
import { ParcelCanonicalReadService } from "../parcel-canonical-read.js";

describe("ParcelCanonicalReadService", () => {
    it("переводить locationPublicId веба в локальний id локації бота", async () => {
        const client = {
            parcels: vi.fn().mockResolvedValue({
                schemaVersion: 1,
                generatedAt: "2026-08-20T10:00:00.000Z",
                parcels: [
                    {
                        ttn: "20450000000001",
                        status: "ARRIVED",
                        locationPublicId: "aaaaaaaa-1111-1111-1111-111111111111",
                        npAddress: "Відділення №5",
                        npCity: "Черкаси",
                        scheduledDate: null,
                        arrivedAt: "2026-08-20T10:00:00.000Z"
                    }
                ]
            })
        };
        const db = {
            location: {
                findMany: vi.fn().mockImplementation(({ where }) =>
                    Promise.resolve(
                        where.awsPublicId.in.map((awsPublicId: string) => ({
                            id: `local-${awsPublicId}`,
                            awsPublicId
                        }))
                    )
                )
            }
        };

        const service = new ParcelCanonicalReadService(client as never, db as never);
        const result = await service.findActive();

        expect(result).toHaveLength(1);
        expect(result[0]!.locationId).toBe("local-aaaaaaaa-1111-1111-1111-111111111111");
        expect(result[0]!.arrivedAt).toEqual(new Date("2026-08-20T10:00:00.000Z"));
    });

    it("залишає locationId порожнім, якщо локація веба не зіставлена з локацією бота", async () => {
        const client = {
            parcels: vi.fn().mockResolvedValue({
                schemaVersion: 1,
                generatedAt: "2026-08-20T10:00:00.000Z",
                parcels: [
                    {
                        ttn: "20450000000002",
                        status: "EXPECTED",
                        locationPublicId: "bbbbbbbb-2222-2222-2222-222222222222",
                        npAddress: null,
                        npCity: null,
                        scheduledDate: null,
                        arrivedAt: null
                    }
                ]
            })
        };
        const db = { location: { findMany: vi.fn().mockResolvedValue([]) } };

        const service = new ParcelCanonicalReadService(client as never, db as never);
        const result = await service.findActive();

        expect(result[0]!.locationId).toBeNull();
    });

    it("кидає ParcelCanonicalReadError з кодом при недоступності API", async () => {
        const client = { parcels: vi.fn().mockRejectedValue(new Error("network")) };
        const db = { location: { findMany: vi.fn() } };

        const service = new ParcelCanonicalReadService(client as never, db as never);

        await expect(service.findActive()).rejects.toMatchObject({
            reason: "CANONICAL_PARCELS_UNAVAILABLE"
        });
    });
});
