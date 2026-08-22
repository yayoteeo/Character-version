import {
    characters,
    eventSource,
    event_types,
    getCurrentChatId,
    saveSettingsDebounced,
    this_chid,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import {
    setPersonaDescription,
    setUserAvatar,
    user_avatar,
} from '../../../personas.js';
import { persona_description_positions, power_user } from '../../../power-user.js';
import { Popup } from '../../../popup.js';

const MODULE_NAME = 'persona-variants';
const PANEL_ID = 'persona_variants_panel';
const DEFAULT_DEPTH = 2;
const DEFAULT_ROLE = 0;
const AUTO_APPLY_DELAY = 120;
const AUTO_SAVE_DELAY = 350;

let contextChangeTimer = null;
let autoSaveTimer = null;
let autoApplyInProgress = false;
let lastAutoAppliedBinding = '';

function isNamedExistingPersona(avatarId = user_avatar) {
    if (!avatarId || !Object.prototype.hasOwnProperty.call(power_user.personas ?? {}, avatarId)) {
        return false;
    }

    const name = String(power_user.personas[avatarId] ?? '').trim();
    return Boolean(name && name !== '[Unnamed Persona]');
}

function makeId() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getSettings() {
    const settings = extension_settings[MODULE_NAME] ??= { schemaVersion: 5, personas: {}, chatBindings: {}, autoSaveEnabled: false, characterContext: {} };
    settings.schemaVersion ??= 1;
    settings.personas ??= {};
    settings.chatBindings ??= {};
    settings.autoSaveEnabled ??= false;
    settings.characterContext ??= {};

    if (settings.schemaVersion < 2) {
        for (const store of Object.values(settings.personas)) {
            for (const variant of store?.variants ?? []) {
                delete variant.personaName;
            }
        }
        settings.schemaVersion = 2;
    }

    if (settings.schemaVersion < 3) {
        settings.chatBindings ??= {};
        settings.schemaVersion = 3;
    }

    if (settings.schemaVersion < 4) {
        settings.autoSaveEnabled ??= false;
        settings.schemaVersion = 4;
    }

    if (settings.schemaVersion < 5) {
        settings.characterContext ??= {};
        settings.schemaVersion = 5;
    }

    for (const store of Object.values(settings.personas)) {
        store.activeId ??= '';
        store.variants ??= [];
        for (const variant of store.variants) {
            const characterIds = Array.isArray(variant.characterIds) ? variant.characterIds : [];
            variant.characterIds = [...new Set(characterIds.map(String).filter(Boolean))];
        }
    }

    // A chat binding also counts as a character binding. This keeps old data
    // consistent with the role-first browser without requiring another action.
    for (const binding of Object.values(settings.chatBindings)) {
        const variant = settings.personas[binding?.avatarId]?.variants?.find(item => item.id === binding?.variantId);
        const characterId = String(binding?.characterId ?? '').trim();
        if (variant && characterId && !variant.characterIds.includes(characterId)) {
            variant.characterIds.push(characterId);
        }
    }
    return settings;
}

function getPersonaStore(avatarId = user_avatar, create = false) {
    if (!avatarId) {
        return null;
    }

    const stores = getSettings().personas;
    if (!stores[avatarId] && create) {
        stores[avatarId] = { activeId: '', variants: [] };
    }

    const store = stores[avatarId] ?? null;
    if (store) {
        store.activeId ??= '';
        store.variants ??= [];
    }
    return store;
}

function getCurrentCharacterContext() {
    if (this_chid === undefined || this_chid === null) {
        return null;
    }

    const character = characters?.[Number(this_chid)];
    if (!character?.avatar) {
        return null;
    }

    return {
        id: String(character.avatar),
        name: String(character.name || character.avatar),
    };
}

function getCurrentChatContext() {
    const character = getCurrentCharacterContext();
    const chatId = getCurrentChatId();
    if (!character || !chatId) {
        return null;
    }

    const normalizedChatId = String(chatId);
    return {
        key: `${encodeURIComponent(character.id)}::${encodeURIComponent(normalizedChatId)}`,
        characterId: character.id,
        characterName: character.name,
        chatId: normalizedChatId,
    };
}

function getVariant(avatarId, variantId) {
    return getPersonaStore(avatarId)?.variants.find(item => item.id === variantId) ?? null;
}

function getVisibleVariants(variants, characterId = '') {
    return variants.filter((variant) => {
        const bindings = getVariantCharacterIds(user_avatar, variant);
        if (characterId === '__all__') {
            return true;
        }
        if (characterId === '__unbound__') {
            return bindings.length === 0;
        }
        return bindings.length === 0 || Boolean(characterId && bindings.includes(characterId));
    });
}

function getVariantCharacterIds(avatarId, variant) {
    const ids = new Set((Array.isArray(variant?.characterIds) ? variant.characterIds : []).map(String));
    for (const [, binding] of Object.entries(getSettings().chatBindings)) {
        if (binding?.avatarId === avatarId && binding?.variantId === variant?.id && binding.characterId) {
            ids.add(String(binding.characterId));
        }
    }
    return [...ids];
}

function getBoundCharacterIds(avatarId = user_avatar) {
    const ids = new Set();
    for (const variant of getPersonaStore(avatarId)?.variants ?? []) {
        for (const id of getVariantCharacterIds(avatarId, variant)) {
            ids.add(id);
        }
    }
    return [...ids];
}

function getCharacterContextId(panel) {
    const value = String(panel?.querySelector('#persona_variant_character_context')?.value || '');
    return value || '__all__';
}

function getCharacterFilterOptions(avatarId = user_avatar) {
    const ids = getBoundCharacterIds(avatarId);
    const current = getCurrentCharacterContext();
    if (current && !ids.includes(current.id)) {
        ids.push(current.id);
    }
    return ids;
}

function getSelectedCharacterTarget(panel) {
    const selectedId = getCharacterContextId(panel);
    if (!selectedId || selectedId === '__all__' || selectedId === '__unbound__') {
        return getCurrentCharacterContext();
    }
    return { id: selectedId, name: getCharacterName(selectedId) };
}

function renderCharacterContextOptions(panel) {
    const input = panel.querySelector('#persona_variant_character_search');
    const select = panel.querySelector('#persona_variant_character_context');
    const settings = getSettings();
    const search = String(input.value || '').trim().toLocaleLowerCase();
    const ids = getCharacterFilterOptions(user_avatar);
    const current = getCurrentCharacterContext();
    const saved = settings.characterContext[user_avatar];
    const preferred = saved || current?.id || '__all__';
    const options = [
        { id: '__all__', label: '全部版本（不按角色筛选）' },
        { id: '__unbound__', label: '未绑定角色（通用版本）' },
        ...ids.map(id => ({ id, label: `${getCharacterName(id)}${current?.id === id ? '（当前角色）' : ''}` })),
    ];
    const matchesSearch = item => !search || item.id.startsWith('__') || item.label.toLocaleLowerCase().includes(search) || item.id.toLocaleLowerCase().includes(search);
    const filtered = options.filter(matchesSearch);
    if (!filtered.some(item => item.id === preferred)) {
        const selected = options.find(item => item.id === preferred);
        if (selected) filtered.unshift(selected);
    }

    select.replaceChildren();
    for (const optionData of filtered) {
        const option = document.createElement('option');
        option.value = optionData.id;
        option.textContent = optionData.label;
        select.append(option);
    }
    select.value = filtered.some(item => item.id === preferred) ? preferred : (filtered[0]?.id || '__all__');
    return select.value;
}

function describeVersionScope(variant) {
    const characterIds = getVariantCharacterIds(user_avatar, variant);
    if (characterIds.length === 0) {
        return '显示范围：通用（所有角色）';
    }
    return `显示范围：${characterIds.map(getCharacterName).join('、')}`;
}

function getChatBindingsForVariant(avatarId, variantId) {
    return Object.entries(getSettings().chatBindings)
        .filter(([, binding]) => binding?.avatarId === avatarId && binding?.variantId === variantId);
}

function describeVariantBinding(binding) {
    const variant = getVariant(binding?.avatarId, binding?.variantId);
    const personaName = power_user.personas?.[binding?.avatarId];
    if (!variant || !personaName) {
        return '绑定目标已不存在';
    }
    return `${personaName} / ${getVariantLabel(variant)}`;
}

function captureCurrentPersona() {
    if (!isNamedExistingPersona()) {
        return null;
    }

    const descriptor = power_user.persona_descriptions?.[user_avatar] ?? {};
    return {
        title: String(descriptor.title ?? ''),
        description: String(descriptor.description ?? power_user.persona_description ?? ''),
        position: Number(descriptor.position ?? power_user.persona_description_position ?? persona_description_positions.IN_PROMPT),
        depth: Number(descriptor.depth ?? power_user.persona_description_depth ?? DEFAULT_DEPTH),
        role: Number(descriptor.role ?? power_user.persona_description_role ?? DEFAULT_ROLE),
        lorebook: String(descriptor.lorebook ?? power_user.persona_description_lorebook ?? ''),
    };
}

function getVariantLabel(variant) {
    return variant.name || '未命名版本';
}

function refreshCurrentPersonaCard() {
    const noDescription = $('#user_avatar_block').attr('no_desc_text') || '[No description]';
    $('#user_avatar_block .avatar-container').each(function () {
        if ($(this).attr('data-avatar-id') !== user_avatar) {
            return;
        }

        const descriptor = power_user.persona_descriptions?.[user_avatar] ?? {};
        $(this).find('.ch_description')
            .text(descriptor.description || noDescription)
            .toggleClass('text_muted', !descriptor.description);
        $(this).find('.ch_additional_info').text(descriptor.title || '');
    });
}

function getCharacterName(characterId) {
    return String(characters?.find(item => item?.avatar === characterId)?.name || characterId);
}

function appendBindingChip(container, label, action, value) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'persona-variant-binding-chip';
    button.dataset.bindingAction = action;
    button.dataset.bindingValue = value;
    button.title = `点击解除：${label}`;
    button.textContent = `${label} ×`;
    container.append(button);
}

