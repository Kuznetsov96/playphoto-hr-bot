import { createContainer, asClass, asValue, asFunction, InjectionMode } from 'awilix';
import prisma from '../db/core.js';
import logger from './logger.js';
import { Bot } from 'grammy';
import { redis } from './redis.js';

// Import Repositories
import { staffRepository } from '../repositories/staff-repository.js';
import { userRepository } from '../repositories/user-repository.js';
import { supportRepository } from '../repositories/support-repository.js';
import { locationRepository } from '../repositories/location-repository.js';
import { broadcastRepository } from '../repositories/broadcast-repository.js';
import { taskRepository } from '../repositories/task-repository.js';
import { candidateRepository } from '../repositories/candidate-repository.js';
import { interviewRepository } from '../repositories/interview-repository.js';
import { trainingRepository } from '../repositories/training-repository.js';

// Import Services
import { supportService } from '../services/support-service.js';
import { staffService } from '../modules/staff/services/index.js';
import { candidateService } from '../modules/candidate/services/index.js';
import { broadcastService } from '../services/broadcast.js';
import { hrService } from '../services/hr-service.js';
import { mentorService } from '../services/mentor-service.js';
import type { Cradle } from '../types/di.js';

const container = createContainer<Cradle>({
    injectionMode: InjectionMode.PROXY
});

export function configureContainer() {
    container.register({
        db: asValue(prisma),
        logger: asValue(logger),
        redis: asValue(redis),

        // Repositories (currently objects, so asValue)
        // TODO: Refactor repositories to classes to use asClass
        staffRepository: asValue(staffRepository),
        userRepository: asValue(userRepository),
        supportRepository: asValue(supportRepository),
        locationRepository: asValue(locationRepository),
        broadcastRepository: asValue(broadcastRepository),
        taskRepository: asValue(taskRepository),
        candidateRepository: asValue(candidateRepository),
        interviewRepository: asValue(interviewRepository),
        trainingRepository: asValue(trainingRepository),

        // Services (currently objects, so asValue)
        // TODO: Refactor services to classes
        supportService: asValue(supportService),
        staffService: asValue(staffService),
        candidateService: asValue(candidateService),
        broadcastService: asValue(broadcastService),
        hrService: asValue(hrService),
        mentorService: asValue(mentorService)
    });

    return container;
}

export const di = container;
