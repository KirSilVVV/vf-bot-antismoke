import Fastify from 'fastify';
import { env } from './config/env';
import { healthRoutes } from './routes/health';
import { voiceflowRoutes } from './routes/voiceflow';
import { telegramRoutes } from './routes/telegram';

async function bootstrap() {
    const app = Fastify({
        logger: true, // безопасно для Render / production
    });

    /**
     * Root route — нужен для Render healthcheck
     */
    app.get('/', async () => {
        return {
            ok: true,
            service: 'vf-bot-antismoke',
            status: 'running',
        };
    });

    /**
     * HEAD / — чтобы Render не спамил 404
     */
    app.head('/', async (_req, reply) => {
        reply.code(200).send();
    });

    /**
     * API routes
     */
    app.register(healthRoutes);
    app.register(voiceflowRoutes);
    app.register(telegramRoutes);

    /**
     * Start server
     */
    try {
        const port = env.PORT;
        await app.listen({
            port,
            host: '0.0.0.0', // ОБЯЗАТЕЛЬНО для Render
        });

        app.log.info(`🚀 Server running on port ${port}`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}

bootstrap();