function renderChatBindings(panel, variant) {
    const chatsList = panel.querySelector('.persona-variant-bound-chats');
    chatsList.replaceChildren();

    if (!variant) {
        chatsList.textContent = '选择一个版本后管理绑定';
        return;
    }

    const chatBindings = getChatBindingsForVariant(user_avatar, variant.id);
    if (chatBindings.length === 0) {
        chatsList.textContent = '未绑定聊天';
    } else {
        for (const [chatKey, binding] of chatBindings) {
            const label = `${binding.characterName || getCharacterName(binding.characterId)} · ${binding.chatId}`;
            appendBindingChip(chatsList, label, 'remove-chat', chatKey);
        }
    }
}

function renderCharacterBindings(panel, variant) {
    const charactersList = panel.querySelector('.persona-variant-bound-characters');
    const currentCharacter = getSelectedCharacterTarget(panel);
    const characterButton = panel.querySelector('#persona_variant_bind_character');
    charactersList.replaceChildren();

    if (!variant) {
        charactersList.textContent = '选择一个版本后管理绑定';
        characterButton.disabled = true;
        return;
    }

    const characterIds = getVariantCharacterIds(user_avatar, variant);
    if (characterIds.length === 0) {
        charactersList.textContent = '未绑定角色：在所有角色下可见';
    } else {
        for (const characterId of characterIds) {
            appendBindingChip(charactersList, getCharacterName(characterId), 'remove-character', characterId);
        }
    }

    const isBoundToCurrentCharacter = Boolean(currentCharacter && characterIds.includes(currentCharacter.id));
    characterButton.disabled = !currentCharacter;
    characterButton.textContent = isBoundToCurrentCharacter ? '解绑当前角色' : '绑定当前角色';
    panel.querySelector('.persona-variant-character-status').textContent = currentCharacter
        ? `当前角色：${currentCharacter.name}`
        : '当前没有单角色会话';
}

