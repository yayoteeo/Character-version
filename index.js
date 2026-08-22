import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    setUserName,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import {
    getUserAvatars,
    persona_description_positions,
    setPersonaDescription,
    user_avatar,
} from '../../../personas.js';
import { power_user } from '../../../power-user.js';
import { Popup } from '../../../popup.js';

const MODULE_NAME = 'persona-variants';
const PANEL_ID = 'persona_variants_panel';
const DEFAULT_DEPTH = 2;
const DEFAULT_ROLE = 0;

function makeId() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getSettings() {
    const settings = extension_settings[MODULE_NAME] ??= { schemaVersion: 1, personas: {} };
    settings.schemaVersion ??= 1;
    settings.personas ??= {};
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

function captureCurrentPersona() {
    if (!user_avatar || !power_user.personas?.[user_avatar]) {
        return null;
    }

    const descriptor = power_user.persona_descriptions?.[user_avatar] ?? {};
    return {
        personaName: String(power_user.personas[user_avatar] ?? ''),
        title: String(descriptor.title ?? ''),
        description: String(descriptor.description ?? power_user.persona_description ?? ''),
        position: Number(descriptor.position ?? power_user.persona_description_position ?? persona_description_positions.IN_PROMPT),
        depth: Number(descriptor.depth ?? power_user.persona_description_depth ?? DEFAULT_DEPTH),
        role: Number(descriptor.role ?? power_user.persona_description_role ?? DEFAULT_ROLE),
        lorebook: String(descriptor.lorebook ?? power_user.persona_description_lorebook ?? ''),
    };
}

function getVariantLabel(variant) {
    return variant.name || variant.personaName || '未命名版本';
}

function render() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
        return;
    }

    const validPersona = Boolean(user_avatar && power_user.personas?.[user_avatar]);
    const store = getPersonaStore(user_avatar);
    const variants = store?.variants ?? [];
    const select = panel.querySelector('#persona_variant_select');
    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = validPersona ? '选择已保存的人设版本…' : '请先选择一个用户人设';
    select.replaceChildren(emptyOption);

    for (const variant of variants) {
        const option = document.createElement('option');
        option.value = variant.id;
        option.textContent = getVariantLabel(variant);
        option.title = `${variant.personaName || '未命名人设'} · ${new Date(variant.updatedAt || variant.createdAt).toLocaleString()}`;
        select.append(option);
    }

    select.value = variants.some(item => item.id === store?.activeId) ? store.activeId : '';
    select.disabled = !validPersona || variants.length === 0;
    panel.querySelector('#persona_variant_save').disabled = !validPersona;
    panel.querySelector('#persona_variant_apply').disabled = !validPersona || !select.value;
    panel.querySelector('#persona_variant_overwrite').disabled = !validPersona || !select.value;
    panel.querySelector('#persona_variant_rename').disabled = !validPersona || !select.value;
    panel.querySelector('#persona_variant_delete').disabled = !validPersona || !select.value;
    panel.querySelector('.persona-variants-count').textContent = validPersona ? `${variants.length} 个版本` : '未选择人设';
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
    const suggestedName = `${snapshot.personaName} ${store.variants.length + 1}`.trim();
    const name = await askForName('保存当前人设版本', suggestedName);
    if (!name) {
        return;
    }

    const now = new Date().toISOString();
    const variant = { id: makeId(), name, ...snapshot, createdAt: now, updatedAt: now };
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

async function applyVariant() {
    const variant = selectedVariant();
    if (!variant || !user_avatar || !power_user.personas?.[user_avatar]) {
        return;
    }

    const oldName = power_user.personas[user_avatar];
    const descriptor = power_user.persona_descriptions[user_avatar] ??= {};
    const connections = descriptor.connections;

    power_user.personas[user_avatar] = variant.personaName;
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
    setUserName(variant.personaName, { toastPersonaNameChange: false });

    const store = getPersonaStore(user_avatar, true);
    store.activeId = variant.id;
    saveSettingsDebounced();
    await getUserAvatars(true, user_avatar);
    setPersonaDescription();

    if (oldName !== variant.personaName) {
        await eventSource.emit(event_types.PERSONA_RENAMED, {
            avatarId: user_avatar,
            oldName,
            newName: variant.personaName,
        });
    }
    await eventSource.emit(event_types.PERSONA_UPDATED, user_avatar);
    render();
    toastr.success(`已应用“${getVariantLabel(variant)}”。`, '人设版本管理');
}

async function overwriteVariant() {
    const variant = selectedVariant();
    const snapshot = captureCurrentPersona();
    if (!variant || !snapshot) {
        return;
    }

    Object.assign(variant, snapshot, { updatedAt: new Date().toISOString() });
    const store = getPersonaStore(user_avatar, true);
    store.activeId = variant.id;
    saveSettingsDebounced();
    render();
    toastr.success(`已用当前内容更新“${getVariantLabel(variant)}”。`, '人设版本管理');
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

    const store = getPersonaStore(user_avatar);
    store.variants = store.variants.filter(item => item.id !== variant.id);
    if (store.activeId === variant.id) {
        store.activeId = '';
    }
    if (store.variants.length === 0) {
        delete getSettings().personas[user_avatar];
    }
    saveSettingsDebounced();
    render();
}

function onSelectionChanged(event) {
    const selectedId = event.currentTarget.value;
    const store = getPersonaStore(user_avatar);
    if (store) {
        store.activeId = selectedId;
        saveSettingsDebounced();
    }
    render();
}

function mount() {
    if (document.getElementById(PANEL_ID)) {
        render();
        return;
    }

    const controls = document.querySelector('#persona_controls');
    const renameButton = document.querySelector('#persona_rename_button');
    if (!controls || !renameButton) {
        return;
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
        <div class="persona-variants-picker">
            <select id="persona_variant_select" class="text_pole" aria-label="已保存的人设版本"></select>
            <button id="persona_variant_apply" class="menu_button menu_button_icon" type="button" title="应用选中的版本">
                <i class="fa-solid fa-play fa-fw"></i><span>应用</span>
            </button>
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
        </div>`;

    controls.insertAdjacentElement('afterend', panel);
    toggle.addEventListener('click', togglePanel);
    panel.querySelector('#persona_variant_select').addEventListener('change', onSelectionChanged);
    panel.querySelector('#persona_variant_save').addEventListener('click', saveVariant);
    panel.querySelector('#persona_variant_apply').addEventListener('click', applyVariant);
    panel.querySelector('#persona_variant_overwrite').addEventListener('click', overwriteVariant);
    panel.querySelector('#persona_variant_rename').addEventListener('click', renameVariant);
    panel.querySelector('#persona_variant_delete').addEventListener('click', deleteVariant);
    render();
}

function onPersonaRenamed() {
    render();
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

jQuery(() => {
    getSettings();
    mount();
    eventSource.on(event_types.PERSONA_CHANGED, render);
    eventSource.on(event_types.PERSONA_UPDATED, render);
    eventSource.on(event_types.PERSONA_RENAMED, onPersonaRenamed);
    eventSource.on(event_types.PERSONA_DELETED, onPersonaDeleted);
    eventSource.on(event_types.SETTINGS_UPDATED, render);
});
