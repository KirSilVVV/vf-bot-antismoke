import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const EnvSchema = z.object({
    NODE_ENV: z.string().default('development'),
    PORT: z.coerce.number().default(3000),

    // Telegram
    TELEGRAM_BOT_TOKEN: z.string().min(1),

    // Voiceflow Runtime (сервер -> Voiceflow)
    VOICEFLOW_API_KEY: z.string().min(1),
    VOICEFLOW_VERSION_ID: z.string().optional(),

    // Voiceflow webhook secret (Voiceflow -> сервер) — опциональна для webhook режима
    VOICEFLOW_WEBHOOK_SECRET: z.string().optional().default(''),

    // Optional (если потом будешь звать OpenAI напрямую)
    OPENAI_API_KEY: z.string().optional(),
});

export const env = EnvSchema.parse(process.env);
export type Env = z.infer<typeof EnvSchema>;
