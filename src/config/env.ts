import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
    NODE_ENV: z.string().optional().default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    VOICEFLOW_WEBHOOK_SECRET: z.string().min(8, 'VOICEFLOW_WEBHOOK_SECRET is required'),
    OPENAI_API_KEY: z.string().optional(),
});

export const env = EnvSchema.parse(process.env);
