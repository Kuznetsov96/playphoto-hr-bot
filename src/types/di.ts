import type prisma from '../db/core.js';
import type logger from '../core/logger.js';
import type { redis } from '../core/redis.js';

// Import Repository instances to use their types
import type { staffRepository } from '../repositories/staff-repository.js';
import type { userRepository } from '../repositories/user-repository.js';
import type { supportRepository } from '../repositories/support-repository.js';
import type { locationRepository } from '../repositories/location-repository.js';
import type { broadcastRepository } from '../repositories/broadcast-repository.js';
import type { taskRepository } from '../repositories/task-repository.js';
import type { candidateRepository } from '../repositories/candidate-repository.js';
import type { interviewRepository } from '../repositories/interview-repository.js';
import type { trainingRepository } from '../repositories/training-repository.js';

// Import Service instances
import type { supportService } from '../services/support-service.js';
import type { staffService } from '../modules/staff/services/index.js';
import type { candidateService } from '../modules/candidate/services/index.js';
import type { broadcastService } from '../services/broadcast.js';
import type { hrService } from '../services/hr-service.js';
import type { mentorService } from '../services/mentor-service.js';

export interface Cradle {
    db: typeof prisma;
    logger: typeof logger;
    redis: typeof redis;

    // Repositories
    staffRepository: typeof staffRepository;
    userRepository: typeof userRepository;
    supportRepository: typeof supportRepository;
    locationRepository: typeof locationRepository;
    broadcastRepository: typeof broadcastRepository;
    taskRepository: typeof taskRepository;
    candidateRepository: typeof candidateRepository;
    interviewRepository: typeof interviewRepository;
    trainingRepository: typeof trainingRepository;

    // Services
    supportService: typeof supportService;
    staffService: typeof staffService;
    candidateService: typeof candidateService;
    broadcastService: typeof broadcastService;
    hrService: typeof hrService;
    mentorService: typeof mentorService;
}
