// src/services/supabaseService.ts
import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);

// Pricing configuration
export const PRICING = {
    FREE_DAILY_LIMIT: 5,
    PREMIUM_PRICE_STARS: 99,
    PREMIUM_DURATION_DAYS: 30,
} as const;

export type UserData = {
    telegram_id: string;
    username: string | null;
    first_name: string | null;
    is_premium: boolean;
    premium_until: string | null;
    daily_messages_used: number;
    last_message_date: string;
    total_messages: number;
    total_stars_spent: number;
    quit_date: string | null;
    cigarettes_per_day: number | null;
    pack_price: number | null;
    smoke_free_days: number;
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
    const { data: existing } = await supabase
        .from('antismoke_users')
        .select('*')
        .eq('telegram_id', telegramId)
        .single();

    if (existing) {
        return existing as UserData;
    }

    const { data: newUser, error } = await supabase
        .from('antismoke_users')
        .insert({
            telegram_id: telegramId,
            username: username || null,
            first_name: firstName || null,
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
 * Check if user has active premium subscription
 */
export function isPremiumActive(user: UserData): boolean {
    if (!user.is_premium || !user.premium_until) return false;
    return new Date(user.premium_until) > new Date();
}

/**
 * Get today's date string in YYYY-MM-DD format
 */
function getTodayString(): string {
    return new Date().toISOString().split('T')[0];
}

/**
 * Check if user can send message (has premium or daily limit not reached)
 */
export async function canSendMessage(telegramId: string): Promise<{
    canSend: boolean;
    isPremium: boolean;
    messagesUsedToday: number;
    dailyLimit: number;
}> {
    const user = await getOrCreateUser(telegramId);
    const today = getTodayString();

    // Reset daily counter if new day
    if (user.last_message_date !== today) {
        await supabase
            .from('antismoke_users')
            .update({
                daily_messages_used: 0,
                last_message_date: today,
            })
            .eq('telegram_id', telegramId);

        user.daily_messages_used = 0;
    }

    const isPremium = isPremiumActive(user);

    return {
        canSend: isPremium || user.daily_messages_used < PRICING.FREE_DAILY_LIMIT,
        isPremium,
        messagesUsedToday: user.daily_messages_used,
        dailyLimit: PRICING.FREE_DAILY_LIMIT,
    };
}

/**
 * Record message sent
 */
export async function recordMessage(telegramId: string): Promise<{
    messagesUsedToday: number;
    remainingToday: number;
    isPremium: boolean;
}> {
    const user = await getOrCreateUser(telegramId);
    const today = getTodayString();
    const isPremium = isPremiumActive(user);

    // Reset if new day
    const newDailyCount = user.last_message_date === today
        ? user.daily_messages_used + 1
        : 1;

    await supabase
        .from('antismoke_users')
        .update({
            daily_messages_used: newDailyCount,
            last_message_date: today,
            total_messages: user.total_messages + 1,
            updated_at: new Date().toISOString(),
        })
        .eq('telegram_id', telegramId);

    return {
        messagesUsedToday: newDailyCount,
        remainingToday: Math.max(0, PRICING.FREE_DAILY_LIMIT - newDailyCount),
        isPremium,
    };
}

/**
 * Activate premium subscription
 */
export async function activatePremium(
    telegramId: string,
    starsSpent: number
): Promise<{ premiumUntil: Date }> {
    const user = await getOrCreateUser(telegramId);

    // If already premium, extend from current end date
    const startDate = isPremiumActive(user) && user.premium_until
        ? new Date(user.premium_until)
        : new Date();

    const premiumUntil = new Date(startDate);
    premiumUntil.setDate(premiumUntil.getDate() + PRICING.PREMIUM_DURATION_DAYS);

    await supabase
        .from('antismoke_users')
        .update({
            is_premium: true,
            premium_until: premiumUntil.toISOString(),
            total_stars_spent: user.total_stars_spent + starsSpent,
            updated_at: new Date().toISOString(),
        })
        .eq('telegram_id', telegramId);

    return { premiumUntil };
}

/**
 * Update quit smoking data
 */
export async function setQuitDate(
    telegramId: string,
    quitDate: Date,
    cigarettesPerDay?: number,
    packPrice?: number
): Promise<void> {
    const updates: any = {
        quit_date: quitDate.toISOString().split('T')[0],
        updated_at: new Date().toISOString(),
    };

    if (cigarettesPerDay !== undefined) {
        updates.cigarettes_per_day = cigarettesPerDay;
    }
    if (packPrice !== undefined) {
        updates.pack_price = packPrice;
    }

    await supabase
        .from('antismoke_users')
        .update(updates)
        .eq('telegram_id', telegramId);
}

/**
 * Get user progress stats
 */
export async function getUserProgress(telegramId: string): Promise<{
    quitDate: Date | null;
    smokFreeDays: number;
    cigarettesAvoided: number;
    moneySaved: number;
} | null> {
    const user = await getOrCreateUser(telegramId);

    if (!user.quit_date) return null;

    const quitDate = new Date(user.quit_date);
    const today = new Date();
    const diffTime = today.getTime() - quitDate.getTime();
    const smokFreeDays = Math.max(0, Math.floor(diffTime / (1000 * 60 * 60 * 24)));

    const cigarettesPerDay = user.cigarettes_per_day || 20;
    const packPrice = user.pack_price || 200;
    const cigarettesPerPack = 20;

    const cigarettesAvoided = smokFreeDays * cigarettesPerDay;
    const packsAvoided = cigarettesAvoided / cigarettesPerPack;
    const moneySaved = packsAvoided * packPrice;

    return {
        quitDate,
        smokFreeDays,
        cigarettesAvoided,
        moneySaved: Math.round(moneySaved),
    };
}

/**
 * Get admin stats
 */
export async function getAdminStats(): Promise<{
    totalUsers: number;
    premiumUsers: number;
    totalMessages: number;
    totalStarsEarned: number;
}> {
    const { data, error } = await supabase
        .from('antismoke_users')
        .select('is_premium, premium_until, total_messages, total_stars_spent');

    if (error || !data) {
        return { totalUsers: 0, premiumUsers: 0, totalMessages: 0, totalStarsEarned: 0 };
    }

    const now = new Date();
    const premiumUsers = data.filter(u =>
        u.is_premium && u.premium_until && new Date(u.premium_until) > now
    ).length;

    return {
        totalUsers: data.length,
        premiumUsers,
        totalMessages: data.reduce((sum, u) => sum + (u.total_messages || 0), 0),
        totalStarsEarned: data.reduce((sum, u) => sum + (u.total_stars_spent || 0), 0),
    };
}