function render() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
        return;
    }

    const validPersona = isNamedExistingPersona();
    const store = getPersonaStore(user_avatar);
    const variants = store?.variants ?? [];
    const selectedCharacterId = renderCharacterContextOptions(panel);
    const visibleVariants = getVisibleVariants(variants, selectedCharacterId);
    const currentCharacter = getCurrentCharacterContext();
    const currentChat = getCurrentChatContext();
    const currentChatBinding = currentChat ? getSettings().chatBindings[currentChat.key] : null;
    const select = panel.querySelector('#persona_variant_select');
    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = validPersona ? '选择已保存的人设版本…' : '请先选择一个已命名的人设';
    select.replaceChildren(emptyOption);

    for (const variant of visibleVariants) {
        const option = document.createElement('option');
        option.value = variant.id;
        const tags = [];
        const variantCharacterIds = getVariantCharacterIds(user_avatar, variant);
        if (variantCharacterIds.length === 0) {
            tags.push('通用');
        } else if (currentCharacter && variantCharacterIds.includes(currentCharacter.id)) {
            tags.push('当前角色');
        }
        if (currentChatBinding?.avatarId === user_avatar && currentChatBinding?.variantId === variant.id) {
            tags.push('当前聊天');
        }
        option.textContent = `${getVariantLabel(variant)}${tags.length ? ` [${tags.join(' · ')}]` : ''}`;
        option.title = new Date(variant.updatedAt || variant.createdAt).toLocaleString();
        select.append(option);
    }

    select.value = visibleVariants.some(item => item.id === store?.activeId) ? store.activeId : '';
    select.disabled = !validPersona || visibleVariants.length === 0;
    const variant = visibleVariants.find(item => item.id === select.value) ?? null;
    const selectedCharacter = getSelectedCharacterTarget(panel);

    panel.querySelector('#persona_variant_save').disabled = !validPersona;
    panel.querySelector('#persona_variant_overwrite').disabled = !validPersona || !variant || getSettings().autoSaveEnabled;
    panel.querySelector('#persona_variant_rename').disabled = !validPersona || !variant;
    panel.querySelector('#persona_variant_delete').disabled = !validPersona || !variant;
    panel.querySelector('#persona_variant_auto_save').checked = Boolean(getSettings().autoSaveEnabled);
    panel.querySelector('.persona-variant-selected-context').textContent = selectedCharacterId === '__all__'
        ? '当前父级：全部版本'
        : selectedCharacterId === '__unbound__'
            ? '当前父级：未绑定角色'
            : `当前父级：${selectedCharacter?.name || getCharacterName(selectedCharacterId)}`;
    panel.querySelector('.persona-variant-scope-status').textContent = variant
        ? describeVersionScope(variant)
        : '新版本默认未绑定角色，可在下方手动绑定多个角色';

    renderCharacterBindings(panel, variant);

    const chatBindButton = panel.querySelector('#persona_variant_bind_chat');
    chatBindButton.disabled = !validPersona || !variant || !currentChat;
    chatBindButton.textContent = currentChatBinding ? '重新绑定当前聊天' : '绑定当前聊天';
    panel.querySelector('#persona_variant_unbind_chat').disabled = !currentChatBinding;
    panel.querySelector('.persona-variant-chat-status').textContent = !currentChat
        ? '当前没有可绑定的聊天'
        : currentChatBinding
            ? `当前聊天已绑定：${describeVariantBinding(currentChatBinding)}`
            : '当前聊天：未绑定（不会自动应用）';

    const hiddenCount = variants.length - visibleVariants.length;
    panel.querySelector('.persona-variants-count').textContent = !validPersona
        ? '未选择人设'
        : hiddenCount > 0
            ? `${visibleVariants.length}/${variants.length} 个版本（已隐藏 ${hiddenCount} 个）`
            : `${variants.length} 个版本`;
    const chatCount = variant ? getChatBindingsForVariant(user_avatar, variant.id).length : 0;
    panel.querySelector('.persona-variant-binding-summary').textContent = variant
        ? `已选版本：${getVariantCharacterIds(user_avatar, variant).length} 个角色 · ${chatCount} 个聊天`
        : '请选择一个可见版本';
    renderChatBindings(panel, variant);
}

