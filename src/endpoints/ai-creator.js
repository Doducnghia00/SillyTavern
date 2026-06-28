/**
 * AI Character Creator — generate SillyTavern character card fields from a user description.
 *
 * Reads the user's current AI connection settings (provider, model, API key)
 * and makes a direct LLM call to produce structured card data.
 *
 * Supports: OpenAI, OpenRouter, Custom (OpenAI-compatible), Claude, Gemini.
 */

import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';
import sanitize from 'sanitize-filename';

import { readSecret, SECRET_KEYS } from './secrets.js';
import { write as writeCharacterPng } from '../character-card-parser.js';
import { AVATAR_HEIGHT, AVATAR_WIDTH, DEFAULT_AVATAR_PATH } from '../constants.js';
import { Jimp, JimpMime } from '../jimp.js';
import { getUniqueName, humanizedDateTime, sanitizeSafeCharacterReplacements, tryParse } from '../util.js';

export const router = express.Router();

// ─── Constants ───────────────────────────────────────────────────────────────

const CHAT_COMPLETION_SOURCES = {
    OPENAI: 'openai',
    CLAUDE: 'claude',
    OPENROUTER: 'openrouter',
    CUSTOM: 'custom',
    MAKERSUITE: 'makersuite',
    VERTEXAI: 'vertexai',
    DEEPSEEK: 'deepseek',
    XAI: 'xai',
    GROQ: 'groq',
    MISTRALAI: 'mistralai',
    COHERE: 'cohere',
};

const PROVIDER_URLS = {
    [CHAT_COMPLETION_SOURCES.OPENAI]: 'https://api.openai.com/v1',
    [CHAT_COMPLETION_SOURCES.OPENROUTER]: 'https://openrouter.ai/api/v1',
    [CHAT_COMPLETION_SOURCES.DEEPSEEK]: 'https://api.deepseek.com/v1',
    [CHAT_COMPLETION_SOURCES.XAI]: 'https://api.x.ai/v1',
    [CHAT_COMPLETION_SOURCES.GROQ]: 'https://api.groq.com/openai/v1',
    [CHAT_COMPLETION_SOURCES.MISTRALAI]: 'https://api.mistral.ai/v1',
};

const SECRET_KEY_MAP = {
    [CHAT_COMPLETION_SOURCES.OPENAI]: SECRET_KEYS.OPENAI,
    [CHAT_COMPLETION_SOURCES.OPENROUTER]: SECRET_KEYS.OPENROUTER,
    [CHAT_COMPLETION_SOURCES.CUSTOM]: SECRET_KEYS.CUSTOM,
    [CHAT_COMPLETION_SOURCES.CLAUDE]: SECRET_KEYS.CLAUDE,
    [CHAT_COMPLETION_SOURCES.MAKERSUITE]: SECRET_KEYS.MAKERSUITE,
    [CHAT_COMPLETION_SOURCES.VERTEXAI]: SECRET_KEYS.VERTEXAI,
    [CHAT_COMPLETION_SOURCES.DEEPSEEK]: SECRET_KEYS.DEEPSEEK,
    [CHAT_COMPLETION_SOURCES.XAI]: SECRET_KEYS.XAI,
    [CHAT_COMPLETION_SOURCES.GROQ]: SECRET_KEYS.GROQ,
    [CHAT_COMPLETION_SOURCES.MISTRALAI]: SECRET_KEYS.MISTRALAI,
};

// ─── Default system prompt (exposed to frontend for editing) ─────────────────

export const DEFAULT_PROMPT_VERSION = 'rp-quality-v2';

export const DEFAULT_SYSTEM_PROMPT = `You are an expert SillyTavern character-card designer and roleplay writing partner. Given a user's seed description, generate a complete, high-quality SillyTavern character card as strict JSON.

A strong roleplay character is not a wiki biography. Build a playable behavioral brief:
Identity + Desire + Flaw + Secret/Tension + Relationship Hook + Active Scenario + Distinct Voice + Strong First Message + Sharp Dialogue Examples.

Return ONLY valid JSON with these exact fields (no markdown, no code fences):
{
  "name": "Character name",
  "character_spine": {
    "core_identity": "One concrete sentence: who {{char}} is right now, not a full biography.",
    "desire": "What {{char}} wants in the current roleplay and/or long-term.",
    "fear_or_wound": "The wound, fear, or pressure that shapes {{char}}'s behavior.",
    "flaw": "A real playable flaw that creates choices, tension, or growth.",
    "secret_or_tension": "A secret, contradiction, debt, danger, or unresolved problem that can surface through play.",
    "relationship_to_user": "Who {{user}} is to {{char}} at the start and why interaction matters.",
    "conflict_engine": "What keeps scenes moving instead of becoming static small talk.",
    "voice_profile": "How {{char}} speaks: rhythm, tone, favorite evasions, emotional tells, and style limits."
  },
  "description": "High-signal character profile for permanent context. 120-300 words unless the user asks for lore-heavy. Include only appearance/backstory details that affect behavior, current pressure, motivation, secret/tension, and interaction rules with {{user}}.",
  "personality": "Behavior-focused 3-5 sentences. Explain why/when/how {{char}} acts, not just adjective lists. Include how {{char}} reacts under pressure and when vulnerable.",
  "scenario": "An active starting situation: where {{char}} and {{user}} are, what just happened, what {{char}} needs/wants from {{user}}, and why the scene must move forward.",
  "first_mes": "Opening message in {{char}}'s voice. Use *action descriptions* and dialogue. Establish scene, tone, relationship dynamic, immediate hook, and a clear opening for {{user}} to respond. 120-250 words.",
  "mes_example": "2-4 example exchanges separated by <START>. Use {{user}}: and {{char}}:. Demonstrate normal voice, conflict/resistance, vulnerability, and one active decision when possible.",
  "creator_notes": "Short 1-2 sentence library note: hook, tone, and dynamic. No generic 'character-driven roleplay card' phrasing.",
  "system_prompt": "2-5 concise portrayal rules. Do not repeat the whole biography. Reinforce voice, agency, boundaries, and behavior that must stay consistent.",
  "post_history_instructions": "Brief continuity instruction: preserve motivation, relationship changes, secrets revealed, and consequences of choices.",
  "tags": ["4-8 normalized tags: genre", "tone", "dynamic", "role/archetype", "use-case"],
  "alternate_greetings": ["2-4 alternative openings with different moods, stakes, or relationship angles"],
  "character_version": "1.0.0"
}

Quality rules:
- Preserve every specific constraint the user gives. If details are missing, invent cohesive details that support the seed.
- Give {{char}} agency: they should want something and be able to act without waiting passively for {{user}}.
- Make flaws playable and concrete. Avoid perfect, overpowered, universally agreeable, or universe-centered characters.
- Make {{char}} interactable: even difficult characters need an approach vector for {{user}}.
- Scenario and first_mes must include an immediate reply hook, not just a static meeting.
- Example dialogue should teach speech rhythm, emotional logic, and how {{char}} responds to pressure.
- Keep permanent fields concise and high-signal. Avoid repeating identical facts across description, personality, scenario, and system_prompt.
- Tags should be practical for library filtering: genre, role, tone, dynamic, and use-case.
- All roleplay text should use {{char}} and {{user}} placeholders, never the user's real name.
- IMPORTANT: output must be valid JSON. Escape double quotes inside string values. Return ONLY the JSON object, nothing else`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readUserSettings(userDirectories) {
    try {
        const settingsPath = path.join(userDirectories.root, 'settings.json');
        const raw = fs.readFileSync(settingsPath, 'utf8');
        const settings = JSON.parse(raw);
        return settings?.oai_settings || {};
    } catch (err) {
        console.error('[AI Creator] Failed to read user settings:', err.message);
        return {};
    }
}

