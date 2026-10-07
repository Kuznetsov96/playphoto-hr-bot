import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
    AWS_BUSINESS_API_URL: "https://api.example.test/api/v1/internal/bot/",
    AWS_BUSINESS_API_TOKEN: "a".repeat(32),
}));

const { AwsBusinessClient, AwsBusinessApiError, shootTaskSchema, SHOOT_TASK_FAILURE_REASONS } = await import(
    "../aws-business-client.js"
);

const task = {
    publicId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    ref: "abcdefgh2345",
    kind: "PHOTOS_DUE",
    telegramId: "1164289764",
    shoot: {
        clientName: "Олена",
        childName: null,
        phone: null,
        notes: null,
        location: { name: "Dragon Park 1", city: "Lviv", branch: null },
        shootOn: "2030-03-16",
        intervals: [{ start: "15:00", end: "16:00" }],
        durationMinutes: 60,
    },
    dueOn: "2030-03-19",
    canMoveDue: true,
    overdueDays: null,
    returnComment: null,
    pathB: false,
    targetMessageId: null,
};

const ok = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const problem = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/problem+json" } });

describe("AwsBusinessClient shoot tasks", () => {
    beforeEach(() => {
        vi.stubGlobal("fetch", vi.fn());
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("parses pending rows one by one and reports the broken ones", async () => {
        vi.mocked(fetch).mockResolvedValue(
            ok({
                items: [
                    task,
                    { ...task, publicId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", extra: 1 },
                    { ...task, publicId: "16fd2706-8baf-433b-82eb-8c7fada847da", kind: "SOMETHING_NEW" },
                    { nope: true },
                    { ...task, publicId: "not-a-uuid", extra: 1 },
                ],
            }),
        );
        const result = await new AwsBusinessClient().pendingShootTasks(50);
        expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(
            "https://api.example.test/api/v1/internal/bot/shoot-tasks/pending?limit=50",
        );
        expect(result.items).toHaveLength(1);
        expect(result.items[0]!.publicId).toBe(task.publicId);
        expect(result.invalidPublicIds).toEqual([
            "7c9e6679-7425-40de-944b-e07fc1f90ae7",
            "16fd2706-8baf-433b-82eb-8c7fada847da",
        ]);
        // Рядок без придатного publicId звітувати нікуди (failed приймає лише UUID) — лише лічильник.
        expect(result.unidentifiableCount).toBe(2);
    });

    it("rejects a malformed ref, a non-E.164 phone and unknown nested fields", () => {
        expect(shootTaskSchema.safeParse(task).success).toBe(true);
        expect(shootTaskSchema.safeParse({ ...task, kind: "ASSIGNED", shoot: { ...task.shoot, phone: "+380671234567" } }).success).toBe(true);
        expect(shootTaskSchema.safeParse({ ...task, ref: "ABC" }).success).toBe(false);
        expect(shootTaskSchema.safeParse({ ...task, shoot: { ...task.shoot, phone: "067 123" } }).success).toBe(false);
        expect(shootTaskSchema.safeParse({ ...task, shoot: { ...task.shoot, extra: 1 } }).success).toBe(false);
        expect(
            shootTaskSchema.safeParse({ ...task, shoot: { ...task.shoot, location: { ...task.shoot.location, extra: 1 } } })
                .success,
        ).toBe(false);
        expect(
            shootTaskSchema.safeParse({ ...task, shoot: { ...task.shoot, intervals: [{ start: "25:00", end: null }] } })
                .success,
        ).toBe(false);
    });

    it("exports the failure reasons the dispatcher and the webapp agree on", () => {
        expect(SHOOT_TASK_FAILURE_REASONS).toEqual({
            BLOCKED: "TG_403",
            MESSAGE_GONE: "TG_MESSAGE_GONE",
            NOT_MODIFIED: "TG_NOT_MODIFIED",
            PAYLOAD_INVALID: "SHOOT_TASK_PAYLOAD_INVALID",
        });
    });

    it("sends the message id with delivered and the reason with failed", async () => {
        vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ status: "SENT" }), { status: 201 }));
        const client = new AwsBusinessClient();
        await client.markShootTaskDelivered(task.publicId, 4242);
        await client.markShootTaskDelivered(task.publicId);
        await client.markShootTaskFailed(task.publicId, "TG_403");
        const calls = vi.mocked(fetch).mock.calls;
        expect(calls[0]![0]).toBe(
            `https://api.example.test/api/v1/internal/bot/shoot-tasks/${task.publicId}/delivered`,
        );
        expect(JSON.parse(String(calls[0]![1]!.body))).toEqual({ messageId: 4242 });
        expect(JSON.parse(String(calls[1]![1]!.body))).toEqual({});
        expect(calls[2]![0]).toBe(`https://api.example.test/api/v1/internal/bot/shoot-tasks/${task.publicId}/failed`);
        expect(JSON.parse(String(calls[2]![1]!.body))).toEqual({ reason: "TG_403" });
        expect(calls[2]![1]!.method).toBe("POST");
    });

    it("sends the telegram id in the body, not the URL", async () => {
        vi.mocked(fetch).mockResolvedValue(ok({ dueOn: "2030-03-21", item: task }));
        const result = await new AwsBusinessClient().moveShootTaskDue(task.ref, 1164289764, "2030-03-21");
        const [url, init] = vi.mocked(fetch).mock.calls[0]!;
        expect(url).toBe(`https://api.example.test/api/v1/internal/bot/shoot-tasks/by-ref/${task.ref}/due`);
        expect(String(url)).not.toContain("1164289764");
        expect(init!.method).toBe("POST");
        expect(JSON.parse(String(init!.body))).toEqual({ telegramId: "1164289764", dueOn: "2030-03-21" });
        expect(result).toEqual({ ok: true, dueOn: "2030-03-21", item: task });
    });

    it("returns due options as a typed success", async () => {
        vi.mocked(fetch).mockResolvedValue(
            ok({ currentDueOn: "2030-03-19", options: ["2030-03-20", "2030-03-21"], item: task }),
        );
        const result = await new AwsBusinessClient().shootTaskDueOptions(task.ref, 1164289764);
        const [url, init] = vi.mocked(fetch).mock.calls[0]!;
        expect(url).toBe(`https://api.example.test/api/v1/internal/bot/shoot-tasks/by-ref/${task.ref}/due-options`);
        expect(JSON.parse(String(init!.body))).toEqual({ telegramId: "1164289764" });
        expect(result).toEqual({
            ok: true,
            currentDueOn: "2030-03-19",
            options: ["2030-03-20", "2030-03-21"],
            item: task,
        });
    });

    it.each(["SHOOT_CANCELLED", "SHOOT_PHOTOS_RECEIVED", "SHOOT_DUE_ALREADY_MOVED", "SHOOT_DUE_OUT_OF_RANGE"])(
        "maps the 409 %s to a typed refusal for due-options and due",
        async (code) => {
            vi.mocked(fetch).mockImplementation(async () => problem(409, { code, message: "x" }));
            const client = new AwsBusinessClient();
            await expect(client.shootTaskDueOptions(task.ref, 1)).resolves.toEqual({ ok: false, code });
            await expect(client.moveShootTaskDue(task.ref, 1, "2030-03-21")).resolves.toEqual({ ok: false, code });
        },
    );

    it("maps the 404 SHOOT_TASK_NOT_FOUND to a typed refusal for every button", async () => {
        vi.mocked(fetch).mockImplementation(async () => problem(404, { code: "SHOOT_TASK_NOT_FOUND" }));
        const client = new AwsBusinessClient();
        const refused = { ok: false, code: "SHOOT_TASK_NOT_FOUND" };
        await expect(client.shootTaskDueOptions(task.ref, 1)).resolves.toEqual(refused);
        await expect(client.moveShootTaskDue(task.ref, 1, "2030-03-21")).resolves.toEqual(refused);
        await expect(client.shootTaskSupportLine(task.ref, 1)).resolves.toEqual(refused);
    });

    it("still throws for an unknown conflict code, a bare 404 and a server error", async () => {
        const client = new AwsBusinessClient();
        vi.mocked(fetch).mockResolvedValueOnce(problem(409, { code: "VERSION_CONFLICT" }));
        await expect(client.moveShootTaskDue(task.ref, 1, "2030-03-21")).rejects.toMatchObject({
            status: 409,
            code: "VERSION_CONFLICT",
        });
        vi.mocked(fetch).mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
        await expect(client.shootTaskDueOptions(task.ref, 1)).rejects.toBeInstanceOf(AwsBusinessApiError);
        vi.mocked(fetch).mockResolvedValueOnce(problem(500, { code: "INTERNAL" }));
        await expect(client.shootTaskSupportLine(task.ref, 1)).rejects.toMatchObject({ status: 500 });
    });

    it("returns the support line", async () => {
        vi.mocked(fetch).mockResolvedValue(ok({ line: "Зйомка · Олена · сб 16.03 15:00–16:00" }));
        const result = await new AwsBusinessClient().shootTaskSupportLine(task.ref, 1164289764);
        const [url, init] = vi.mocked(fetch).mock.calls[0]!;
        expect(url).toBe(`https://api.example.test/api/v1/internal/bot/shoot-tasks/by-ref/${task.ref}/support-line`);
        expect(JSON.parse(String(init!.body))).toEqual({ telegramId: "1164289764" });
        expect(result).toEqual({ ok: true, line: "Зйомка · Олена · сб 16.03 15:00–16:00" });
    });

    it("refuses a telegram id that is not a positive integer before calling the API", async () => {
        const client = new AwsBusinessClient();
        await expect(client.shootTaskDueOptions(task.ref, 0)).rejects.toThrow(RangeError);
        await expect(client.moveShootTaskDue(task.ref, 1.5, "2030-03-21")).rejects.toThrow(RangeError);
        await expect(client.shootTaskSupportLine(task.ref, Number.NaN)).rejects.toThrow(RangeError);
        expect(fetch).not.toHaveBeenCalled();
    });
});