function togglePanel() {
    const panel = document.getElementById(PANEL_ID);
    const button = document.getElementById('persona_variants_toggle');
    if (!panel || !button) {
        return;
    }

    const willOpen = panel.hidden;
    panel.hidden = !willOpen;
    button.classList.toggle('selected', willOpen);
    button.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) {
        render();
    }
}

async function askForName(title, defaultValue = '') {
    const value = await Popup.show.input(title, '请输入版本名称：', defaultValue);
    return typeof value === 'string' ? value.trim() : '';
}

async function saveVariant() {
    const snapshot = captureCurrentPersona();
    if (!snapshot) {
        toastr.warning('请先在用户设定管理中选择一个人设。', '人设版本管理');
        return;
    }

    const store = getPersonaStore(user_avatar, true);
    const personaName = String(power_user.personas[user_avatar] ?? 'Persona');
    const currentCharacter = getSelectedCharacterTarget(document.getElementById(PANEL_ID));
    const suggestedName = currentCharacter
        ? `${personaName} - ${currentCharacter.name} - ${store.variants.length + 1}`.trim()
        : `${personaName} - ${store.variants.length + 1}`.trim();
    const name = await askForName('保存当前人设版本', suggestedName);
    if (!name) {
        return;
    }

    const now = new Date().toISOString();
    const variant = {
        id: makeId(),
        name,
        ...snapshot,
        characterIds: currentCharacter?.id && currentCharacter.id !== '__all__' && currentCharacter.id !== '__unbound__' ? [currentCharacter.id] : [],
        createdAt: now,
        updatedAt: now,
    };
    store.variants.push(variant);
    store.activeId = variant.id;
    saveSettingsDebounced();
    render();
    toastr.success(`已保存“${name}”。`, '人设版本管理');
}