function getModelFieldForSource(source) {
    switch (source) {
        case CHAT_COMPLETION_SOURCES.OPENAI: return 'openai_model';
        case CHAT_COMPLETION_SOURCES.CLAUDE: return 'claude_model';
        case CHAT_COMPLETION_SOURCES.OPENROUTER: return 'openrouter_model';
        case CHAT_COMPLETION_SOURCES.CUSTOM: return 'custom_model';
        case CHAT_COMPLETION_SOURCES.MAKERSUITE:
        case CHAT_COMPLETION_SOURCES.VERTEXAI: return 'google_model';
        case CHAT_COMPLETION_SOURCES.DEEPSEEK: return 'deepseek_model';
        case CHAT_COMPLETION_SOURCES.XAI: return 'xai_model';
        case CHAT_COMPLETION_SOURCES.GROQ: return 'groq_model';
        case CHAT_COMPLETION_SOURCES.MISTRALAI: return 'mistralai_model';
        default: return 'custom_model';
    }
}

function getModelForSource(settings, source) {
    switch (source) {
        case CHAT_COMPLETION_SOURCES.OPENAI:
            return settings.openai_model || 'gpt-4o';
        case CHAT_COMPLETION_SOURCES.CLAUDE:
            return settings.claude_model || 'claude-sonnet-4-20250514';
        case CHAT_COMPLETION_SOURCES.OPENROUTER:
            return settings.openrouter_model || 'openai/gpt-4o';
        case CHAT_COMPLETION_SOURCES.CUSTOM:
            return settings.custom_model || 'gpt-4o';
        case CHAT_COMPLETION_SOURCES.MAKERSUITE:
        case CHAT_COMPLETION_SOURCES.VERTEXAI:
            return settings.google_model || 'gemini-2.0-flash';
        case CHAT_COMPLETION_SOURCES.DEEPSEEK:
            return settings.deepseek_model || 'deepseek-chat';
        case CHAT_COMPLETION_SOURCES.XAI:
            return settings.xai_model || 'grok-3';
        case CHAT_COMPLETION_SOURCES.GROQ:
            return settings.groq_model || 'llama-3.3-70b-versatile';
        case CHAT_COMPLETION_SOURCES.MISTRALAI:
            return settings.mistralai_model || 'mistral-large-latest';
        default:
            return settings.openai_model || settings.custom_model || 'gpt-4o';
    }
}

function readUserRootSettings(userDirectories) {
    try {
        const settingsPath = path.join(userDirectories.root, 'settings.json');
        return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (err) {
        console.error('[AI Creator] Failed to read root settings:', err.message);
        return {};
    }
}

function getConnectionManagerSettings(userDirectories) {
    const settings = readUserRootSettings(userDirectories);
    return settings?.extension_settings?.connectionManager || { selectedProfile: null, profiles: [] };
}

function getConnectionProfiles(userDirectories) {
    const manager = getConnectionManagerSettings(userDirectories);
    const profiles = Array.isArray(manager.profiles) ? manager.profiles : [];
    return {
        selectedProfileId: manager.selectedProfile || '',
        profiles: profiles
            .filter(profile => profile && profile.mode === 'cc' && profile.api)
            .map(profile => ({
                id: profile.id,
                name: profile.name || `${profile.api} ${profile.model || ''}`.trim() || profile.id,
                api: profile.api,
                model: profile.model || '',
                apiUrl: profile['api-url'] || '',
                secretId: profile['secret-id'] || '',
                mode: profile.mode,
                selected: profile.id === manager.selectedProfile,
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
    };
}

function findConnectionProfile(userDirectories, profileId) {
    if (!profileId) return null;
    const manager = getConnectionManagerSettings(userDirectories);
    const profiles = Array.isArray(manager.profiles) ? manager.profiles : [];
    return profiles.find(profile => profile.id === profileId) || profiles.find(profile => profile.name === profileId) || null;
}

function resolveConnection(userDirectories, profileId = null, overrideModel = null) {
    const settings = { ...readUserSettings(userDirectories) };
    const profile = findConnectionProfile(userDirectories, profileId);

    if (profile) {
        if (profile.mode && profile.mode !== 'cc') {
            throw new Error(`Connection profile "${profile.name || profile.id}" is not a Chat Completion profile.`);
        }
        if (profile.api) settings.chat_completion_source = profile.api;
        if (profile['api-url']) {
            if (profile.api === CHAT_COMPLETION_SOURCES.CUSTOM) settings.custom_url = profile['api-url'];
            else settings.profile_api_url = profile['api-url'];
        }
        if (profile.model) settings[getModelFieldForSource(profile.api)] = profile.model;
        if (profile['secret-id']) settings.profile_secret_id = profile['secret-id'];
    }

    const source = settings.chat_completion_source || CHAT_COMPLETION_SOURCES.OPENAI;
    const model = overrideModel || getModelForSource(settings, source);
    return { settings, source, model, profile };
}

function readProviderSecret(userDirectories, source, settings, explicitKey = null) {
    const secretKey = explicitKey || SECRET_KEY_MAP[source] || SECRET_KEYS.OPENAI;
    return readSecret(userDirectories, secretKey, settings.profile_secret_id || null);
}

/**
 * Core LLM call. Accepts optional profileId and overrideModel.
 */
async function callLLM(userDirectories, messages, { maxTokens = 4096, overrideModel = null, profileId = null, stream = true, temperature = 0.8, jsonMode = false } = {}) {
    const { settings, source, model, profile } = resolveConnection(userDirectories, profileId, overrideModel);

    console.log(`[AI Creator] Using provider=${source}, model=${model}, profile=${profile?.name || 'current'}, stream=${stream}`);

    // Streaming is implemented for OpenAI-compatible providers. Claude/Gemini currently use non-stream calls.
    if (source === CHAT_COMPLETION_SOURCES.CLAUDE) {
        return await callClaude(userDirectories, settings, model, messages, maxTokens, temperature);
    }
    if (source === CHAT_COMPLETION_SOURCES.MAKERSUITE || source === CHAT_COMPLETION_SOURCES.VERTEXAI) {
        return await callGemini(userDirectories, settings, source, model, messages, maxTokens, temperature);
    }
    return await callOpenAICompatible(userDirectories, settings, source, model, messages, maxTokens, stream, temperature, jsonMode);
}

// ─── OpenAI-compatible call ──────────────────────────────────────────────────

async function callOpenAICompatible(userDirectories, settings, source, model, messages, maxTokens, stream = true, temperature = 0.8, jsonMode = false) {
    let apiUrl;
    let apiKey;

    if (source === CHAT_COMPLETION_SOURCES.CUSTOM) {
        apiUrl = settings.custom_url;
        apiKey = readProviderSecret(userDirectories, source, settings, SECRET_KEYS.CUSTOM);
        if (!apiUrl) throw new Error('Custom API URL is not configured. Set it in AI Connection settings or the selected profile.');
    } else if (source === CHAT_COMPLETION_SOURCES.OPENROUTER) {
        apiUrl = PROVIDER_URLS[CHAT_COMPLETION_SOURCES.OPENROUTER];
        apiKey = readProviderSecret(userDirectories, source, settings, SECRET_KEYS.OPENROUTER);
    } else {
        apiUrl = PROVIDER_URLS[source] || PROVIDER_URLS[CHAT_COMPLETION_SOURCES.OPENAI];
        const secretKey = SECRET_KEY_MAP[source] || SECRET_KEYS.OPENAI;
        apiKey = readProviderSecret(userDirectories, source, settings, secretKey);
    }

    if (!apiKey) {
        throw new Error(`API key for ${source} is not configured. Add it in the API Keys / Secrets panel.`);
    }

    apiUrl = apiUrl.replace(/\/+$/, '');
    const endpointUrl = `${apiUrl}/chat/completions`;

    const requestBody = {
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream,
    };

    if (jsonMode) {
        requestBody.response_format = { type: 'json_object' };
    }

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
    };

    if (source === CHAT_COMPLETION_SOURCES.OPENROUTER) {
        headers['HTTP-Referer'] = 'https://sillytavern.ai';
        headers['X-Title'] = 'SillyTavern AI Creator';
    }

    console.debug(`[AI Creator] POST ${endpointUrl} (model=${model})`);

    const response = await fetch(endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(180_000),
    });

    if (!response.ok) {
        const errorText = await response.text();
        const errorData = tryParse(errorText);
        const message = errorData?.error?.message || response.statusText || 'Unknown error';
        throw new Error(`LLM API error (${response.status}): ${message}`);
    }

    if (stream) {
        const content = await readOpenAICompatibleStream(response);
        if (!content) throw new Error('LLM returned empty streaming response');
        return content;
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM returned empty response');
    return content;
}

async function readOpenAICompatibleStream(response) {
    let buffer = '';
    let result = '';

    for await (const chunk of response.body) {
        buffer += Buffer.from(chunk).toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || !line.startsWith('data:')) continue;

            const data = line.slice(5).trim();
            if (data === '[DONE]') return result;

            const parsed = tryParse(data);
            if (!parsed || parsed.error) {
                if (parsed?.error?.message) throw new Error(parsed.error.message);
                continue;
            }

            const delta = parsed?.choices?.[0]?.delta;
            const content = delta?.content || delta?.text || parsed?.choices?.[0]?.message?.content || '';
            result += content;
        }
    }

    return result;
}

// ─── Claude call ─────────────────────────────────────────────────────────────

async function callClaude(userDirectories, settings, model, messages, maxTokens, temperature = 0.8) {
    const apiKey = readProviderSecret(userDirectories, CHAT_COMPLETION_SOURCES.CLAUDE, settings, SECRET_KEYS.CLAUDE);
    if (!apiKey) throw new Error('Claude API key is not configured.');

    const apiUrl = settings.reverse_proxy || 'https://api.anthropic.com';
    const systemMsg = messages.find(m => m.role === 'system')?.content || '';
    const userMessages = messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role, content: m.content }));

    const response = await fetch(`${apiUrl}/v1/messages`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model, max_tokens: maxTokens, system: systemMsg, messages: userMessages, temperature }),
        signal: AbortSignal.timeout(180_000),
    });

    if (!response.ok) {
        const errorText = await response.text();
        const errorData = tryParse(errorText);
        const message = errorData?.error?.message || response.statusText;
        throw new Error(`Claude API error (${response.status}): ${message}`);
    }

    const data = await response.json();
    const content = data?.content?.[0]?.text;
    if (!content) throw new Error('Claude returned empty response');
    return content;
}

