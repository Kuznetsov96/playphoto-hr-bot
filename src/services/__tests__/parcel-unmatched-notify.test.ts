import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessage = vi.fn();
const findUnique = vi.fn();
const create = vi.fn();
const findMany = vi.fn();

vi.mock("grammy", async (importOriginal) => {
    const actual = await importOriginal<typeof import("grammy")>();
    class Bot {
        api = { sendMessage: (...a: unknown[]) => sendMessage(...a) };
    }
    return { ...actual, Bot };
});
vi.mock("../../config.js", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    AWS_PARCELS_CANONICAL_READ_ENABLED: true,
    TEAM_CHATS: { SUPPORT: -100, LOGISTICS: 7 },
}));
vi.mock("../../db/core.js", () => ({
    default: {
        parcel: {
            findUnique: (...a: unknown[]) => findUnique(...a),
            create: (...a: unknown[]) => create(...a),
            findMany: (...a: unknown[]) => findMany(...a),
            update: vi.fn(),
            updateMany: vi.fn(),
        },
    },
}));
vi.mock("../nova-poshta-service.js", () => ({
    novaPoshtaService: { trackParcels: vi.fn().mockResolvedValue([{ Number: "20451549178727", StatusCode: "1" }]) },
}));
vi.mock("../parcel-canonical-read.js", () => ({
    parcelCanonicalReadService: {
        findActive: vi.fn().mockResolvedValue([{
            ttn: "20451549178727", status: "IN_TRANSIT", locationId: null,
            npAddress: "Відділення №5", npCity: "Київ", scheduledDate: null, arrivedAt: null,
            deliveryType: "Address",
        }]),
    },
}));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn() }));

const { logisticsService } = await import("../logistics-service.js");

beforeEach(() => {
    sendMessage.mockReset().mockResolvedValue({});
    findUnique.mockReset();
    create.mockReset().mockResolvedValue({ id: "p-new", status: "EXPECTED", deliveryType: "Warehouse" });
    findMany.mockReset().mockResolvedValue([]);
});

// notifyUnmatchedParcel не викликав ніхто: про посилку без точки підтримка не
// дізнавалась, і вона нікому не приходила.
describe("new parcel without a location", () => {
    it("tells support once, pointing to the web app", async () => {
        findUnique.mockResolvedValue(null);

        await logisticsService.syncActiveParcelsStatus();

        expect(sendMessage).toHaveBeenCalledOnce();
        const [chat, text, options] = sendMessage.mock.calls[0]!;
        expect(chat).toBe(-100);
        expect(text).toContain("Assign a location in the web app");
        expect(JSON.stringify(options)).not.toContain("admin_parcel_loc_");
    });

    it("stays silent for a parcel the bot already knows", async () => {
        findUnique.mockResolvedValue({ id: "p-old", status: "EXPECTED", deliveryType: "Warehouse", locationId: null });

        await logisticsService.syncActiveParcelsStatus();

        expect(sendMessage).not.toHaveBeenCalled();
    });
});

// Тип доставки знає вебапп: за npAddress бот записував кур'єрську як 'Warehouse'.
describe("new parcel row", () => {
    it("takes the delivery type from the web app, not from the presence of an NP address", async () => {
        findUnique.mockResolvedValue(null);

        await logisticsService.syncActiveParcelsStatus();

        expect(create.mock.calls[0]![0].data.deliveryType).toBe("Address");
    });
});