function selectedVariant() {
    const selectedId = document.querySelector('#persona_variant_select')?.value;
    const store = getPersonaStore(user_avatar);
    return store?.variants.find(item => item.id === selectedId) ?? null;
}

function rememberCharacterContext(event) {
    const value = String(event.currentTarget.value || '__all__');
    getSettings().characterContext[user_avatar] = value;
    saveSettingsDebounced();
    render();
}

function filterCharacterSearch() {
    render();
}

async function applyVariantRecord(avatarId, variantId, { notify = true, automatic = false, expectedChatKey = '' } = {}) {
    const variant = getVariant(avatarId, variantId);
    if (!variant || !isNamedExistingPersona(avatarId)) {
        return false;
    }

    if (expectedChatKey && getCurrentChatContext()?.key !== expectedChatKey) {
        return false;
    }

    if (user_avatar !== avatarId) {
        await setUserAvatar(avatarId, { toastPersonaNameChange: false, navigateToCurrent: false });
    }
    if (user_avatar !== avatarId || (expectedChatKey && getCurrentChatContext()?.key !== expectedChatKey)) {
        return false;
    }

    const descriptor = power_user.persona_descriptions[avatarId] ??= {};
    const connections = descriptor.connections;

    Object.assign(descriptor, {
        title: variant.title,
        description: variant.description,
        position: variant.position,
        depth: variant.depth,
        role: variant.role,
        lorebook: variant.lorebook,
    });
    if (connections !== undefined) {
        descriptor.connections = connections;
    }

    power_user.persona_description = variant.description;
    power_user.persona_description_position = variant.position;
    power_user.persona_description_depth = variant.depth;
    power_user.persona_description_role = variant.role;
    power_user.persona_description_lorebook = variant.lorebook;
    const store = getPersonaStore(avatarId, true);
    store.activeId = variant.id;
    saveSettingsDebounced();
    setPersonaDescription();
    refreshCurrentPersonaCard();
    if (typeof event_types.PERSONA_UPDATED === 'string') {
        await eventSource.emit(event_types.PERSONA_UPDATED, avatarId);
    }
    render();
    if (notify) {
        const message = automatic
            ? `已按聊天绑定自动应用“${getVariantLabel(variant)}”。`
            : `已应用“${getVariantLabel(variant)}”。`;
        toastr.success(message, '人设版本管理');
    }
    return true;
}

function saveCurrentToVariant(variant, notify = false) {
    const snapshot = captureCurrentPersona();
    if (!variant || !snapshot) {
        return false;
    }

    Object.assign(variant, snapshot, { updatedAt: new Date().toISOString() });
    delete variant.personaName;
    const store = getPersonaStore(user_avatar, true);
    store.activeId = variant.id;
    saveSettingsDebounced();
    render();
    if (notify) {
        toastr.success(`已用当前内容更新“${getVariantLabel(variant)}”。`, '人设版本管理');
    }
    return true;
}

function overwriteVariant() {
    saveCurrentToVariant(selectedVariant(), true);
}

function scheduleAutoSave(immediate = false) {
    clearTimeout(autoSaveTimer);
    if (!getSettings().autoSaveEnabled) {
        return;
    }
    autoSaveTimer = setTimeout(() => {
        const variant = selectedVariant();
        if (saveCurrentToVariant(variant, false)) {
            const status = document.querySelector('.persona-variant-auto-save-status');
            if (status) {
                status.textContent = `已自动保存 ${new Date().toLocaleTimeString()}`;
            }
        }
    }, immediate ? 0 : AUTO_SAVE_DELAY);
}

function onAutoSaveChanged(event) {
    getSettings().autoSaveEnabled = Boolean(event.currentTarget.checked);
    saveSettingsDebounced();
    render();
    if (getSettings().autoSaveEnabled) {
        scheduleAutoSave(true);
        toastr.success('已开启修改时自动保存；当前版本会随编辑即时更新。', '人设版本管理');
    } else {
        clearTimeout(autoSaveTimer);
        toastr.info('已关闭自动保存；修改后请点击“更新版本”。', '人设版本管理');
    }
}

async function renameVariant() {
    const variant = selectedVariant();
    if (!variant) {
        return;
    }

    const name = await askForName('重命名人设版本', getVariantLabel(variant));
    if (!name || name === variant.name) {
        return;
    }

    variant.name = name;
    variant.updatedAt = new Date().toISOString();
    saveSettingsDebounced();
    render();
}