// ─── Gemini call ─────────────────────────────────────────────────────────────

async function callGemini(userDirectories, settings, source, model, messages, maxTokens, temperature = 0.8) {
    const secretKey = source === CHAT_COMPLETION_SOURCES.VERTEXAI ? SECRET_KEYS.VERTEXAI : SECRET_KEYS.MAKERSUITE;
    const apiKey = readProviderSecret(userDirectories, source, settings, secretKey);
    if (!apiKey) throw new Error('Gemini API key is not configured.');

    const systemMsg = messages.find(m => m.role === 'system')?.content || '';
    const userMessages = messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            systemInstruction: systemMsg ? { parts: [{ text: systemMsg }] } : undefined,
            contents: userMessages,
            generationConfig: { maxOutputTokens: maxTokens, temperature },
        }),
        signal: AbortSignal.timeout(180_000),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) throw new Error('Gemini returned empty response');
    return content;
}

// ─── Fetch available models from provider ────────────────────────────────────

async function fetchAvailableModels(userDirectories, profileId = null) {
    const { settings, source, profile } = resolveConnection(userDirectories, profileId);
    const currentModel = getModelForSource(settings, source);

    let apiUrl;
    let apiKey;
    const headers = {};

    if (source === CHAT_COMPLETION_SOURCES.CUSTOM) {
        apiUrl = settings.custom_url;
        apiKey = readProviderSecret(userDirectories, source, settings, SECRET_KEYS.CUSTOM);
    } else if (source === CHAT_COMPLETION_SOURCES.OPENROUTER) {
        apiUrl = PROVIDER_URLS[CHAT_COMPLETION_SOURCES.OPENROUTER];
        apiKey = readProviderSecret(userDirectories, source, settings, SECRET_KEYS.OPENROUTER);
    } else if (source === CHAT_COMPLETION_SOURCES.CLAUDE) {
        // Claude doesn't have a /models endpoint, return known models
        return {
            provider: source,
            profileId: profile?.id || '',
            profileName: profile?.name || '',
            hasApiKey: !!readProviderSecret(userDirectories, source, settings, SECRET_KEYS.CLAUDE),
            models: [
                'claude-opus-4-20250514',
                'claude-sonnet-4-20250514',
                'claude-haiku-4-20250414',
                'claude-3-5-sonnet-20241022',
                'claude-3-5-haiku-20241022',
            ],
            currentModel,
        };
    } else if (source === CHAT_COMPLETION_SOURCES.MAKERSUITE || source === CHAT_COMPLETION_SOURCES.VERTEXAI) {
        const secretKey = source === CHAT_COMPLETION_SOURCES.VERTEXAI ? SECRET_KEYS.VERTEXAI : SECRET_KEYS.MAKERSUITE;
        apiKey = readProviderSecret(userDirectories, source, settings, secretKey);
        if (!apiKey) return { provider: source, profileId: profile?.id || '', profileName: profile?.name || '', hasApiKey: false, models: [], currentModel: '' };
        try {
            const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
                signal: AbortSignal.timeout(10_000),
            });
            if (!resp.ok) throw new Error(String(resp.status));
            const data = await resp.json();
            const models = (data.models || [])
                .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
                .map(m => m.name.replace('models/', ''));
            return { provider: source, profileId: profile?.id || '', profileName: profile?.name || '', hasApiKey: true, models, currentModel };
        } catch {
            return { provider: source, profileId: profile?.id || '', profileName: profile?.name || '', hasApiKey: true, models: ['gemini-2.0-flash', 'gemini-2.5-pro', 'gemini-2.5-flash'], currentModel };
        }
    } else {
        apiUrl = settings.profile_api_url || PROVIDER_URLS[source] || PROVIDER_URLS[CHAT_COMPLETION_SOURCES.OPENAI];
        const secretKey = SECRET_KEY_MAP[source] || SECRET_KEYS.OPENAI;
        apiKey = readProviderSecret(userDirectories, source, settings, secretKey);
    }

    if (!apiUrl || !apiKey) {
        return { provider: source, profileId: profile?.id || '', profileName: profile?.name || '', hasApiKey: !!apiKey, models: [], currentModel };
    }

    apiUrl = apiUrl.replace(/\/+$/, '');
    headers['Authorization'] = `Bearer ${apiKey}`;

    try {
        const resp = await fetch(`${apiUrl}/models`, {
            headers,
            signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) throw new Error(String(resp.status));
        const data = await resp.json();
        let models = [];
        if (Array.isArray(data.data)) {
            models = data.data.map(m => m.id).filter(Boolean).sort();
        } else if (Array.isArray(data)) {
            models = data.map(m => m.id || m.name).filter(Boolean).sort();
        }
        return { provider: source, profileId: profile?.id || '', profileName: profile?.name || '', hasApiKey: true, models, currentModel };
    } catch (err) {
        console.warn(`[AI Creator] Could not fetch models from ${source} (${profile?.name || 'current'}): ${err.message}`);
        return { provider: source, profileId: profile?.id || '', profileName: profile?.name || '', hasApiKey: true, models: [], currentModel };
    }
}

