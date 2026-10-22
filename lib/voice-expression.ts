import { loadBindingConfig, loadVoiceConfigs, resolveBinding } from "./settings-storage";

const expressiveModels = new Set(["eleven_v3", "eleven_v4", "eleven_v4_turbo"]);
// Temporary user-requested comparison. Restore to true after the test;
// keep parsing, saved speech and provider/model controls intact.
export const VOICE_EXPRESSION_GUIDANCE_ENABLED = true;
export function supportsVoiceExpression(provider: string, model: string | undefined): boolean {
    if (provider === "FishAudio") return true;
    return provider === "ElevenLabs" && expressiveModels.has(model?.trim() || "");
}
export function voiceExpressionInstruction(characterIds: string[], call = false): string {
    if (!VOICE_EXPRESSION_GUIDANCE_ENABLED) return "";
    const bindings = loadBindingConfig();
    const configs = loadVoiceConfigs();
    const eligible = characterIds.filter(id => {
        const slot = resolveBinding(bindings, id, "chat");
        const config = configs.find(item => item.id === slot.voiceConfigId);
        return !!config && supportsVoiceExpression(config.provider, config.model);
    });
    if (!eligible.length) return "";
    return `【语音表达】适用角色ID：${eligible.join("、")}。
根据各自人设、关系、当前上下文和情绪，自主选择音量、节奏、轻重、句尾语调和亲昵程度。同一情绪须体现不同角色的表达习惯，并随当下情境变化。
teasing：沉稳、克制型可轻声从容、宠溺笃定、句尾下沉；阳光小狗型可明亮热情、真诚带笑、句尾上扬。按实际人设与关系选择，不照搬示例。
表达参考：happy开心；excited兴奋；warmly温暖；angry生气；annoyed烦躁；sarcastic讽刺；sad难过；crying哭泣；curious好奇；thoughtful思考；surprised惊讶；appalled惊骇；mischievously调皮；soft, affectionate tone宠溺；gentle, reassuring tone安抚；weary, resigned tone无奈；fondly exasperated tone带笑无奈；playful, teasing tone调笑；controlled, restrained anger克制怒意；cool, detached tone冷淡；soft, hurt tone委屈；anxious tone紧张；hesitant tone迟疑；calm, firm tone坚定。
发声参考：chuckles轻笑；laughs笑；sighs叹息；exhales呼气；inhales deeply深吸气；clears throat清嗓；whispers耳语；shouting喊叫；short pause短停顿；long pause长停顿。可组合或用简短英文描述声音。
每句通常0—2个标记，可不加；情绪转折时再增加。保持自然，避免反复笑、叹气或耳语。只标声音，不标肢体动作或环境音。
格式：{voice:英文表达}，放在对应台词前或停顿处，不用嵌套方括号。${call ? "当前为通话，在口述正文内标注，不改成语音条。" : "只在 [语音条:台词] 内标注，如 [语音条:{voice:chuckles} 你又来了。]；普通文字不加。"}
保留原台词与双语格式，只添加声音标记。语气词随台词自然生成，不为声音效果改写对白。只输出原有消息协议要求的内容。`;
}

// A separate marker avoids nested [] breaking the existing voice-message envelope.
const marker = /\{voice:\s*([a-zA-Z][a-zA-Z ,'-]{0,100})\}/g;
export function voiceDisplayText(text: string): string {
    return text.replace(marker, "").trim();
}
export function voiceSpeechText(text: string): string {
    return text.replace(marker, (_whole, direction: string) => `[${direction.trim()}]`).trim();
}
