import Fastify from 'fastify';
import { env } from './config/env';
import { healthRoutes } from './routes/health';
import { voiceflowRoutes } from './routes/voiceflow';

async function main() {
    const app = Fastify({ logger: true });

    await app.register(healthRoutes);
    await app.register(voiceflowRoutes);

    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    app.log.info(`Server running on port ${env.PORT}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