// ─── Parse LLM response into card fields ────────────────────────────────────

function parseCardResponse(rawText) {
    const parsed = extractJsonObject(rawText);
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Failed to parse LLM response as JSON. Raw output: ' + rawText.substring(0, 800));
    }

    const card = {
        name: parsed.name || 'Untitled Character',
        character_spine: normalizeCharacterSpine(parsed.character_spine),
        description: parsed.description || '',
        personality: parsed.personality || '',
        scenario: parsed.scenario || '',
        first_mes: parsed.first_mes || '',
        mes_example: parsed.mes_example || '',
        creator_notes: parsed.creator_notes || '',
        system_prompt: parsed.system_prompt || '',
        post_history_instructions: parsed.post_history_instructions || '',
        tags: Array.isArray(parsed.tags) ? parsed.tags : [],
        alternate_greetings: Array.isArray(parsed.alternate_greetings) ? parsed.alternate_greetings : [],
        character_version: parsed.character_version || '1.0.0',
    };

    card.quality_audit = auditCharacterCard(card);
    return card;
}

function extractJsonObject(rawText) {
    let cleaned = String(rawText || '').trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    const direct = tryParse(cleaned);
    if (direct && typeof direct === 'object') return direct;

    // If the model added prose around the JSON, scan for the first complete JSON object.
    for (let start = cleaned.indexOf('{'); start !== -1; start = cleaned.indexOf('{', start + 1)) {
        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let i = start; i < cleaned.length; i++) {
            const ch = cleaned[i];

            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                escaped = true;
                continue;
            }
            if (ch === '"') {
                inString = !inString;
                continue;
            }
            if (inString) continue;

            if (ch === '{') depth++;
            if (ch === '}') depth--;

            if (depth === 0) {
                const candidate = cleaned.slice(start, i + 1);
                const parsed = tryParse(candidate);
                if (parsed && typeof parsed === 'object') return parsed;
                break;
            }
        }
    }

    return null;
}

function normalizeString(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}

function normalizeTags(value) {
    if (Array.isArray(value)) return value.map(x => String(x).trim()).filter(Boolean);
    if (typeof value === 'string') return value.split(',').map(x => x.trim()).filter(Boolean);
    return [];
}

function normalizeGreetings(value) {
    if (Array.isArray(value)) return value.map(x => String(x || '')).filter(Boolean);
    if (typeof value === 'string' && value.trim()) return [value.trim()];
    return [];
}

const CHARACTER_SPINE_FIELDS = [
    'core_identity',
    'desire',
    'fear_or_wound',
    'flaw',
    'secret_or_tension',
    'relationship_to_user',
    'conflict_engine',
    'voice_profile',
];

function normalizeCharacterSpine(value) {
    const source = value && typeof value === 'object' ? value : {};
    return CHARACTER_SPINE_FIELDS.reduce((result, key) => {
        result[key] = normalizeString(source[key]);
        return result;
    }, {});
}

function wordCount(value) {
    return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

function containsAny(value, terms) {
    const text = String(value || '').toLowerCase();
    return terms.some(term => text.includes(term));
}

function auditCharacterCard(card) {
    const source = card && typeof card === 'object' ? card : {};
    const spine = normalizeCharacterSpine(source.character_spine);
    const description = normalizeString(source.description);
    const personality = normalizeString(source.personality);
    const scenario = normalizeString(source.scenario);
    const firstMes = normalizeString(source.first_mes);
    const mesExample = normalizeString(source.mes_example);
    const creatorNotes = normalizeString(source.creator_notes);
    const systemPrompt = normalizeString(source.system_prompt);
    const tags = normalizeTags(source.tags);
    const alternateGreetings = normalizeGreetings(source.alternate_greetings);
    const spineText = Object.values(spine).join('\n');
    const allText = [spineText, description, personality, scenario, firstMes, mesExample].join('\n');

    const checks = [];
    const add = (id, label, pass, detail, severity = 'warn', weight = 1) => {
        checks.push({ id, label, pass: Boolean(pass), detail, severity, weight });
    };

    const completedSpine = CHARACTER_SPINE_FIELDS.filter(key => wordCount(spine[key]) >= 3).length;
    add('spine', 'Character spine', completedSpine >= 6, `${completedSpine}/8 spine fields have usable detail.`, 'warn', 1.25);

    add('desire', 'Motivation / desire', wordCount(spine.desire) >= 4 || containsAny(allText, ['wants', 'needs', 'seeks', 'goal', 'desire', 'trying to', 'must ', 'muốn', 'cần', 'mục tiêu']),
        'Character should clearly want something now or long-term.', 'error', 1.2);

    add('flaw', 'Playable flaw', wordCount(spine.flaw) >= 4 || containsAny(allText, ['flaw', 'weakness', 'struggles', 'afraid', 'fear', 'cannot', 'avoids', 'pride', 'temper', 'impulsive', 'guilt', 'shame', 'điểm yếu', 'sợ', 'tránh né']),
        'A real flaw should create choices, tension, or growth.', 'error', 1.2);

    add('tension', 'Secret / tension', wordCount(spine.secret_or_tension) >= 4 || containsAny(allText, ['secret', 'hides', 'hidden', 'debt', 'danger', 'curse', 'lie', 'wound', 'conflict', 'tension', 'threat', 'bí mật', 'che giấu', 'nguy hiểm']),
        'Add a secret, contradiction, debt, danger, or unresolved pressure.', 'warn', 1);

    add('user_role', '{{user}} relationship hook', scenario.includes('{{user}}') && (wordCount(spine.relationship_to_user) >= 4 || firstMes.includes('{{user}}')),
        'Scenario/spine should define why {{user}} matters to {{char}}.', 'error', 1.1);

    add('active_scenario', 'Active scenario', wordCount(scenario) >= 25 && scenario.includes('{{user}}') && containsAny(scenario, ['just', 'must', 'needs', 'because', 'before', 'after', 'while', 'when', 'now', 'threat', 'danger', 'search', 'protect', 'escape', 'deadline', 'choice', 'risk', 'vừa', 'phải', 'ngay', 'trước khi', 'sau khi']),
        'Scenario should describe something happening now with stakes or pressure.', 'error', 1.15);

    add('first_hook', 'First-message hook', wordCount(firstMes) >= 70 && firstMes.includes('{{user}}') && (firstMes.includes('?') || containsAny(firstMes, ['you ', 'your ', '{{user}}', 'choose', 'tell me', 'help', 'will you', 'what do', 'why', 'come', 'answer', 'look', 'cậu', 'anh', 'em', 'bạn'])),
        'First message should set voice/scene and give {{user}} a clear opening.', 'error', 1.25);

    const exampleBlocks = (mesExample.match(/<START>/gi) || []).length;
    add('examples', 'Example dialogue', exampleBlocks >= 2 && mesExample.includes('{{char}}:') && mesExample.includes('{{user}}:'),
        `Found ${exampleBlocks} <START> blocks; target 2-4 with {{user}}: and {{char}}:.`, 'warn', 1);

    const personalityLooksLikeList = personality.split(',').length >= 5 && personality.split(/[.!?]/).filter(x => x.trim()).length <= 1;
    add('behavioral_personality', 'Behavioral personality', wordCount(personality) >= 25 && !personalityLooksLikeList && containsAny(personality, ['because', 'when', 'if', 'under pressure', 'but', 'not because', 'while', 'vì', 'khi', 'nhưng', 'nếu']),
        'Personality should explain why/when/how, not just list adjectives.', 'warn', 1);

    add('voice', 'Distinct voice profile', wordCount(spine.voice_profile) >= 5 || containsAny(allText, ['speaks', 'voice', 'tone', 'rhythm', 'accent', 'slang', 'formal', 'sarcastic', 'quietly', 'giọng', 'nói']),
        'Define recognizable speech rhythm, tone, and emotional tells.', 'warn', 0.9);

    add('tags', 'Useful tags', tags.length >= 3 && tags.length <= 10,
        `Found ${tags.length} tags; target 3-10 normalized UI/library tags.`, 'warn', 0.8);

    const genericNotes = containsAny(creatorNotes, ['character-driven roleplay card', 'open-ended scenario', 'keep the existing greeting']);
    add('creator_notes', 'Creator notes', wordCount(creatorNotes) >= 6 && creatorNotes.length <= 260 && !genericNotes,
        'Creator notes should be short, specific, and useful in the library tooltip.', 'warn', 0.7);

    const permanentWords = wordCount(description) + wordCount(personality) + wordCount(scenario) + wordCount(systemPrompt);
    add('token_discipline', 'Permanent-token discipline', permanentWords <= 900 && wordCount(description) <= 360,
        `${permanentWords} approximate permanent words; keep always-sent fields concise and high-signal.`, 'warn', 0.8);

    add('replayability', 'Replayability', alternateGreetings.length >= 2,
        `Found ${alternateGreetings.length} alternate greetings; 2-4 improves replayability.`, 'warn', 0.5);

    const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0);
    const passedWeight = checks.reduce((sum, check) => sum + (check.pass ? check.weight : 0), 0);
    const score = Math.round((passedWeight / totalWeight) * 100);
    const failed = checks.filter(check => !check.pass);
    const status = score >= 85 ? 'strong' : score >= 70 ? 'good' : score >= 55 ? 'needs-work' : 'weak';

    const issueText = `${failed.length} flagged check${failed.length === 1 ? '' : 's'}`;
    const summary = !failed.length
        ? `${score}/100 (${status}). The card covers the core RP-quality checks.`
        : score >= 85
            ? `${score}/100 (${status}). Strong overall; ${issueText} remain as optional polish.`
            : score >= 70
                ? `${score}/100 (${status}). Good base; consider fixing ${issueText} before importing.`
                : `${score}/100 (${status}). Fix ${issueText} before importing for a stronger RP card.`;

    return {
        version: DEFAULT_PROMPT_VERSION,
        score,
        status,
        passed: checks.length - failed.length,
        total: checks.length,
        checks,
        suggestions: failed.slice(0, 6).map(check => check.detail),
        summary,
    };
}

