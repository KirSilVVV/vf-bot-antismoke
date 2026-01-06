import Fastify from 'fastify';
import { env } from './config/env';

import { healthRoutes } from './routes/health';
import { voiceflowRoutes } from './routes/voiceflow';
import { telegramRoutes } from './routes/telegram';

async function bootstrap() {
    const app = Fastify({
        logger: {
            transport:
                env.NODE_ENV === 'development'
                    ? { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } }
                    : undefined,
        },
    });

    // Routes
    app.register(healthRoutes);
    app.register(voiceflowRoutes);
    app.register(telegramRoutes);

    // Render/Railway: нужно слушать 0.0.0.0 и PORT из env
    try {
        await app.listen({ port: env.PORT, host: '0.0.0.0' });
        app.log.info(`Server running on port ${env.PORT}`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}

bootstrap();