async function deleteVariant() {
    const variant = selectedVariant();
    if (!variant) {
        return;
    }

    const confirmed = await Popup.show.confirm('删除人设版本', `确定删除“${getVariantLabel(variant)}”吗？此操作不会删除 SillyTavern 中的用户人设。`);
    if (!confirmed) {
        return;
    }

    const deletedAvatarId = user_avatar;
    const deletedVariantId = variant.id;
    const store = getPersonaStore(deletedAvatarId);
    store.variants = store.variants.filter(item => item.id !== variant.id);
    if (store.activeId === variant.id) {
        store.activeId = '';
    }
    if (store.variants.length === 0) {
        delete getSettings().personas[deletedAvatarId];
    }
    for (const [chatKey, binding] of Object.entries(getSettings().chatBindings)) {
        if (binding?.avatarId === deletedAvatarId && binding?.variantId === deletedVariantId) {
            delete getSettings().chatBindings[chatKey];
        }
    }
    saveSettingsDebounced();
    render();
}

async function onSelectionChanged(event) {
    const selectedId = event.currentTarget.value;
    const store = getPersonaStore(user_avatar);
    if (store) {
        store.activeId = selectedId;
        saveSettingsDebounced();
    }
    if (selectedId) {
        await applyVariantRecord(user_avatar, selectedId);
    } else {
        render();
    }
}

function toggleCurrentCharacterBinding() {
    const variant = selectedVariant();
    const character = getSelectedCharacterTarget(document.getElementById(PANEL_ID));
    if (!variant || !character) {
        return;
    }

    variant.characterIds ??= [];
    const index = variant.characterIds.indexOf(character.id);
    if (index >= 0) {
        variant.characterIds.splice(index, 1);
        toastr.info(`已解除“${getVariantLabel(variant)}”与角色“${character.name}”的绑定。`, '人设版本管理');
    } else {
        variant.characterIds.push(character.id);
        toastr.success(`已将“${getVariantLabel(variant)}”绑定到角色“${character.name}”。`, '人设版本管理');
    }
    variant.updatedAt = new Date().toISOString();
    saveSettingsDebounced();
    render();
}

async function bindCurrentChat() {
    const variant = selectedVariant();
    const chatContext = getCurrentChatContext();
    if (!variant || !chatContext) {
        return;
    }

    const previous = getSettings().chatBindings[chatContext.key];
    variant.characterIds ??= [];
    if (!variant.characterIds.includes(chatContext.characterId)) {
        variant.characterIds.push(chatContext.characterId);
    }
    getSettings().chatBindings[chatContext.key] = {
        avatarId: user_avatar,
        variantId: variant.id,
        characterId: chatContext.characterId,
        characterName: chatContext.characterName,
        chatId: chatContext.chatId,
        updatedAt: new Date().toISOString(),
    };
    lastAutoAppliedBinding = '';
    saveSettingsDebounced();
    const applied = await applyVariantRecord(user_avatar, variant.id, { notify: false, expectedChatKey: chatContext.key });
    if (applied) {
        lastAutoAppliedBinding = `${chatContext.key}|${user_avatar}|${variant.id}`;
    }
    render();
    toastr.success(
        previous ? `已将当前聊天重新绑定到“${getVariantLabel(variant)}”。` : `已将当前聊天绑定到“${getVariantLabel(variant)}”。`,
        '人设版本管理',
    );
}

function unbindChat(chatKey, notify = true) {
    const binding = getSettings().chatBindings[chatKey];
    if (!binding) {
        return;
    }
    delete getSettings().chatBindings[chatKey];
    lastAutoAppliedBinding = '';
    saveSettingsDebounced();
    render();
    if (notify) {
        toastr.info('已解除聊天绑定；当前版本保持不变，之后不会再自动应用。', '人设版本管理');
    }
}

function unbindCurrentChat() {
    const chatContext = getCurrentChatContext();
    if (chatContext) {
        unbindChat(chatContext.key);
    }
}

function onBindingChipClick(event) {
    const button = event.target.closest('[data-binding-action]');
    const variant = selectedVariant();
    if (!button || !variant) {
        return;
    }

    if (button.dataset.bindingAction === 'remove-character') {
        variant.characterIds = (variant.characterIds ?? []).filter(id => id !== button.dataset.bindingValue);
        variant.updatedAt = new Date().toISOString();
        saveSettingsDebounced();
        render();
    }
    if (button.dataset.bindingAction === 'remove-chat') {
        unbindChat(button.dataset.bindingValue, false);
    }
}