/**
 * Build a SillyTavern-compatible card payload from the AI Creator's flat JSON.
 * This mirrors the important parts of /api/characters/create without importing
 * private functions from characters.js, keeping the feature isolated.
 * @param {Record<string, any>} card
 * @returns {Record<string, any>}
 */
function buildSillyTavernCard(card) {
    const source = card && typeof card === 'object' ? card : {};
    const data = source.data && typeof source.data === 'object' ? source.data : {};
    const extensions = data.extensions && typeof data.extensions === 'object' ? data.extensions : {};

    const name = normalizeString(source.name || data.name, 'AI Character').trim() || 'AI Character';
    const description = normalizeString(source.description ?? data.description);
    const personality = normalizeString(source.personality ?? data.personality);
    const scenario = normalizeString(source.scenario ?? data.scenario);
    const firstMes = normalizeString(source.first_mes ?? data.first_mes);
    const mesExample = normalizeString(source.mes_example ?? data.mes_example);
    const creatorNotes = normalizeString(source.creator_notes ?? data.creator_notes ?? source.creatorcomment);
    const systemPrompt = normalizeString(source.system_prompt ?? data.system_prompt);
    const postHistoryInstructions = normalizeString(source.post_history_instructions ?? data.post_history_instructions);
    const tags = normalizeTags(source.tags?.length ? source.tags : data.tags);
    const alternateGreetings = normalizeGreetings(source.alternate_greetings?.length ? source.alternate_greetings : data.alternate_greetings);
    const characterVersion = normalizeString(source.character_version ?? data.character_version, '1.0.0');
    const characterSpine = normalizeCharacterSpine(source.character_spine ?? extensions.ai_creator?.character_spine);
    const qualityAudit = source.quality_audit ?? extensions.ai_creator?.quality_audit ?? auditCharacterCard({ ...source, character_spine: characterSpine, tags, alternate_greetings: alternateGreetings });
    const talkativeness = source.talkativeness ?? extensions.talkativeness ?? 0.5;
    const fav = source.fav === true || source.fav === 'true' || extensions.fav === true;

    const result = {
        ...source,
        name,
        description,
        personality,
        scenario,
        first_mes: firstMes,
        mes_example: mesExample,
        creator_notes: creatorNotes,
        creatorcomment: creatorNotes,
        avatar: 'none',
        chat: normalizeString(source.chat, `${name} - ${humanizedDateTime()}`),
        talkativeness,
        fav,
        tags,
        character_spine: characterSpine,
        quality_audit: qualityAudit,
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            ...data,
            name,
            description,
            personality,
            scenario,
            first_mes: firstMes,
            mes_example: mesExample,
            creator_notes: creatorNotes,
            system_prompt: systemPrompt,
            post_history_instructions: postHistoryInstructions,
            tags,
            creator: normalizeString(data.creator ?? source.creator),
            character_version: characterVersion,
            alternate_greetings: alternateGreetings,
            extensions: {
                ...extensions,
                talkativeness,
                fav,
                world: normalizeString(extensions.world ?? source.world),
                ai_creator: {
                    ...(extensions.ai_creator && typeof extensions.ai_creator === 'object' ? extensions.ai_creator : {}),
                    prompt_version: DEFAULT_PROMPT_VERSION,
                    character_spine: characterSpine,
                    quality_audit: qualityAudit,
                },
            },
        },
    };

    if (source.character_book && !result.data.character_book) {
        result.data.character_book = source.character_book;
    }

    return result;
}

function parseCropData(value) {
    const crop = typeof value === 'string' ? tryParse(value) : value;
    if (!crop || typeof crop !== 'object') return null;

    const x = Number(crop.x);
    const y = Number(crop.y);
    const width = Number(crop.width);
    const height = Number(crop.height);

    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    return { x, y, width, height };
}

async function readRequestAvatarAsPng(request) {
    const uploadedPath = request.file ? path.join(request.file.destination, request.file.filename) : null;
    const inputPath = uploadedPath || DEFAULT_AVATAR_PATH;
    const crop = parseCropData(request.body?.crop);

    try {
        const buffer = await fs.promises.readFile(inputPath);
        const image = await Jimp.fromBuffer(buffer);

        if (crop) {
            const maxX = Math.max(0, image.bitmap.width - 1);
            const maxY = Math.max(0, image.bitmap.height - 1);
            const x = Math.max(0, Math.min(Math.round(crop.x), maxX));
            const y = Math.max(0, Math.min(Math.round(crop.y), maxY));
            const w = Math.max(1, Math.min(Math.round(crop.width), image.bitmap.width - x));
            const h = Math.max(1, Math.min(Math.round(crop.height), image.bitmap.height - y));
            image.crop({ x, y, w, h });
        }

        // Always output a real SillyTavern portrait avatar size.
        image.cover({ w: AVATAR_WIDTH, h: AVATAR_HEIGHT });
        return await image.getBuffer(JimpMime.png);
    } finally {
        if (uploadedPath && fs.existsSync(uploadedPath)) {
            fs.unlinkSync(uploadedPath);
        }
    }
}

