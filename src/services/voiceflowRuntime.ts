import { env } from '../config/env';

type AnyObj = Record<string, any>;

export type VFButton = {
    title: string;
    payload: string;
};

export type VFResult = {
    text: string;          // может быть пустым, это нормально
    buttons: VFButton[];
};

function pickTextFromPayload(payload: any): string[] {
    const out: string[] = [];
    if (!payload) return out;

    // 1) самый частый кейс
    if (typeof payload.message === 'string' && payload.message.trim()) {
        out.push(payload.message.trim());
    }

    // 2) иногда бывает просто payload.text
    if (typeof payload.text === 'string' && payload.text.trim()) {
        out.push(payload.text.trim());
    }

    // 3) иногда Voiceflow отдаёт slate/blocks (структурированно)
    // Тут мы не делаем “красивый рендер”, но хотя бы достанем видимый текст
    // из типичных полей.
    const slate = payload.slate ?? payload.richText ?? payload.blocks;
    if (slate) {
        try {
            const str = JSON.stringify(slate);
            // очень грубо: вытащим куски "text":"..."
            const matches = [...str.matchAll(/"text"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
            for (const t of matches) {
                const cleaned = t.replace(/\\n/g, '\n').trim();
                if (cleaned) out.push(cleaned);
            }
        } catch {
            // ignore
        }
    }

    return out;
}

function pickButtonsFromChoicePayload(payload: any): VFButton[] {
    const buttons: VFButton[] = [];
    if (!payload) return buttons;

    const rawButtons =
        payload.buttons ??
        payload.choices ??
        payload.options;

    if (!Array.isArray(rawButtons)) return buttons;

    for (const b of rawButtons) {
        const title =
            String(b?.name ?? b?.label ?? b?.text ?? '').trim();

        if (!title) continue;

        const vfPayload =
            String(b?.request?.payload ?? b?.payload ?? title).trim();

        buttons.push({ title, payload: vfPayload });
    }

    return buttons;
}

export async function voiceflowInteract(params: {
    userId: string;
    text?: string;
    launch?: boolean;
}): Promise<VFResult> {
    const { userId, text, launch } = params;

    const action = launch
        ? { type: 'launch' as const }
        : { type: 'text' as const, payload: text ?? '' };

    const res = await fetch(
        `https://general-runtime.voiceflow.com/state/${env.VOICEFLOW_VERSION_ID}/user/${userId}/interact`,
        {
            method: 'POST',
            headers: {
                Authorization: env.VOICEFLOW_API_KEY,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ action }),
        }
    );

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(
            `Voiceflow runtime error: ${res.status} ${res.statusText} - ${errText}`
        );
    }

    const data = (await res.json()) as AnyObj[];

    const texts: string[] = [];
    const buttons: VFButton[] = [];

    for (const item of data) {
        // A) иногда текст лежит в item.text
        if (typeof item?.text === 'string' && item.text.trim()) {
            texts.push(item.text.trim());
        }

        // B) часто текст лежит в item.payload
        if (item?.payload) {
            texts.push(...pickTextFromPayload(item.payload));
            buttons.push(...pickButtonsFromChoicePayload(item.payload));
        }

        // C) иногда в item.messages[]
        const msgs = Array.isArray(item?.messages) ? item.messages : [];
        for (const msg of msgs) {
            if (msg?.payload) {
                texts.push(...pickTextFromPayload(msg.payload));
                buttons.push(...pickButtonsFromChoicePayload(msg.payload));
            }

            // некоторые типы могут быть без payload.message, но с msg.text
            if (typeof msg?.text === 'string' && msg.text.trim()) {
                texts.push(msg.text.trim());
            }
        }
    }

    const mergedText = texts
        .map((t) => t.trim())
        .filter(Boolean)
        .join('\n')
        .trim();

    // ВАЖНО: никаких "Ок 🙂" по умолчанию — пусть телеграм-слой решает, что делать
    return {
        text: mergedText,
        buttons,
    };
}
