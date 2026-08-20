import prisma from "../db/core.js";
import { awsBusinessClient } from "./aws-business-client.js";

const USER_VISIBLE_READ_TIMEOUT_MS = 3_000;

export type CanonicalParcel = {
    ttn: string;
    status: string;
    locationId: string | null;
    npAddress: string | null;
    npCity: string | null;
    scheduledDate: Date | null;
    arrivedAt: Date | null;
};

export class ParcelCanonicalReadError extends Error {
    readonly reason: "CANONICAL_PARCELS_UNAVAILABLE";

    constructor(reason: "CANONICAL_PARCELS_UNAVAILABLE") {
        super(reason);
        this.name = "ParcelCanonicalReadError";
        this.reason = reason;
    }
}

export class ParcelCanonicalReadService {
    constructor(
        private readonly client = awsBusinessClient,
        private readonly db = prisma,
    ) {}

    async findActive(): Promise<CanonicalParcel[]> {
        let response;
        try {
            response = await this.client.parcels({ timeoutMs: USER_VISIBLE_READ_TIMEOUT_MS });
        } catch {
            throw new ParcelCanonicalReadError("CANONICAL_PARCELS_UNAVAILABLE");
        }

        const publicIds = [
            ...new Set(
                response.parcels
                    .map(parcel => parcel.locationPublicId)
                    .filter((value): value is string => value !== null)
            )
        ];
        const locations =
            publicIds.length === 0
                ? []
                : await this.db.location.findMany({
                    where: { awsPublicId: { in: publicIds } },
                    select: { id: true, awsPublicId: true }
                });
        const byPublicId = new Map(
            locations.flatMap(location =>
                location.awsPublicId ? [[location.awsPublicId, location.id] as const] : []
            )
        );

        return response.parcels.map(parcel => ({
            ttn: parcel.ttn,
            status: parcel.status,
            locationId:
                parcel.locationPublicId === null ? null : (byPublicId.get(parcel.locationPublicId) ?? null),
            npAddress: parcel.npAddress,
            npCity: parcel.npCity,
            scheduledDate: parcel.scheduledDate === null ? null : new Date(parcel.scheduledDate),
            arrivedAt: parcel.arrivedAt === null ? null : new Date(parcel.arrivedAt)
        }));
    }
}

export const parcelCanonicalReadService = new ParcelCanonicalReadService();