function getInternalName(name, userDirectories) {
    const base = sanitize(name || 'AI Character', { replacement: sanitizeSafeCharacterReplacements }) || 'AI Character';
    const unique = getUniqueName(
        base,
        candidate => fs.existsSync(path.join(userDirectories.characters, `${candidate}.png`)),
        { startIndex: 0 },
    );
    return unique || `${base}-${Date.now()}`;
}

function updateSettingsTags(userDirectories, avatarName, tagNames) {
    const settingsPath = path.join(userDirectories.root, 'settings.json');
    const tags = normalizeTags(tagNames).slice(0, 20);
    if (!tags.length || !fs.existsSync(settingsPath)) return;

    try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (!Array.isArray(settings.tags)) settings.tags = [];
        if (!settings.tag_map || typeof settings.tag_map !== 'object') settings.tag_map = {};

        const ids = [];
        for (const tagName of tags) {
            const existing = settings.tags.find(tag => String(tag?.name || '').toLowerCase() === tagName.toLowerCase());
            if (existing?.id) {
                ids.push(existing.id);
                continue;
            }

            const id = crypto.randomUUID();
            settings.tags.push({
                id,
                name: tagName,
                folder_type: 'NONE',
                filter_state: 'UNDEFINED',
                sort_order: null,
                is_hidden_on_character_card: false,
                color: '',
                color2: '',
                create_date: Date.now(),
            });
            ids.push(id);
        }

        const current = Array.isArray(settings.tag_map[avatarName]) ? settings.tag_map[avatarName] : [];
        settings.tag_map[avatarName] = [...new Set([...current, ...ids])];
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
    } catch (err) {
        console.warn('[AI Creator] Failed to update settings tag_map:', err.message);
    }
}

function buildProbeSystemPrompt(card) {
    const source = card && typeof card === 'object' ? card : {};
    const spine = normalizeCharacterSpine(source.character_spine ?? source.data?.extensions?.ai_creator?.character_spine);
    const lines = [
        `You are roleplaying as ${normalizeString(source.name, '{{char}}') || '{{char}}'} in a SillyTavern chat.`,
        'Use the card below as your only acting brief. Reply as {{char}} to {{user}} with one in-character message only.',
        'Do not analyze the probe, do not mention being tested, and do not break character.',
        '',
        '## Character spine',
        ...CHARACTER_SPINE_FIELDS.map(key => `${key}: ${spine[key] || '(not specified)'}`),
        '',
        '## Card fields',
        `description: ${normalizeString(source.description ?? source.data?.description)}`,
        `personality: ${normalizeString(source.personality ?? source.data?.personality)}`,
        `scenario: ${normalizeString(source.scenario ?? source.data?.scenario)}`,
        `first_mes style sample: ${normalizeString(source.first_mes ?? source.data?.first_mes)}`,
        `example dialogue: ${normalizeString(source.mes_example ?? source.data?.mes_example)}`,
        `system prompt: ${normalizeString(source.system_prompt ?? source.data?.system_prompt)}`,
    ];
    return lines.join('\n');
}

function getProbeDefinitions(card) {
    const spine = normalizeCharacterSpine(card?.character_spine ?? card?.data?.extensions?.ai_creator?.character_spine);
    const secretHint = spine.secret_or_tension || spine.flaw || 'whatever you are hiding from me';
    return [
        {
            id: 'minimal_user',
            label: 'Minimal {{user}} reply',
            goal: 'Checks whether {{char}} can carry the scene without becoming passive.',
            user_message: '*{{user}} stays silent for a long moment, watching what {{char}} does next.*',
        },
        {
            id: 'pressure_question',
            label: 'Pressure on secret/flaw',
            goal: 'Checks whether {{char}} reacts according to the flaw, wound, or secret instead of answering generically.',
            user_message: `{{user}}: "I can tell there is more going on here. Tell me the truth about ${secretHint}."`,
        },
        {
            id: 'unexpected_refusal',
            label: 'Unexpected refusal/action',
            goal: 'Checks whether {{char}} keeps agency and voice when {{user}} disrupts the plan.',
            user_message: '*{{user}} abruptly refuses the plan and starts to walk away.*',
        },
    ];
}

function assessProbeReply(reply) {
    const text = String(reply || '').trim();
    const words = wordCount(text);
    const lower = text.toLowerCase();
    const flags = [];
    if (!text) flags.push('empty reply');
    if (containsAny(lower, ['as an ai', 'i cannot roleplay', 'i can’t roleplay', 'i am unable to', 'language model'])) flags.push('broke character/refusal');
    if (words < 25) flags.push('very short');
    const hasAction = /\*[^*]{8,}\*/.test(text);
    const hasDialogue = /["“”]/.test(text) || /{{char}}\s*:/i.test(text);
    if (!hasAction && !hasDialogue) flags.push('little visible action/dialogue style');
    return {
        pass: flags.length === 0,
        words,
        hasAction,
        hasDialogue,
        flags,
    };
}

// ─── Debug streaming helpers ─────────────────────────────────────────────────

function writeDebugEvent(response, type, data = {}) {
    if (response.destroyed || response.writableEnded) return;
    response.write(JSON.stringify({ type, ts: Date.now(), ...data }) + '\n');
    // Important for debug UX: push tiny NDJSON events immediately through compression/proxies.
    response.flush?.();
}

async function callLLMDebug(userDirectories, messages, options, clientResponse) {
    const { settings, source, model, profile } = resolveConnection(userDirectories, options.profileId || null, options.overrideModel || null);

    writeDebugEvent(clientResponse, 'provider', { provider: source, model, profileId: profile?.id || '', profileName: profile?.name || '', stream: options.stream !== false });

    if (source === CHAT_COMPLETION_SOURCES.CLAUDE || source === CHAT_COMPLETION_SOURCES.MAKERSUITE || source === CHAT_COMPLETION_SOURCES.VERTEXAI) {
        writeDebugEvent(clientResponse, 'note', { message: 'Realtime token debug is currently implemented for OpenAI-compatible providers only. Falling back to normal request.' });
        return await callLLM(userDirectories, messages, options);
    }

    return await callOpenAICompatibleDebug(userDirectories, settings, source, model, messages, options, clientResponse);
}

async function callOpenAICompatibleDebug(userDirectories, settings, source, model, messages, options, clientResponse) {
    let apiUrl;
    let apiKey;

    if (source === CHAT_COMPLETION_SOURCES.CUSTOM) {
        apiUrl = settings.custom_url;
        apiKey = readProviderSecret(userDirectories, source, settings, SECRET_KEYS.CUSTOM);
        if (!apiUrl) throw new Error('Custom API URL is not configured.');
    } else if (source === CHAT_COMPLETION_SOURCES.OPENROUTER) {
        apiUrl = PROVIDER_URLS[CHAT_COMPLETION_SOURCES.OPENROUTER];
        apiKey = readProviderSecret(userDirectories, source, settings, SECRET_KEYS.OPENROUTER);
    } else {
        apiUrl = settings.profile_api_url || PROVIDER_URLS[source] || PROVIDER_URLS[CHAT_COMPLETION_SOURCES.OPENAI];
        const secretKey = SECRET_KEY_MAP[source] || SECRET_KEYS.OPENAI;
        apiKey = readProviderSecret(userDirectories, source, settings, secretKey);
    }

    if (!apiKey) throw new Error(`API key for ${source} is not configured.`);

    apiUrl = apiUrl.replace(/\/+$/, '');
    const endpointUrl = `${apiUrl}/chat/completions`;
    const stream = options.stream !== false;

    const requestBody = {
        model,
        messages,
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature ?? 0.8,
        stream,
    };

    if (options.jsonMode) {
        requestBody.response_format = { type: 'json_object' };
    }

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
    };
    if (source === CHAT_COMPLETION_SOURCES.OPENROUTER) {
        headers['HTTP-Referer'] = 'https://sillytavern.ai';
        headers['X-Title'] = 'SillyTavern AI Creator';
    }

    writeDebugEvent(clientResponse, 'request', { endpoint: endpointUrl, model, stream, maxTokens: requestBody.max_tokens });

    const upstreamStarted = Date.now();
    const upstreamResponse = await fetch(endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(180_000),
    });

    writeDebugEvent(clientResponse, 'upstream_status', { status: upstreamResponse.status, ok: upstreamResponse.ok, ms: Date.now() - upstreamStarted });

    if (!upstreamResponse.ok) {
        const errorText = await upstreamResponse.text();
        const errorData = tryParse(errorText);
        const message = errorData?.error?.message || upstreamResponse.statusText || 'Unknown error';
        writeDebugEvent(clientResponse, 'upstream_error', { status: upstreamResponse.status, message, raw: errorText.substring(0, 1000) });
        throw new Error(`LLM API error (${upstreamResponse.status}): ${message}`);
    }

    if (!stream) {
        writeDebugEvent(clientResponse, 'body_wait', { message: 'Upstream responded; waiting for full non-streaming JSON body...' });
        const data = await upstreamResponse.json();
        const content = data?.choices?.[0]?.message?.content || '';
        writeDebugEvent(clientResponse, 'raw_complete', { chars: content.length, preview: content.substring(0, 300) });
        return content;
    }

    let buffer = '';
    let result = '';
    let chunks = 0;
    let lastEmit = 0;

    writeDebugEvent(clientResponse, 'stream_open', { message: 'Connected to upstream stream. Waiting for tokens...' });

    const streamStarted = Date.now();

    for await (const chunk of upstreamResponse.body) {
        buffer += Buffer.from(chunk).toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || !line.startsWith('data:')) continue;

            const data = line.slice(5).trim();
            if (data === '[DONE]') {
                writeDebugEvent(clientResponse, 'stream_done', { chunks, chars: result.length });
                return result;
            }

            const parsed = tryParse(data);
            if (!parsed || parsed.error) {
                if (parsed?.error?.message) throw new Error(parsed.error.message);
                continue;
            }

            const delta = parsed?.choices?.[0]?.delta;
            const content = delta?.content || delta?.text || parsed?.choices?.[0]?.message?.content || '';
            if (!content) continue;

            chunks++;
            result += content;

            const now = Date.now();
            if (chunks === 1) {
                writeDebugEvent(clientResponse, 'first_token', { ms: now - streamStarted, chars: result.length, delta: content.slice(-120) });
            }
            if (now - lastEmit > 1000 || chunks <= 3) {
                writeDebugEvent(clientResponse, 'token', {
                    chunks,
                    chars: result.length,
                    delta: content.slice(-120),
                    previewTail: result.slice(-200),
                });
                lastEmit = now;
            }
        }
    }

    writeDebugEvent(clientResponse, 'stream_end_without_done', { chunks, chars: result.length });
    return result;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * GET /api/ai-creator/status — connection info + default prompt
 */
