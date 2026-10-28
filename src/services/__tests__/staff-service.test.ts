import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StaffService } from '../../modules/staff/services/index.js';
import { staffRepository } from '../../repositories/staff-repository.js';
import { workShiftRepository } from '../../repositories/work-shift-repository.js';
import { locationRepository } from '../../repositories/location-repository.js';

// Mock repositories
vi.mock('../../repositories/staff-repository.js', () => ({
    staffRepository: {
        countActive: vi.fn(),
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
        findAll: vi.fn(),
        countOperating: vi.fn()
    }
}));

vi.mock('../../services/task-service.js', () => ({
    taskService: { countOverdueTasks: vi.fn() }
}));
import { taskService } from '../../services/task-service.js';

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

    describe('getAdminHeader', () => {
        it('owner and co-founder: title plus counts, no trailing prompt', async () => {
            vi.mocked(staffRepository.countActive).mockResolvedValue(53);
            vi.mocked(locationRepository.countOperating).mockResolvedValue(16);

            for (const role of ['SUPER_ADMIN', 'CO_FOUNDER']) {
                expect(await staffService.getAdminHeader(role)).toBe('<b>PlayPhoto</b>\n53 photographers · 16 locations');
            }
            // Вся таблиця — це і закриті точки, і старі ручні рядки без вебаппу:
            // власник бачив «20 active» замість реальної кількості (01.10.2026).
            expect(locationRepository.findAll).not.toHaveBeenCalled();
        });

        it('uses singular forms for one', async () => {
            vi.mocked(staffRepository.countActive).mockResolvedValue(1);
            vi.mocked(locationRepository.countOperating).mockResolvedValue(1);
            expect(await staffService.getAdminHeader('SUPER_ADMIN')).toBe('<b>PlayPhoto</b>\n1 photographer · 1 location');
        });

        it('support: overdue tasks, singular, plural and none', async () => {
            vi.mocked(taskService.countOverdueTasks).mockResolvedValueOnce(3);
            expect(await staffService.getAdminHeader('SUPPORT')).toBe('<b>PlayPhoto</b>\n3 overdue tasks');
            vi.mocked(taskService.countOverdueTasks).mockResolvedValueOnce(1);
            expect(await staffService.getAdminHeader('SUPPORT')).toBe('<b>PlayPhoto</b>\n1 overdue task');
            vi.mocked(taskService.countOverdueTasks).mockResolvedValueOnce(0);
            expect(await staffService.getAdminHeader('SUPPORT')).toBe('<b>PlayPhoto</b>\nNo overdue tasks');
        });

        it('reads both counts in parallel', async () => {
            const order: string[] = [];
            vi.mocked(staffRepository.countActive).mockImplementation(async () => { order.push('staff:start'); await Promise.resolve(); order.push('staff:end'); return 2; });
            vi.mocked(locationRepository.countOperating).mockImplementation(async () => { order.push('loc:start'); await Promise.resolve(); order.push('loc:end'); return 3; });
            await staffService.getAdminHeader('SUPER_ADMIN');
            expect(order.slice(0, 2)).toEqual(['staff:start', 'loc:start']);
        });

        it('falls back to the plain title when the counts cannot be read', async () => {
            vi.mocked(staffRepository.countActive).mockRejectedValue(new Error('db'));
            vi.mocked(locationRepository.countOperating).mockRejectedValue(new Error('db'));
            // Ошибка счётчика даёт ноль, а не падение: заголовок остаётся читаемым.
            expect(await staffService.getAdminHeader('SUPER_ADMIN')).toBe('<b>PlayPhoto</b>\n0 photographers · 0 locations');
        });
    });

});
