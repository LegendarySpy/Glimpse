export type LlmProvider =
    | "lmstudio"
    | "ollama"
    | "openai"
    | "anthropic"
    | "google"
    | "xai"
    | "groq"
    | "cerebras"
    | "sambanova"
    | "together"
    | "openrouter"
    | "perplexity"
    | "deepseek"
    | "fireworks"
    | "mistral"
    | "custom";

export type LlmProviderPreset = {
    id: LlmProvider;
    label: string;
    endpoint: string;
    defaultModel: string;
    apiKeyRequired: boolean;
};

export const LLM_PROVIDER_PRESETS: LlmProviderPreset[] = [
    { id:"custom",label:"Custom",endpoint:"",defaultModel:"",apiKeyRequired:false },
    { id:"lmstudio",label:"LM Studio",endpoint:"http://localhost:1234/v1",defaultModel:"",apiKeyRequired:false },
    { id:"ollama",label:"Ollama",endpoint:"http://localhost:11434/v1",defaultModel:"",apiKeyRequired:false },
    { id:"openai",label:"OpenAI",endpoint:"https://api.openai.com/v1",defaultModel:"gpt-5-mini",apiKeyRequired:true },
    { id:"anthropic",label:"Anthropic (native)",endpoint:"https://api.anthropic.com",defaultModel:"claude-3-5-haiku-latest",apiKeyRequired:true },
    { id:"google",label:"Google Gemini",endpoint:"https://generativelanguage.googleapis.com/v1beta/openai/",defaultModel:"gemini-2.5-flash",apiKeyRequired:true },
    { id:"xai",label:"xAI (Grok)",endpoint:"https://api.x.ai/v1",defaultModel:"grok-4-mini",apiKeyRequired:true },
    { id:"groq",label:"Groq",endpoint:"https://api.groq.com/openai/v1",defaultModel:"llama-3.3-70b-versatile",apiKeyRequired:true },
    { id:"cerebras",label:"Cerebras",endpoint:"https://api.cerebras.ai/v1",defaultModel:"llama-3.3-70b",apiKeyRequired:true },
    { id:"sambanova",label:"SambaNova",endpoint:"https://api.sambanova.ai/v1",defaultModel:"Meta-Llama-3.3-70B-Instruct",apiKeyRequired:true },
    { id:"together",label:"Together AI",endpoint:"https://api.together.xyz/v1",defaultModel:"",apiKeyRequired:true },
    { id:"openrouter",label:"OpenRouter",endpoint:"https://openrouter.ai/api/v1",defaultModel:"openai/gpt-4o-mini",apiKeyRequired:true },
    { id:"perplexity",label:"Perplexity",endpoint:"https://api.perplexity.ai",defaultModel:"sonar-pro",apiKeyRequired:true },
    { id:"deepseek",label:"DeepSeek",endpoint:"https://api.deepseek.com/v1",defaultModel:"deepseek-chat",apiKeyRequired:true },
    { id:"fireworks",label:"Fireworks",endpoint:"https://api.fireworks.ai/inference/v1",defaultModel:"accounts/fireworks/models/llama-v3p1-70b-instruct",apiKeyRequired:true },
    { id:"mistral",label:"Mistral",endpoint:"https://api.mistral.ai/v1",defaultModel:"mistral-small-latest",apiKeyRequired:true },
    ];
    

export const LOCAL_PROVIDERS = LLM_PROVIDER_PRESETS.filter(p => !p.apiKeyRequired);
export const CLOUD_PROVIDERS = LLM_PROVIDER_PRESETS.filter(p => p.apiKeyRequired);

export function getProviderPreset(id: LlmProvider): LlmProviderPreset | undefined {
    return LLM_PROVIDER_PRESETS.find(p => p.id === id);
}

export function getProviderLabel(id: LlmProvider): string {
    if (id === "custom") return "Custom";
    return getProviderPreset(id)?.label ?? id;
}