function mount() {
    if (document.getElementById(PANEL_ID)) {
        render();
        return true;
    }

    const controls = document.querySelector('#persona_controls');
    const renameButton = document.querySelector('#persona_rename_button');
    if (!controls || !renameButton) {
        return false;
    }

    const toggle = document.createElement('button');
    toggle.id = 'persona_variants_toggle';
    toggle.className = 'menu_button fa-solid fa-layer-group';
    toggle.type = 'button';
    toggle.title = '人设版本管理';
    toggle.setAttribute('aria-label', '人设版本管理');
    toggle.setAttribute('aria-expanded', 'false');
    renameButton.insertAdjacentElement('afterend', toggle);

    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    panel.className = 'persona-variants-panel';
    panel.hidden = true;
    panel.innerHTML = `
        <div class="persona-variants-heading">
            <span><i class="fa-solid fa-layer-group fa-fw"></i> 人设版本</span>
            <span class="persona-variants-count text_muted">0 个版本</span>
        </div>
        <div class="persona-variant-context-picker">
            <input id="persona_variant_character_search" class="text_pole" type="search" placeholder="搜索已绑定的角色…" aria-label="搜索已绑定的角色">
            <select id="persona_variant_character_context" class="text_pole" aria-label="选择角色父级"></select>
            <span class="persona-variant-selected-context text_muted">当前父级：全部版本</span>
        </div>
        <div class="persona-variants-picker">
            <select id="persona_variant_select" class="text_pole" aria-label="已保存的人设版本"></select>
        </div>
        <div class="persona-variants-actions">
            <button id="persona_variant_save" class="menu_button menu_button_icon" type="button" title="将当前人设内容保存为新版本">
                <i class="fa-solid fa-floppy-disk fa-fw"></i><span>另存版本</span>
            </button>
            <button id="persona_variant_overwrite" class="menu_button menu_button_icon" type="button" title="用当前人设内容覆盖选中的版本">
                <i class="fa-solid fa-rotate fa-fw"></i><span>更新版本</span>
            </button>
            <button id="persona_variant_rename" class="menu_button" type="button" title="重命名版本" aria-label="重命名版本">
                <i class="fa-solid fa-pencil fa-fw"></i>
            </button>
            <button id="persona_variant_delete" class="menu_button red_button" type="button" title="删除版本" aria-label="删除版本">
                <i class="fa-solid fa-trash fa-fw"></i>
            </button>
            <label class="persona-variant-auto-save checkbox_label" title="开启后，编辑当前人设会自动更新已选版本">
                <input id="persona_variant_auto_save" type="checkbox">
                <span>修改时自动保存</span>
            </label>
            <span class="persona-variant-auto-save-status text_muted"></span>
        </div>
        <div class="persona-variant-bindings">
            <div class="persona-variant-bindings-heading">
                <span><i class="fa-solid fa-link fa-fw"></i> 角色与聊天绑定</span>
                <span class="persona-variant-binding-summary text_muted">请选择一个可见版本</span>
            </div>
            <div class="persona-variant-binding-list-row">
                <span class="persona-variant-binding-label">角色范围</span>
                <div class="persona-variant-scope-status text_muted">新版本默认未绑定角色，可在下方手动绑定多个角色</div>
            </div>
            <div class="persona-variant-binding-row">
                <span class="persona-variant-character-status">当前没有单角色会话</span>
                <button id="persona_variant_bind_character" class="menu_button menu_button_icon" type="button">绑定当前角色</button>
            </div>
            <div class="persona-variant-binding-list-row">
                <span class="persona-variant-binding-label">绑定角色</span>
                <div class="persona-variant-bound-characters text_muted">选择一个版本后管理绑定</div>
            </div>
            <div class="persona-variant-binding-row">
                <span class="persona-variant-chat-status">当前没有可绑定的聊天</span>
                <div class="persona-variant-binding-buttons">
                    <button id="persona_variant_bind_chat" class="menu_button menu_button_icon" type="button">绑定当前聊天</button>
                    <button id="persona_variant_unbind_chat" class="menu_button" type="button">解除聊天绑定</button>
                </div>
            </div>
            <div class="persona-variant-binding-list-row">
                <span class="persona-variant-binding-label">绑定聊天</span>
                <div class="persona-variant-bound-chats text_muted">选择一个版本后管理绑定</div>
            </div>
        </div>`;

    controls.insertAdjacentElement('afterend', panel);
    toggle.addEventListener('click', togglePanel);
    panel.querySelector('#persona_variant_character_context').addEventListener('change', rememberCharacterContext);
    panel.querySelector('#persona_variant_character_search').addEventListener('input', filterCharacterSearch);
    panel.querySelector('#persona_variant_select').addEventListener('change', onSelectionChanged);
    panel.querySelector('#persona_variant_save').addEventListener('click', saveVariant);
    panel.querySelector('#persona_variant_overwrite').addEventListener('click', overwriteVariant);
    panel.querySelector('#persona_variant_rename').addEventListener('click', renameVariant);
    panel.querySelector('#persona_variant_delete').addEventListener('click', deleteVariant);
    panel.querySelector('#persona_variant_auto_save').addEventListener('change', onAutoSaveChanged);
    panel.querySelector('#persona_variant_bind_character').addEventListener('click', toggleCurrentCharacterBinding);
    panel.querySelector('#persona_variant_bind_chat').addEventListener('click', bindCurrentChat);
    panel.querySelector('#persona_variant_unbind_chat').addEventListener('click', unbindCurrentChat);
    panel.querySelector('.persona-variant-bindings').addEventListener('click', onBindingChipClick);
    render();
    return true;
}

