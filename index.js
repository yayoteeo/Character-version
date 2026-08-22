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
const AUTO_APPLY_DELAY = 300;
const AUTO_SAVE_DELAY = 350;

let selectedBindingCharacterId = '';
let selectedBindingContextKey = '';

let contextChangeTimer = null;
let autoSaveTimer = null;
let autoApplyInProgress = false;

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
    const settings = extension_settings[MODULE_NAME] ??= { schemaVersion: 8, personas: {}, chatBindings: {}, autoSaveEnabled: false };
    settings.schemaVersion ??= 1;
    settings.personas ??= {};
    settings.chatBindings ??= {};
    settings.autoSaveEnabled ??= false;

    if (settings.schemaVersion < 2) {
        for (const store of Object.values(settings.personas)) {
            for (const variant of store?.variants ?? []) {
                delete variant.personaName;
            }
        }
        settings.schemaVersion = 2;
    }

    if (settings.schemaVersion < 3) {
        settings.schemaVersion = 3;
    }

    if (settings.schemaVersion < 4) {
        settings.autoSaveEnabled ??= false;
        settings.schemaVersion = 4;
    }

    if (settings.schemaVersion < 5) {
        settings.schemaVersion = 5;
    }

    if (settings.schemaVersion < 6) {
        delete settings.characterContext;
        settings.schemaVersion = 6;
    }

    if (settings.schemaVersion < 7) {
        settings.chatBindings ??= {};
        settings.schemaVersion = 7;
    }

    if (settings.schemaVersion < 8) {
        settings.schemaVersion = 8;
    }

    for (const store of Object.values(settings.personas)) {
        store.activeId ??= '';
        store.variants ??= [];
        for (const variant of store.variants) {
            variant.characterIds = [...new Set((Array.isArray(variant.characterIds) ? variant.characterIds : []).map(String).filter(Boolean))];
            variant.characterNames = [...new Set((Array.isArray(variant.characterNames) ? variant.characterNames : []).map(String).filter(Boolean))];
        }
    }

    for (const [chatKey, binding] of Object.entries(settings.chatBindings)) {
        if (!binding?.avatarId || !binding?.variantId) {
            delete settings.chatBindings[chatKey];
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

function getVariant(avatarId, variantId) {
    return getPersonaStore(avatarId)?.variants.find(item => item.id === variantId) ?? null;
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

function normalizeCharacterName(name) {
    return String(name ?? '')
        .trim()
        .replace(/[（(].*?[）)]/g, '')
        .replace(/\.(png|jpg|jpeg|webp)$/i, '')
        .toLocaleLowerCase();
}

function isCharacterIdForContext(characterId, context) {
    if (!context || String(characterId) === String(context.id)) {
        return Boolean(context);
    }

    const boundCharacter = characters?.find(character => String(character?.avatar) === String(characterId));
    return Boolean(boundCharacter && normalizeCharacterName(boundCharacter.name) === normalizeCharacterName(context.name));
}

function isVariantForCharacter(variant, context) {
    if (!context) {
        return false;
    }

    return (variant.characterIds ?? []).some(id => isCharacterIdForContext(id, context))
        || (variant.characterNames ?? []).some(name => normalizeCharacterName(name) === normalizeCharacterName(context.name));
}

function getBoundCharacterOptions() {
    const store = getPersonaStore(user_avatar);
    const ids = new Set((store?.variants ?? []).flatMap(variant => variant.characterIds ?? []).map(String));
    for (const variant of store?.variants ?? []) {
        for (const name of variant.characterNames ?? []) {
            const character = characters?.find(item => normalizeCharacterName(item?.name) === normalizeCharacterName(name));
            if (character?.avatar) {
                ids.add(String(character.avatar));
            }
        }
    }
    return [...ids].map(id => ({ id, name: String(characters?.find(character => String(character?.avatar) === String(id))?.name || id) }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function getBoundVariantsForCharacter(characterId) {
    const character = characters?.find(item => String(item?.avatar) === String(characterId));
    return (getPersonaStore(user_avatar)?.variants ?? []).filter(variant =>
        (variant.characterIds ?? []).some(id => String(id) === String(characterId))
        || Boolean(character && (variant.characterNames ?? []).some(name => normalizeCharacterName(name) === normalizeCharacterName(character.name))),
    );
}

function hasCharacterBinding(variant) {
    return Boolean((variant.characterIds ?? []).length || (variant.characterNames ?? []).length);
}

function getVisibleVariants(variants) {
    const currentCharacter = getCurrentCharacterContext();
    if (!currentCharacter) {
        return variants.filter(variant => !hasCharacterBinding(variant));
    }

    return variants.filter(variant => {
        return !hasCharacterBinding(variant) || isVariantForCharacter(variant, currentCharacter);
    });
}

function getVisibleVariantGroups(variants, currentCharacter = getCurrentCharacterContext()) {
    const visibleVariants = getVisibleVariants(variants);
    if (!currentCharacter) {
        return { bound: [], generic: visibleVariants };
    }

    return {
        bound: visibleVariants.filter(variant => isVariantForCharacter(variant, currentCharacter)),
        generic: visibleVariants.filter(variant => !hasCharacterBinding(variant)),
    };
}

function getCurrentChatContext() {
    const chatId = getCurrentChatId();
    const character = characters?.[Number(this_chid)];
    if (!chatId || !character?.avatar) {
        return null;
    }

    const characterId = String(character.avatar);
    const normalizedChatId = String(chatId);
    return {
        // Chat IDs are globally unique in SillyTavern. Keeping the key independent
        // from the current character enforces one binding per chat globally.
        key: encodeURIComponent(normalizedChatId),
        chatId: normalizedChatId,
        characterId,
        characterName: String(character.name || characterId),
    };
}

function getCurrentChatBinding() {
    const context = getCurrentChatContext();
    return context ? getSettings().chatBindings[context.key] ?? null : null;
}

function isBindingForCurrentCharacter(binding, context = getCurrentChatContext()) {
    return Boolean(binding && context && isCharacterIdForContext(binding.characterId, {
        id: context.characterId,
        name: context.characterName,
    }));
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
    return variant?.name || '未命名版本';
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
    return String(characters?.find(character => character?.avatar === characterId)?.name || characterId);
}

function getSelectedBindingCharacterId() {
    return document.querySelector('#persona_variant_character_select')?.value || selectedBindingCharacterId;
}

function renderCharacterBindingBrowser(panel) {
    const characterSelect = panel.querySelector('#persona_variant_character_select');
    const boundVersions = panel.querySelector('#persona_variant_character_versions');
    const characterOptions = getBoundCharacterOptions();

    characterSelect.replaceChildren();
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = characterOptions.length ? '选择已绑定角色…' : '当前 user 尚未绑定角色';
    characterSelect.append(empty);
    for (const optionData of characterOptions) {
        const option = document.createElement('option');
        option.value = optionData.id;
        option.textContent = optionData.name;
        characterSelect.append(option);
    }

    const currentCharacter = getCurrentCharacterContext();
    const contextKey = currentCharacter
        ? `${currentCharacter.id}|${normalizeCharacterName(currentCharacter.name)}`
        : '';
    if (contextKey !== selectedBindingContextKey) {
        selectedBindingContextKey = contextKey;
        const matchingOption = currentCharacter
            ? characterOptions.find(option => isCharacterIdForContext(option.id, currentCharacter))
            : null;
        selectedBindingCharacterId = matchingOption?.id ?? '';
    }
    if (!characterOptions.some(option => option.id === selectedBindingCharacterId)) {
        const matchingOption = currentCharacter
            ? characterOptions.find(option => isCharacterIdForContext(option.id, currentCharacter))
            : null;
        selectedBindingCharacterId = matchingOption?.id ?? '';
    }
    characterSelect.value = selectedBindingCharacterId;
    boundVersions.replaceChildren();
    if (!selectedBindingCharacterId) {
        return;
    }

    const versions = getBoundVariantsForCharacter(selectedBindingCharacterId);
    if (!versions.length) {
        return;
    }
    for (const boundVariant of versions) {
        const row = document.createElement('div');
        row.className = 'persona-variant-bound-version';
        const label = document.createElement('span');
        label.textContent = getVariantLabel(boundVariant);
        row.append(label);
        boundVersions.append(row);
    }
}

function render() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
        return;
    }

    const validPersona = isNamedExistingPersona();
    const store = getPersonaStore(user_avatar);
    const variants = store?.variants ?? [];
    const currentCharacter = getCurrentCharacterContext();
    const visibleGroups = getVisibleVariantGroups(variants, currentCharacter);
    const visibleVariants = [...visibleGroups.bound, ...visibleGroups.generic];
    const chatContext = getCurrentChatContext();
    const chatBinding = getCurrentChatBinding();
    renderCharacterBindingBrowser(panel);
    const select = panel.querySelector('#persona_variant_select');
    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = validPersona ? '选择已保存的人设版本…' : '请先选择一个已命名的人设';
    select.replaceChildren(emptyOption);

    const appendOptions = (parent, source) => {
        for (const variant of source) {
            const option = document.createElement('option');
            option.value = variant.id;
            option.textContent = getVariantLabel(variant);
            option.title = new Date(variant.updatedAt || variant.createdAt).toLocaleString();
            parent.append(option);
        }
    };
    if (currentCharacter) {
        if (visibleGroups.bound.length) {
            const group = document.createElement('optgroup');
            group.label = `当前角色：${currentCharacter.name}`;
            appendOptions(group, visibleGroups.bound);
            select.append(group);
        }
        if (visibleGroups.generic.length) {
            const group = document.createElement('optgroup');
            group.label = '通用版本';
            appendOptions(group, visibleGroups.generic);
            select.append(group);
        }
    } else {
        appendOptions(select, visibleVariants);
    }

    select.value = visibleVariants.some(item => item.id === store?.activeId) ? store.activeId : '';
    select.disabled = !validPersona || visibleVariants.length === 0;
    const variant = visibleVariants.find(item => item.id === select.value) ?? null;
    panel.querySelector('#persona_variant_save').disabled = !validPersona;
    panel.querySelector('#persona_variant_overwrite').disabled = !validPersona || !variant || getSettings().autoSaveEnabled;
    panel.querySelector('#persona_variant_rename').disabled = !validPersona || !variant;
    panel.querySelector('#persona_variant_delete').disabled = !validPersona || !variant;
    panel.querySelector('#persona_variant_auto_save').checked = Boolean(getSettings().autoSaveEnabled);
    const chatBindButton = panel.querySelector('#persona_variant_bind_chat');
    const chatUnbindButton = panel.querySelector('#persona_variant_unbind_chat');
    const chatStatus = panel.querySelector('.persona-variant-chat-status');
    chatBindButton.disabled = !validPersona || !variant || !chatContext;
    const characterBindButton = panel.querySelector('#persona_variant_bind_character');
    characterBindButton.disabled = !validPersona || !variant || (!currentCharacter && !selectedBindingCharacterId);
    chatUnbindButton.disabled = !chatBinding;
    chatBindButton.textContent = chatBinding ? '重新绑定' : '绑定聊天';
    chatStatus.textContent = !chatContext
        ? '未识别聊天'
        : chatBinding
        ? `已绑定：${getVariantLabel(getVariant(chatBinding.avatarId, chatBinding.variantId))}`
            : '未绑定';
    const currentCharacterStatus = panel.querySelector('#persona_variant_current_character');
    currentCharacterStatus.textContent = currentCharacter ? currentCharacter.name : '未识别角色';
    currentCharacterStatus.classList.toggle('is-active', Boolean(currentCharacter));
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
    const personaName = String(power_user.personas[user_avatar] ?? 'Persona').trim();
    const chatContext = getCurrentChatContext();
    const selectedCharacterId = getSelectedBindingCharacterId();
    const targetCharacterId = selectedCharacterId || chatContext?.characterId || '';
    const currentCharacter = getCurrentCharacterContext();
    const targetCharacterName = targetCharacterId
        ? currentCharacter && isCharacterIdForContext(targetCharacterId, currentCharacter)
            ? currentCharacter.name
            : getCharacterName(targetCharacterId)
        : chatContext?.characterName;
    const suggestedName = targetCharacterName
        ? `${personaName} - ${targetCharacterName} -`
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
        characterIds: targetCharacterId ? [targetCharacterId] : [],
        characterNames: targetCharacterName ? [targetCharacterName] : [],
        createdAt: now,
        updatedAt: now,
    };
    store.variants.push(variant);
    store.activeId = variant.id;
    if (targetCharacterId) {
        selectedBindingCharacterId = targetCharacterId;
        selectedBindingContextKey = currentCharacter
            ? `${currentCharacter.id}|${normalizeCharacterName(currentCharacter.name)}`
            : selectedBindingContextKey;
    }
    saveSettingsDebounced();
    render();
    toastr.success(`已保存“${name}”。`, '人设版本管理');
}

function bindSelectedVariantToCurrentCharacter() {
    const variant = selectedVariant();
    const currentCharacter = getCurrentCharacterContext();
    const characterId = selectedBindingCharacterId || currentCharacter?.id;
    if (!variant || !characterId) {
        return;
    }

    const characterName = getCharacterName(characterId);
    variant.characterIds = [...new Set([...(variant.characterIds ?? []), characterId])];
    variant.characterNames = [...new Set([...(variant.characterNames ?? []), characterName])];
    variant.updatedAt = new Date().toISOString();
    saveSettingsDebounced();
    render();
    toastr.success(`已将“${getVariantLabel(variant)}”加入“${characterName}”版本库。`, '人设版本管理');
}

function selectedVariant() {
    const selectedId = document.querySelector('#persona_variant_select')?.value;
    const store = getPersonaStore(user_avatar);
    return store?.variants.find(item => item.id === selectedId) ?? null;
}

async function applyVariantRecord(avatarId, variantId, { notify = true, automatic = false } = {}) {
    const variant = getVariant(avatarId, variantId);
    if (!variant || !isNamedExistingPersona(avatarId)) {
        return false;
    }

    if (user_avatar !== avatarId) {
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
            ? `已按酒馆当前角色连接自动应用“${getVariantLabel(variant)}”。`
            : `已应用“${getVariantLabel(variant)}”。`;
        toastr.success(message, '人设版本管理');
    }
    return true;
}

async function bindCurrentChat() {
    const variant = selectedVariant();
    const chatContext = getCurrentChatContext();
    if (!variant || !chatContext) {
        return;
    }

    getSettings().chatBindings[chatContext.key] = {
        avatarId: user_avatar,
        variantId: variant.id,
        characterId: chatContext.characterId,
        characterName: chatContext.characterName,
        chatId: chatContext.chatId,
        updatedAt: new Date().toISOString(),
    };
    saveSettingsDebounced();

    await applyVariantRecord(user_avatar, variant.id, { notify: false });
    render();
    toastr.success(`当前聊天已绑定“${getVariantLabel(variant)}”。`, '人设版本管理');
}

function unbindCurrentChat() {
    const chatContext = getCurrentChatContext();
    if (!chatContext || !getSettings().chatBindings[chatContext.key]) {
        return;
    }

    delete getSettings().chatBindings[chatContext.key];
    saveSettingsDebounced();
    render();
    toastr.info('已解除当前聊天绑定；之后进入此聊天不会自动应用版本。', '人设版本管理');
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
    const store = getPersonaStore(deletedAvatarId);
    store.variants = store.variants.filter(item => item.id !== variant.id);
    if (store.activeId === variant.id) {
        store.activeId = '';
    }
    if (store.variants.length === 0) {
        delete getSettings().personas[deletedAvatarId];
    }
    for (const [chatKey, binding] of Object.entries(getSettings().chatBindings)) {
        if (binding?.avatarId === deletedAvatarId && binding?.variantId === variant.id) {
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
        </div>
        <div class="persona-variant-current-character">
            <span><i class="fa-solid fa-user fa-fw"></i> 当前角色</span>
            <span id="persona_variant_current_character" class="persona-variant-current-character-status text_muted">未识别角色</span>
        </div>
        <div class="persona-variant-character-section persona-variant-character-section-top">
            <div class="persona-variant-character-heading">
                <span><i class="fa-solid fa-user-group fa-fw"></i> 角色库</span>
            </div>
            <div class="persona-variant-character-browser">
                <div class="persona-variant-character-parent">
                    <select id="persona_variant_character_select" class="text_pole" aria-label="选择绑定角色"></select>
                </div>
                <div class="persona-variant-character-child">
                    <div class="persona-variant-character-child-heading">已绑定版本</div>
                    <div id="persona_variant_character_versions" class="persona-variant-character-versions text_muted">暂无绑定版本</div>
                </div>
            </div>
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
            <label class="persona-variant-auto-save checkbox_label" title="自动更新选中版本">
                <input id="persona_variant_auto_save" type="checkbox">
                <span>自动保存</span>
            </label>
            <span class="persona-variant-auto-save-status text_muted"></span>
        </div>
        <div class="persona-variant-chat-section">
            <div class="persona-variant-chat-heading">
                <span><i class="fa-solid fa-comments fa-fw"></i> 聊天绑定</span>
                <span class="persona-variant-chat-status text_muted">未绑定</span>
            </div>
            <div class="persona-variant-chat-actions">
                <button id="persona_variant_bind_character" class="menu_button menu_button_icon" type="button" title="将当前版本绑定到当前角色">
                    <i class="fa-solid fa-user-plus fa-fw"></i><span>绑定该角色</span>
                </button>
                <button id="persona_variant_bind_chat" class="menu_button menu_button_icon" type="button" title="将当前聊天绑定到选中的版本">
                    <i class="fa-solid fa-link fa-fw"></i><span>绑定聊天</span>
                </button>
                <button id="persona_variant_unbind_chat" class="menu_button" type="button" title="解除当前聊天的版本绑定">
                    <i class="fa-solid fa-link-slash fa-fw"></i><span>解绑</span>
                </button>
            </div>
        </div>`;

    controls.insertAdjacentElement('afterend', panel);
    toggle.addEventListener('click', togglePanel);
    panel.querySelector('#persona_variant_select').addEventListener('change', onSelectionChanged);
    panel.querySelector('#persona_variant_save').addEventListener('click', saveVariant);
    panel.querySelector('#persona_variant_overwrite').addEventListener('click', overwriteVariant);
    panel.querySelector('#persona_variant_rename').addEventListener('click', renameVariant);
    panel.querySelector('#persona_variant_delete').addEventListener('click', deleteVariant);
    panel.querySelector('#persona_variant_auto_save').addEventListener('change', onAutoSaveChanged);
    panel.querySelector('#persona_variant_bind_character').addEventListener('click', bindSelectedVariantToCurrentCharacter);
    panel.querySelector('#persona_variant_bind_chat').addEventListener('click', bindCurrentChat);
    panel.querySelector('#persona_variant_unbind_chat').addEventListener('click', unbindCurrentChat);
    panel.querySelector('#persona_variant_character_select').addEventListener('change', (event) => {
        selectedBindingCharacterId = event.currentTarget.value;
        render();
    });
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

function onPersonaChanged() {
    selectedBindingCharacterId = '';
    selectedBindingContextKey = '';
    scheduleContextChange();
}

function onPersonaDeleted({ avatarId } = {}) {
    if (!avatarId || !getSettings().personas[avatarId]) {
        render();
        return;
    }

    delete getSettings().personas[avatarId];
    saveSettingsDebounced();
    render();
}

async function applyCurrentChatBinding() {
    if (autoApplyInProgress) {
        return;
    }

    const chatContext = getCurrentChatContext();
    const binding = getCurrentChatBinding();
    if (!chatContext || !binding || !isBindingForCurrentCharacter(binding, chatContext)) {
        if (binding && !isBindingForCurrentCharacter(binding, chatContext)) {
            console.warn('[Persona Variants] Ignored a chat binding whose character no longer matches the current chat.');
        }
        render();
        return;
    }

    autoApplyInProgress = true;
    try {
        if (user_avatar !== binding.avatarId) {
            await setUserAvatar(binding.avatarId, { toastPersonaNameChange: false, navigateToCurrent: false });
        }
        await applyVariantRecord(binding.avatarId, binding.variantId, { notify: true, automatic: true });
    } catch (error) {
        console.error('[Persona Variants] Failed to apply current chat binding:', error);
    } finally {
        autoApplyInProgress = false;
        render();
    }
}

function scheduleContextChange() {
    clearTimeout(contextChangeTimer);
    contextChangeTimer = setTimeout(applyCurrentChatBinding, AUTO_APPLY_DELAY);
}

jQuery(() => {
    getSettings();
    mountWhenAvailable();
    subscribeIfSupported(event_types.PERSONA_UPDATED, onPersonaUpdated);
    subscribeIfSupported(event_types.PERSONA_RENAMED, onPersonaRenamed);
    subscribeIfSupported(event_types.PERSONA_DELETED, onPersonaDeleted);
    subscribeIfSupported(event_types.SETTINGS_UPDATED, render);
    subscribeIfSupported(event_types.CHAT_CHANGED, scheduleContextChange);
    subscribeIfSupported(event_types.APP_READY, scheduleContextChange);
    subscribeIfSupported(event_types.PERSONA_CHANGED, onPersonaChanged);
    subscribeIfSupported(event_types.CHARACTER_PAGE_LOADED, scheduleContextChange);
    subscribeIfSupported(event_types.CHARACTER_EDITED, scheduleContextChange);
    subscribeIfSupported(event_types.CHARACTER_RENAMED, scheduleContextChange);
    subscribeIfSupported(event_types.CHARACTER_DELETED, scheduleContextChange);
    $(document).on('click.personaVariants', '#user_avatar_block .avatar-container', () => setTimeout(render, 0));
    $(document).on(
        'input.personaVariants change.personaVariants',
        '#persona_description, #persona_description_position, #persona_depth_value, #persona_depth_role',
        () => scheduleAutoSave(false),
    );
    scheduleContextChange();
});