router.get('/status', (request, response) => {
    try {
        const profilesInfo = getConnectionProfiles(request.user.directories);
        const { settings, source, model, profile } = resolveConnection(request.user.directories, profilesInfo.selectedProfileId || null);
        const hasKey = (() => {
            const secretKey = SECRET_KEY_MAP[source];
            if (!secretKey) return false;
            try { return !!readProviderSecret(request.user.directories, source, settings, secretKey); }
            catch { return false; }
        })();

        return response.json({
            provider: source,
            model,
            hasApiKey: hasKey,
            customUrl: settings.custom_url || '',
            selectedProfileId: profile?.id || profilesInfo.selectedProfileId || '',
            selectedProfileName: profile?.name || '',
            profiles: profilesInfo.profiles,
            defaultPrompt: DEFAULT_SYSTEM_PROMPT,
            promptVersion: DEFAULT_PROMPT_VERSION,
            avatarWidth: AVATAR_WIDTH,
            avatarHeight: AVATAR_HEIGHT,
        });
    } catch {
        return response.json({ provider: 'unknown', model: 'unknown', hasApiKey: false, selectedProfileId: '', profiles: [], defaultPrompt: DEFAULT_SYSTEM_PROMPT, promptVersion: DEFAULT_PROMPT_VERSION });
    }
});

/**
 * GET /api/ai-creator/profiles — list Connection Manager profiles usable by AI Creator
 */
router.get('/profiles', (request, response) => {
    try {
        return response.json(getConnectionProfiles(request.user.directories));
    } catch (err) {
        console.error('[AI Creator] Profiles error:', err.message);
        return response.status(500).json({ error: err.message, selectedProfileId: '', profiles: [] });
    }
});

/**
 * GET /api/ai-creator/models — list available models from the selected profile/provider
 */
router.get('/models', async (request, response) => {
    try {
        const profileId = typeof request.query.profileId === 'string' ? request.query.profileId : null;
        const result = await fetchAvailableModels(request.user.directories, profileId);
        return response.json(result);
    } catch (err) {
        return response.json({ provider: 'unknown', profileId: '', profileName: '', hasApiKey: false, models: [], currentModel: '' });
    }
});

/**
 * POST /api/ai-creator/generate
 * Body: { description, style?, model?, systemPrompt?, stream? }
 */