function mountWhenAvailable() {
    if (mount()) {
        return;
    }

    const observer = new MutationObserver(() => {
        if (mount()) {
            observer.disconnect();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

function subscribeIfSupported(eventName, handler) {
    if (typeof eventName === 'string') {
        eventSource.on(eventName, handler);
    }
}

function onPersonaRenamed() {
    render();
}

function onPersonaUpdated() {
    render();
    scheduleAutoSave(false);
}

function onPersonaDeleted({ avatarId } = {}) {
    if (!avatarId || !getSettings().personas[avatarId]) {
        render();
        return;
    }

    delete getSettings().personas[avatarId];
    for (const [chatKey, binding] of Object.entries(getSettings().chatBindings)) {
        if (binding?.avatarId === avatarId) {
            delete getSettings().chatBindings[chatKey];
        }
    }
    saveSettingsDebounced();
    render();
}

async function autoApplyCurrentChatBinding() {
    if (autoApplyInProgress) {
        return;
    }

    const chatContext = getCurrentChatContext();
    if (!chatContext) {
        lastAutoAppliedBinding = '';
        render();
        return;
    }

    const binding = getSettings().chatBindings[chatContext.key];
    if (!binding) {
        lastAutoAppliedBinding = '';
        render();
        return;
    }

    const signature = `${chatContext.key}|${binding.avatarId}|${binding.variantId}`;
    if (lastAutoAppliedBinding === signature) {
        render();
        return;
    }

    autoApplyInProgress = true;
    try {
        const applied = await applyVariantRecord(binding.avatarId, binding.variantId, {
            notify: true,
            automatic: true,
            expectedChatKey: chatContext.key,
        });
        if (applied) {
            lastAutoAppliedBinding = signature;
        }
    } catch (error) {
        console.error('[Persona Variants] Failed to apply chat binding:', error);
        toastr.error('聊天绑定版本自动应用失败，请检查控制台。', '人设版本管理');
    } finally {
        autoApplyInProgress = false;
        render();
    }
}

function scheduleContextChange() {
    clearTimeout(contextChangeTimer);
    const current = getCurrentCharacterContext();
    if (current && document.getElementById(PANEL_ID)) {
        getSettings().characterContext[user_avatar] = current.id;
    }
    contextChangeTimer = setTimeout(autoApplyCurrentChatBinding, AUTO_APPLY_DELAY);
}

jQuery(() => {
    getSettings();
    mountWhenAvailable();
    subscribeIfSupported(event_types.PERSONA_CHANGED, render);
    subscribeIfSupported(event_types.PERSONA_UPDATED, onPersonaUpdated);
    subscribeIfSupported(event_types.PERSONA_RENAMED, onPersonaRenamed);
    subscribeIfSupported(event_types.PERSONA_DELETED, onPersonaDeleted);
    subscribeIfSupported(event_types.SETTINGS_UPDATED, render);
    subscribeIfSupported(event_types.CHAT_CHANGED, scheduleContextChange);
    subscribeIfSupported(event_types.APP_READY, scheduleContextChange);
    $(document).on('click.personaVariants', '#user_avatar_block .avatar-container', () => setTimeout(render, 0));
    $(document).on(
        'input.personaVariants change.personaVariants',
        '#persona_description, #persona_description_position, #persona_depth_value, #persona_depth_role',
        () => scheduleAutoSave(false),
    );
    scheduleContextChange();
});
