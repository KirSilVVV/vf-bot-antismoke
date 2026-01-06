import Fastify from 'fastify';
import { env } from './config/env';
import { healthRoutes } from './routes/health';
import { voiceflowRoutes } from './routes/voiceflow';
import { telegramRoutes } from './routes/telegram';

async function bootstrap() {
    const app = Fastify({
        logger: true, // ← ВАЖНО: просто true
    });

    app.register(healthRoutes);
    app.register(voiceflowRoutes);
    app.register(telegramRoutes);

    try {
        await app.listen({
            port: env.PORT,
            host: '0.0.0.0',
        });

        app.log.info(`Server running on port ${env.PORT}`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}

bootstrap();