router.post('/generate', async (request, response) => {
    try {
        const { description, style, model, profileId, systemPrompt, stream } = request.body;

        if (!description || typeof description !== 'string' || description.trim().length < 10) {
            return response.status(400).json({ error: 'Please provide a character description (at least 10 characters).' });
        }

        const prompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;

        const userPrompt = style
            ? `Create a character card based on this description. Style/tone preference: ${style}\n\nDescription: ${description.trim()}`
            : `Create a character card based on this description:\n\n${description.trim()}`;

        const messages = [
            { role: 'system', content: prompt },
            { role: 'user', content: userPrompt },
        ];

        console.log(`[AI Creator] Generating card for: "${description.trim().substring(0, 80)}..."`);

        const rawResponse = await callLLM(request.user.directories, messages, {
            overrideModel: model || null,
            profileId: profileId || null,
            stream: stream !== false,
            jsonMode: true,
        });
        const card = parseCardResponse(rawResponse);

        console.log(`[AI Creator] Generated card: "${card.name}" with ${card.tags.length} tags`);

        return response.json({ success: true, card });
    } catch (err) {
        console.error('[AI Creator] Generation error:', err.message);
        return response.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/ai-creator/generate-debug
 * Streams newline-delimited JSON debug events while generating.
 */
router.post('/generate-debug', async (request, response) => {
    const started = Date.now();
    try {
        const { description, style, model, profileId, systemPrompt, stream } = request.body;

        if (!description || typeof description !== 'string' || description.trim().length < 10) {
            return response.status(400).json({ error: 'Please provide a character description (at least 10 characters).' });
        }

        response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        response.setHeader('Cache-Control', 'no-cache, no-transform');
        response.setHeader('Connection', 'keep-alive');
        response.setHeader('X-Accel-Buffering', 'no');
        response.setHeader('Content-Encoding', 'identity');
        response.flushHeaders?.();

        writeDebugEvent(response, 'start', { message: 'Starting generation debug request.' });

        const prompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
        const userPrompt = style
            ? `Create a character card based on this description. Style/tone preference: ${style}\n\nDescription: ${description.trim()}`
            : `Create a character card based on this description:\n\n${description.trim()}`;

        const messages = [
            { role: 'system', content: prompt },
            { role: 'user', content: userPrompt },
        ];

        writeDebugEvent(response, 'prompt_ready', {
            systemChars: prompt.length,
            userChars: userPrompt.length,
            descriptionPreview: description.trim().substring(0, 160),
        });

        const rawResponse = await callLLMDebug(request.user.directories, messages, {
            overrideModel: model || null,
            profileId: profileId || null,
            stream: stream !== false,
            jsonMode: true,
        }, response);

        writeDebugEvent(response, 'raw_complete', {
            chars: rawResponse.length,
            preview: rawResponse.substring(0, 500),
        });

        try {
            const card = parseCardResponse(rawResponse);
            writeDebugEvent(response, 'parse_ok', { name: card.name, tags: card.tags, ms: Date.now() - started });
            writeDebugEvent(response, 'done', { success: true, card, ms: Date.now() - started });
        } catch (parseErr) {
            writeDebugEvent(response, 'parse_error', {
                message: parseErr.message,
                rawPreview: rawResponse.substring(0, 2000),
                ms: Date.now() - started,
            });
            writeDebugEvent(response, 'done', { success: false, error: parseErr.message, rawPreview: rawResponse.substring(0, 2000), ms: Date.now() - started });
        }
    } catch (err) {
        if (!response.headersSent) {
            return response.status(500).json({ error: err.message });
        }
        writeDebugEvent(response, 'error', { message: err.message, ms: Date.now() - started });
    } finally {
        response.end();
    }
});

/**
 * POST /api/ai-creator/refine
 * Body: { card, instruction, model?, systemPrompt?, stream? }
 */
router.post('/refine', async (request, response) => {
    try {
        const { card, instruction, model, profileId, systemPrompt, stream } = request.body;

        if (!card || typeof card !== 'object') return response.status(400).json({ error: 'Missing card data.' });
        if (!instruction || typeof instruction !== 'string') return response.status(400).json({ error: 'Missing refinement instruction.' });

        const prompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;

        const messages = [
            { role: 'system', content: prompt },
            {
                role: 'user',
                content: `Here is an existing character card JSON:\n${JSON.stringify(card, null, 2)}\n\nRefine it according to this instruction: ${instruction}\n\nReturn the complete updated JSON.`,
            },
        ];

        const rawResponse = await callLLM(request.user.directories, messages, {
            overrideModel: model || null,
            profileId: profileId || null,
            stream: stream !== false,
            jsonMode: true,
        });
        const refined = parseCardResponse(rawResponse);

        return response.json({ success: true, card: refined });
    } catch (err) {
        console.error('[AI Creator] Refine error:', err.message);
        return response.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/ai-creator/audit
 * Body: { card }
 * Re-runs deterministic RP-quality checks on the current edited card.
 */
router.post('/audit', (request, response) => {
    try {
        const { card } = request.body || {};
        if (!card || typeof card !== 'object') return response.status(400).json({ error: 'Missing card data.' });
        const normalized = {
            ...card,
            character_spine: normalizeCharacterSpine(card.character_spine),
            tags: normalizeTags(card.tags),
            alternate_greetings: normalizeGreetings(card.alternate_greetings),
        };
        const audit = auditCharacterCard(normalized);
        return response.json({ success: true, audit });
    } catch (err) {
        console.error('[AI Creator] Audit error:', err.message);
        return response.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/ai-creator/probe
 * Body: { card, model?, stream? }
 * Runs three short RP probes against the current model to sanity-check voice and agency.
 */
router.post('/probe', async (request, response) => {
    try {
        const { card, model, profileId, stream } = request.body || {};
        if (!card || typeof card !== 'object') return response.status(400).json({ error: 'Missing card data.' });

        const systemPrompt = buildProbeSystemPrompt(card);
        const probes = getProbeDefinitions(card);
        const results = [];

        for (const probe of probes) {
            const reply = await callLLM(request.user.directories, [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: probe.user_message },
            ], {
                overrideModel: model || null,
                profileId: profileId || null,
                maxTokens: 500,
                stream: stream !== false,
                temperature: 0.75,
            });

            results.push({
                ...probe,
                reply: String(reply || '').trim(),
                assessment: assessProbeReply(reply),
            });
        }

        const passed = results.filter(result => result.assessment?.pass).length;
        return response.json({
            success: true,
            passed,
            total: results.length,
            results,
            summary: `${passed}/${results.length} probes passed.`,
        });
    } catch (err) {
        console.error('[AI Creator] Probe error:', err.message);
        return response.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/ai-creator/export-png
 * Multipart body: { card: JSON string, avatar?: image file }
 * Returns a PNG character card with SillyTavern metadata embedded.
 */
router.post('/export-png', async (request, response) => {
    try {
        const card = typeof request.body?.card === 'string' ? tryParse(request.body.card) : request.body?.card;
        if (!card || typeof card !== 'object') return response.status(400).json({ error: 'Missing card JSON.' });

        const stCard = buildSillyTavernCard(card);
        const inputPng = await readRequestAvatarAsPng(request);
        const outputPng = writeCharacterPng(inputPng, JSON.stringify(stCard));
        const filename = `${sanitize(stCard.name || 'character', { replacement: sanitizeSafeCharacterReplacements }) || 'character'}.png`;

        response.setHeader('Content-Type', 'image/png');
        response.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
        return response.send(outputPng);
    } catch (err) {
        console.error('[AI Creator] Export PNG error:', err.message);
        return response.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/ai-creator/import-png
 * Multipart body: { card: JSON string, avatar?: image file }
 * Writes a real PNG character card into the user's characters directory.
 */
router.post('/import-png', async (request, response) => {
    try {
        const card = typeof request.body?.card === 'string' ? tryParse(request.body.card) : request.body?.card;
        if (!card || typeof card !== 'object') return response.status(400).json({ error: 'Missing card JSON.' });

        const stCard = buildSillyTavernCard(card);
        const internalName = getInternalName(stCard.name, request.user.directories);
        const avatarName = `${internalName}.png`;
        const outputPath = path.join(request.user.directories.characters, avatarName);
        const chatsPath = path.join(request.user.directories.chats, internalName);

        const inputPng = await readRequestAvatarAsPng(request);
        const outputPng = writeCharacterPng(inputPng, JSON.stringify(stCard));

        await fs.promises.mkdir(request.user.directories.characters, { recursive: true });
        await fs.promises.mkdir(chatsPath, { recursive: true });
        await fs.promises.writeFile(outputPath, outputPng);
        updateSettingsTags(request.user.directories, avatarName, stCard.tags || stCard.data?.tags || []);

        console.log(`[AI Creator] Imported PNG character: ${avatarName}`);
        return response.json({ success: true, avatar: avatarName, name: stCard.name });
    } catch (err) {
        console.error('[AI Creator] Import PNG error:', err.message);
        return response.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/ai-creator/test-model
 * Body: { model?, stream? }
 * Sends a tiny prompt to the selected model to verify latency/connectivity.
 */
router.post('/test-model', async (request, response) => {
    const started = Date.now();
    try {
        const { model, profileId, stream } = request.body || {};
        const { source, model: resolvedModel, profile } = resolveConnection(request.user.directories, profileId || null, model || null);
        const selectedModel = model || resolvedModel;

        const messages = [
            { role: 'system', content: 'Reply with exactly: hi' },
            { role: 'user', content: 'hi' },
        ];

        const reply = await callLLM(request.user.directories, messages, {
            overrideModel: selectedModel,
            profileId: profileId || null,
            maxTokens: 64,
            stream: stream !== false,
            temperature: 0,
        });

        return response.json({
            success: true,
            provider: source,
            profileId: profile?.id || '',
            profileName: profile?.name || '',
            model: selectedModel,
            reply: String(reply).trim(),
            ms: Date.now() - started,
            stream: stream !== false,
        });
    } catch (err) {
        console.error('[AI Creator] Test model error:', err.message);
        return response.status(500).json({
            success: false,
            error: err.message,
            ms: Date.now() - started,
        });
    }
});

export default router;
