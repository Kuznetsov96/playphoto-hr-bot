import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StaffService } from '../../modules/staff/services/index.js';
import { staffRepository } from '../../repositories/staff-repository.js';
import { workShiftRepository } from '../../repositories/work-shift-repository.js';
import { locationRepository } from '../../repositories/location-repository.js';

// Mock repositories
vi.mock('../../repositories/staff-repository.js', () => ({
    staffRepository: {
        countActive: vi.fn(),
        findInactiveWithUser: vi.fn(),
        findByQuery: vi.fn()
    }
}));

vi.mock('../../repositories/work-shift-repository.js', () => ({
    workShiftRepository: {
        findWithLocationForStaff: vi.fn()
    }
}));

vi.mock('../../repositories/location-repository.js', () => ({
    locationRepository: {
        findById: vi.fn(),
        findAllActive: vi.fn(),
        findAll: vi.fn()
    }
}));

describe('StaffService', () => {
    let staffService: StaffService;

    beforeEach(() => {
        vi.clearAllMocks();
        staffService = new StaffService();
    });

    describe('shortenName', () => {
        it('should return the same name if it has 1 or 2 parts', () => {
            expect(staffService.shortenName('Ivan Ivanov')).toBe('Ivan Ivanov');
            expect(staffService.shortenName('Ivan')).toBe('Ivan');
        });

        it('should return only first two parts if it has 3 or more parts', () => {
            expect(staffService.shortenName('Ivanov Ivan Ivanovich')).toBe('Ivanov Ivan');
            expect(staffService.shortenName(' Ivanov  Ivan   Something ')).toBe('Ivanov Ivan');
        });
    });

    it('should return formatted header with counts', async () => {
        vi.mocked(staffRepository.countActive).mockResolvedValue(10);
        vi.mocked(locationRepository.findAll).mockResolvedValue([{ id: '1' }, { id: '2' }] as any);

        const t = (key: string, args?: any) => {
            if (key === 'admin-panel-team') return `Team: ${args.active} active`;
            if (key === 'admin-panel-locations') return `Locations: ${args.active} active`;
            if (key === 'admin-panel-title') return 'Admin Panel';
            return key;
        };

        const header = await staffService.getAdminHeader(null as any);
        expect(header).toContain('10 active');
        expect(header).toContain('2 active');
        expect(header).toContain('Admin Panel');
    });

    describe('getInactiveStaffReport', () => {
        it('should return "all active" message if no inactive staff', async () => {
            vi.mocked(staffRepository.findInactiveWithUser).mockResolvedValue([]);
            const report = await staffService.getInactiveStaffReport();
            expect(report).toBe('All staff members are active! ✨');
        });

        it('should return a list of shortened names of inactive staff', async () => {
            vi.mocked(staffRepository.findInactiveWithUser).mockResolvedValue([
                { fullName: 'Ivanov Ivan Ivanovich' },
                { fullName: 'Petrov Peter' }
            ] as any);

            const report = await staffService.getInactiveStaffReport();
            expect(report).toContain('⚠️ INACTIVE STAFF:');
            expect(report).toContain('• Ivanov Ivan');
            expect(report).toContain('• Petrov Peter');
        });
    });
});
