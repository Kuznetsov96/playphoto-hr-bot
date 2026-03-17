import { PrismaClient } from '@prisma/client';
import * as dotenv from "dotenv";
import { cryptoUtility } from '../core/crypto.js';

dotenv.config();

const basePrisma = new PrismaClient();

const encryptFields: Record<string, string[]> = {
  Candidate: ['iban', 'passportNumber', 'ipn', 'bankCard', 'registrationAddress', 'passportPhotoIds'],
  ChatLog: ['text'],
  Message: ['content'],
  UserTimelineEvent: ['text', 'metadata'],
  Task: ['taskText'],
  SupportTicket: ['issueText']
};

const allSensitiveFields = Object.values(encryptFields).flat();

const prisma = basePrisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        
        // 1. Encrypt target fields on write
        if (model && encryptFields[model]) {
          const fieldsToEncrypt = encryptFields[model]!;
          const encryptData = (data: any) => {
            if (!data) return;
            if (Array.isArray(data)) {
              data.forEach(item => encryptData(item));
            } else {
              for (const field of fieldsToEncrypt) {
                if (data[field] !== undefined && data[field] !== null) {
                  if (typeof data[field] === 'object' && 'set' in data[field]) {
                    data[field].set = cryptoUtility.encrypt(data[field].set as string);
                  } else if (typeof data[field] === 'string') {
                    data[field] = cryptoUtility.encrypt(data[field]);
                  }
                }
              }
            }
          };

          if (['create', 'update', 'createMany', 'updateMany'].includes(operation)) {
            if ((args as any).data) encryptData((args as any).data);
          } else if (operation === 'upsert') {
            if ((args as any).create) encryptData((args as any).create);
            if ((args as any).update) encryptData((args as any).update);
          }
        }

        // 2. Execute the actual query
        const result = await query(args);

        // 3. Decrypt target fields on read (Recursively for all queries to handle nested includes)
        const decryptData = (data: any) => {
          if (!data || typeof data !== 'object') return;
          
          if (Array.isArray(data)) {
            data.forEach(item => decryptData(item));
          } else {
            for (const key in data) {
              // If it's one of our sensitive fields, decrypt it
              if (allSensitiveFields.includes(key) && typeof data[key] === 'string') {
                data[key] = cryptoUtility.decrypt(data[key]);
              } else if (typeof data[key] === 'object' && data[key] !== null && !(data[key] instanceof Date)) {
                decryptData(data[key]);
              }
            }
          }
        };

        decryptData(result);

        return result;
      }
    }
  }
});

// Cast to any then to PrismaClient to maintain 100% type compatibility with existing code
export default prisma as any as PrismaClient;

// Graceful shutdown
process.on('beforeExit', async () => {
    await basePrisma.$disconnect();
});
