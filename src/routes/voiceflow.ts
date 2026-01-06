import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env';

// Принимаем любой JSON от Voiceflow
const BodySchema = z.object({}).passthrough();

export async function voiceflowRoutes(app: FastifyInstance) {
    app.post('/api/voiceflow/webhook', async (req, reply) => {
        // 1) Проверка секрета
        const secret = req.headers['x-vf-secret'];

        if (secret !== env.VOICEFLOW_WEBHOOK_SECRET) {
            app.log.warn({ receivedSecret: secret }, 'Voiceflow webhook: invalid secret');
            return reply.code(401).send({ error: 'Unauthorized' });
        }

        // 2) Парсинг body
        const body = BodySchema.parse(req.body ?? {});

        app.log.info({ headers: req.headers, body }, 'Voiceflow webhook received');

        // 3) Тестовый ответ
        return reply.send({
            text: '✅ Связь с сервером установлена. Voiceflow → backend → Voiceflow работает.'
        });
    });
}
