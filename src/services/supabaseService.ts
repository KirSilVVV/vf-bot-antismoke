// src/services/supabaseService.ts
import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);

// Pricing configuration
export const PRICING = {
    FREE_MESSAGES: 5,
    PACKAGES: [
        { id: 'start', messages: 10, stars: 25, label: '10 сообщений' },
        { id: 'optimum', messages: 50, stars: 100, label: '50 сообщений' },
        { id: 'maximum', messages: 200, stars: 350, label: '200 сообщений' },
    ],
} as const;

export type UserData = {
    telegram_id: string;
    username: string | null;
    first_name: string | null;
    messages_remaining: number;
    total_messages_bought: number;
    total_stars_spent: number;
    quit_date: string | null;
    cigarettes_per_day: number | null;
    pack_price: number | null;
    created_at: string;
    updated_at: string;
};

/**
 * Get or create user
 */
export async function getOrCreateUser(
    telegramId: string,
    username?: string,
    firstName?: string
): Promise<UserData> {
    // Try to get existing user
    const { data: existing } = await supabase
        .from('antismoke_users')
        .select('*')
        .eq('telegram_id', telegramId)
        .single();

    if (existing) {
        return existing as UserData;
    }

    // Create new user with free messages
    const { data: newUser, error } = await supabase
        .from('antismoke_users')
        .insert({
            telegram_id: telegramId,
            username: username || null,
            first_name: firstName || null,
            messages_remaining: PRICING.FREE_MESSAGES,
            total_messages_bought: 0,
            total_stars_spent: 0,
        })
        .select()
        .single();

    if (error) {
        console.error('[Supabase] Error creating user:', error);
        throw error;
    }

    return newUser as UserData;
}

/**
 * Check if user has messages remaining
 */
export async function hasMessagesRemaining(telegramId: string): Promise<boolean> {
    const user = await getOrCreateUser(telegramId);
    return user.messages_remaining > 0;
}

/**
 * Get remaining messages count
 */
export async function getMessagesRemaining(telegramId: string): Promise<number> {
    const user = await getOrCreateUser(telegramId);
    return user.messages_remaining;
}

/**
 * Consume one message credit
 */
export async function consumeMessage(telegramId: string): Promise<number> {
    const { data, error } = await supabase
        .from('antismoke_users')
        .update({
            messages_remaining: supabase.rpc('decrement_messages', { user_id: telegramId }),
            updated_at: new Date().toISOString(),
        })
        .eq('telegram_id', telegramId)
        .select('messages_remaining')
        .single();

    // Fallback: manual decrement
    if (error) {
        const user = await getOrCreateUser(telegramId);
        const newCount = Math.max(0, user.messages_remaining - 1);

        await supabase
            .from('antismoke_users')
            .update({
                messages_remaining: newCount,
                updated_at: new Date().toISOString(),
            })
            .eq('telegram_id', telegramId);

        return newCount;
    }

    return data?.messages_remaining ?? 0;
}

/**
 * Add messages after payment
 */
export async function addMessages(
    telegramId: string,
    messagesCount: number,
    starsSpent: number
): Promise<number> {
    const user = await getOrCreateUser(telegramId);
    const newMessagesRemaining = user.messages_remaining + messagesCount;

    const { error } = await supabase
        .from('antismoke_users')
        .update({
            messages_remaining: newMessagesRemaining,
            total_messages_bought: user.total_messages_bought + messagesCount,
            total_stars_spent: user.total_stars_spent + starsSpent,
            updated_at: new Date().toISOString(),
        })
        .eq('telegram_id', telegramId);

    if (error) {
        console.error('[Supabase] Error adding messages:', error);
        throw error;
    }

    return newMessagesRemaining;
}

/**
 * Update user's quit data
 */
export async function updateQuitData(
    telegramId: string,
    data: {
        quit_date?: string;
        cigarettes_per_day?: number;
        pack_price?: number;
    }
): Promise<void> {
    const { error } = await supabase
        .from('antismoke_users')
        .update({
            ...data,
            updated_at: new Date().toISOString(),
        })
        .eq('telegram_id', telegramId);

    if (error) {
        console.error('[Supabase] Error updating quit data:', error);
    }
}

/**
 * Get user stats for admin
 */
export async function getAdminStats(): Promise<{
    totalUsers: number;
    totalMessagesBought: number;
    totalStarsEarned: number;
}> {
    const { data, error } = await supabase
        .from('antismoke_users')
        .select('total_messages_bought, total_stars_spent');

    if (error || !data) {
        return { totalUsers: 0, totalMessagesBought: 0, totalStarsEarned: 0 };
    }

    return {
        totalUsers: data.length,
        totalMessagesBought: data.reduce((sum, u) => sum + (u.total_messages_bought || 0), 0),
        totalStarsEarned: data.reduce((sum, u) => sum + (u.total_stars_spent || 0), 0),
    };
}
