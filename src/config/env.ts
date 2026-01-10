import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const EnvSchema = z.object({
    NODE_ENV: z.string().default('development'),
    PORT: z.coerce.number().default(3000),

    // Telegram
    TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),

    // Voiceflow Runtime (сервер -> Voiceflow)
    VOICEFLOW_API_KEY: z.string().min(1, 'VOICEFLOW_API_KEY is required'),
    VOICEFLOW_VERSION_ID: z.string().optional(),

    // Voiceflow webhook secret (Voiceflow -> сервер) — опциональна для webhook режима
    VOICEFLOW_WEBHOOK_SECRET: z.string().optional().default(''),

    // Optional (если потом будешь звать OpenAI напрямую)
    OPENAI_API_KEY: z.string().optional(),
});

try {
    var env = EnvSchema.parse(process.env);
} catch (error) {
    if (error instanceof z.ZodError) {
        console.error('❌ Environment variables validation failed:');
        error.errors.forEach(err => {
            const path = err.path.join('.');
            console.error(`   - ${path}: ${err.message}`);
        });
        console.error('\n📝 Please set these variables in your .env file or Render dashboard');
        process.exit(1);
    }
    throw error;
}

export { env };
export type Env = z.infer<typeof EnvSchema>;
