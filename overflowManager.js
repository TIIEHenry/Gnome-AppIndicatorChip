/* exported OverflowManager, placeIcon, overflowKey */

const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const St = imports.gi.St;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const ExtensionUtils = imports.misc.extensionUtils;
const Extension = ExtensionUtils.getCurrentExtension();

const IndicatorStatusIcon = Extension.imports.indicatorStatusIcon;
const SettingsManager = Extension.imports.settingsManager;
const SystemStats = Extension.imports.systemStats;
const Util = Extension.imports.util;

const _ = imports.gettext.domain(Extension.metadata['gettext-domain']).gettext;

const { panelActor } = IndicatorStatusIcon;

const OVERFLOW_ROLE = 'appindicator-overflow';

const STATS_INTERVAL_SECONDS = 2;
// Readings are padded with the figure space, which is as wide as a digit, so
// that the label keeps one width and the panel never shifts around. Only the
// two digits a reading almost always has are reserved: a full 100 is rare
// enough that widening the label for it beats padding every other reading.
const FIGURE_SPACE = '\u2007';
const THIN_SPACE = '\u2009';

// Tray icons are remembered so that they can be pinned while not running, but
// the list must not grow without bounds.
const MAX_REMEMBERED_ICONS = 100;

let overflowManager;

// The key identifies an application rather than a single icon, so that a
// pinned application stays pinned across restarts. It is cached because it has
// to stay stable for the whole lifetime of an icon, including while the icon is
// being destroyed and its actor is already gone.
function overflowKey(statusIcon) {
    if (!statusIcon._overflowKey) {
        if (statusIcon._indicator && statusIcon._indicator.id)
            statusIcon._overflowKey = String(statusIcon._indicator.id);
        else if (statusIcon.icon && statusIcon.icon.wm_class)
            statusIcon._overflowKey = `legacy:${statusIcon.icon.wm_class}`;
        else
            statusIcon._overflowKey = statusIcon.uniqueId;
    }

    return statusIcon._overflowKey;
}

function formatUsage(usage, unit) {
    const value = usage === null ? '--' : String(Math.round(usage * 100));
    return `${value.padStart(2, FIGURE_SPACE)}${THIN_SPACE}${unit}`;
}

function displayName(statusIcon, key) {
    if (statusIcon && statusIcon._indicator) {
        const title = statusIcon._indicator.title;
        if (title)
            return title;
        if (statusIcon._indicator.id)
            return String(statusIcon._indicator.id).replace(/^tray-icon tray app /, '');
    }

    if (statusIcon && statusIcon.icon && statusIcon.icon.wm_class)
        return statusIcon.icon.wm_class;

    return String(key || '').replace(/^tray-icon tray app /, '').replace(/^legacy:/, '') ||
        _('Unknown icon');
}

function placeIcon(statusIcon) {
    OverflowManager.getDefault().register(statusIcon);
}

var OverflowManager = class AppIndicatorsOverflowManager {
    static getDefault() {
        if (!overflowManager)
            overflowManager = new OverflowManager();
        return overflowManager;
    }

    static peek() {
        return overflowManager;
    }

    static destroy() {
        if (!overflowManager)
            return;
        overflowManager._destroy();
        overflowManager = null;
    }

    constructor() {
        if (overflowManager)
            throw new Error('OverflowManager is already constructed');

        // Keyed by uniqueId: two instances of the same application share an
        // overflow key, but they are distinct icons.
        this._icons = new Map();
        this._settings = SettingsManager.getDefaultGSettings();
        this._managing = false;
        this._menuSourceIcon = null;
        this._parkedMenuSource = null;
        this._onlyRunning = this._settings.get_boolean('overflow-manage-only-running');
        // Sizes are in CSS pixels and scaled where actor geometry is set, so
        // that every cell keeps the same size on HiDPI displays.
        this._iconsPerRow = 4;
        this._cellSize = 36;
        this._overflowIconSize = 16;
        this._cellSpacing = 4;
        this._gridLayout = new Clutter.GridLayout({
            column_homogeneous: true,
            row_homogeneous: true,
        });
        this._hiddenGrid = new St.Widget({
            style_class: 'appindicator-overflow-box',
            layout_manager: this._gridLayout,
            x_expand: false,
            y_expand: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._emptyLabel = new St.Label({
            text: _('No icons in the overflow'),
            style_class: 'appindicator-overflow-empty',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._applyGridSpacing();

        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._scaleChangedId = this._themeContext.connect('notify::scale-factor', () => {
            this._applyGridSpacing();
            this._applyOverflowBoxOrder();
        });

        this._button = new OverflowButton(this);
        IndicatorStatusIcon.addIconToPanelRole(this._button, OVERFLOW_ROLE);

        this._settingsIds = [
            this._settings.connect('changed::overflow-enabled', () => this._replaceAll()),
            this._settings.connect('changed::overflow-hide-new', () => this._replaceAll()),
            this._settings.connect('changed::overflow-pinned-ids', () => this._replaceAll()),
            this._settings.connect('changed::overflow-icon-order', () => this._applyOrder()),
            this._settings.connect('changed::overflow-button-side', () => this._applyOrder()),
        ];

        this._refreshPopupActors();
    }

    register(statusIcon) {
        const key = overflowKey(statusIcon);
        // uniqueId is read upfront: a legacy icon drops its actor before the
        // destroy handler runs, and cannot report it anymore.
        const { uniqueId } = statusIcon;
        this._icons.set(uniqueId, statusIcon);
        this._remember(key, displayName(statusIcon, key));
        this._ensureInOrder(key);

        Util.connectSmart(statusIcon, 'notify::visible', this, () => {
            if (!this._button)
                return;
            if (this._managing)
                this._button.rebuildManageList();
            else if (this._button.menu.isOpen)
                this._showHiddenIcons();
        });

        Util.connectSmart(statusIcon, 'destroy', this, () => {
            this._icons.delete(uniqueId);
            if (this._parkedMenuSource === statusIcon)
                this._parkedMenuSource = null;
            if (this._menuSourceIcon === statusIcon)
                this._menuSourceIcon = null;
            this._refreshPopupActors();
            if (this._managing)
                this._button.rebuildManageList();
        });

        if (!this._settings.get_boolean('overflow-hide-new') && !this.isKeyPinned(key))
            this.pinKey(key);

        this._place(statusIcon);
    }

    _iconsForKey(key) {
        return [...this._icons.values()].filter(icon => overflowKey(icon) === key);
    }

    _iconForKey(key) {
        return this._iconsForKey(key)[0] || null;
    }

    isHidden(statusIcon) {
        if (!this._settings.get_boolean('overflow-enabled'))
            return false;

        return !this._settings.get_strv('overflow-pinned-ids').includes(overflowKey(statusIcon));
    }

    isKeyPinned(key) {
        return this._settings.get_strv('overflow-pinned-ids').includes(key);
    }

    pin(statusIcon) {
        this.pinKey(overflowKey(statusIcon));
    }

    hide(statusIcon) {
        this.hideKey(overflowKey(statusIcon));
    }

    pinKey(key) {
        const pinned = this._settings.get_strv('overflow-pinned-ids');
        if (pinned.includes(key))
            return;
        pinned.push(key);
        this._settings.set_strv('overflow-pinned-ids', pinned);
    }

    hideKey(key) {
        const pinned = this._settings.get_strv('overflow-pinned-ids').filter(id => id !== key);
        this._settings.set_strv('overflow-pinned-ids', pinned);
    }

    setPinned(key, pinned) {
        if (pinned)
            this.pinKey(key);
        else
            this.hideKey(key);
    }

    _remember(key, title) {
        // Move the icon to the end so that eviction drops the least recently
        // seen entries first.
        const known = this._settings.get_value('overflow-known-ids').deep_unpack();
        const previous = known.find(([id]) => id === key);
        const next = known.filter(([id]) => id !== key);
        next.push([key, title || (previous && previous[1]) || key]);

        const keep = new Set(this._settings.get_strv('overflow-pinned-ids'));
        this._icons.forEach(icon => keep.add(overflowKey(icon)));
        while (next.length > MAX_REMEMBERED_ICONS) {
            const stale = next.findIndex(([id]) => !keep.has(id));
            if (stale < 0)
                break;
            next.splice(stale, 1);
        }

        this._settings.set_value('overflow-known-ids', new GLib.Variant('a(ss)', next));
    }

    listManagedEntries() {
        const names = new Map();
        this._settings.get_value('overflow-known-ids').deep_unpack().forEach(([id, name]) => {
            names.set(id, name);
        });
        this._icons.forEach(icon => {
            const key = overflowKey(icon);
            names.set(key, displayName(icon, key));
        });
        this._settings.get_strv('overflow-pinned-ids').forEach(id => {
            if (!names.has(id))
                names.set(id, displayName(null, id));
        });

        const order = this.orderedKeys();
        return [...names.entries()]
            .map(([id, name]) => ({
                id,
                name,
                pinned: this.isKeyPinned(id),
                live: !!this._iconForKey(id),
            }))
            .sort((a, b) => {
                const ai = order.indexOf(a.id);
                const bi = order.indexOf(b.id);
                return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
            });
    }

    _knownKeys() {
        const known = new Set(this._settings.get_value('overflow-known-ids')
            .deep_unpack().map(([id]) => id));
        this._settings.get_strv('overflow-pinned-ids').forEach(id => known.add(id));
        this._icons.forEach(icon => known.add(overflowKey(icon)));
        return known;
    }

    orderedKeys() {
        const stored = this._settings.get_strv('overflow-icon-order');
        const known = this._knownKeys();
        const extras = [...known].filter(id => !stored.includes(id));
        return stored.filter(id => known.has(id)).concat(extras);
    }

    _ensureInOrder(key) {
        const order = this._settings.get_strv('overflow-icon-order');
        if (order.includes(key))
            return;

        // Also drop the keys that have meanwhile been evicted from the
        // remembered list, so that the order does not grow forever.
        const known = this._knownKeys();
        this._settings.set_strv('overflow-icon-order',
            order.filter(id => known.has(id)).concat([key]));
    }

    moveKey(key, delta, visibleIds = null) {
        const order = this.orderedKeys();
        const from = order.indexOf(key);
        let to = from + delta;

        if (visibleIds && visibleIds.length) {
            const visible = visibleIds.filter(id => order.includes(id));
            const visIndex = visible.indexOf(key);
            const visNext = visIndex + delta;
            if (visIndex < 0 || visNext < 0 || visNext >= visible.length)
                return;
            to = order.indexOf(visible[visNext]);
        }

        if (from < 0 || to < 0 || to >= order.length)
            return;

        order.splice(from, 1);
        order.splice(to, 0, key);
        this._settings.set_strv('overflow-icon-order', order);
        this._applyOrder();
        if (this._managing)
            this._button.rebuildManageList();
    }

    _place(statusIcon) {
        if (this.isHidden(statusIcon))
            this._moveToOverflow(statusIcon);
        else
            this._moveToPanel(statusIcon);

        this._refreshPopupActors();
        this._applyOrder();
    }

    _replaceAll() {
        this._icons.forEach(icon => this._place(icon));
        if (this._managing && this._button && this._button.menu.isOpen)
            this._button.rebuildManageList();
    }

    _moveToPanel(statusIcon) {
        this._clearOverflowCellStyle(statusIcon);
        this._resetActorGeometry(panelActor(statusIcon));

        // addToStatusArea() reparents the icon on its own, so the icon must not
        // be detached here: doing so would leave its wrapper bin behind empty.
        if (Main.panel.statusArea[`appindicator-${statusIcon.uniqueId}`] === statusIcon &&
            this._isInPanel(statusIcon))
            return;

        IndicatorStatusIcon.addIconToPanel(statusIcon);
    }

    _isInPanel(statusIcon) {
        const parent = panelActor(statusIcon).get_parent();
        return !!parent && [Main.panel._leftBox, Main.panel._centerBox,
            Main.panel._rightBox].includes(parent);
    }

    _moveToOverflow(statusIcon) {
        IndicatorStatusIcon.removeIconFromPanel(statusIcon);

        if (!this._isInOverflow(statusIcon) && !this._isEmbeddedInList(statusIcon))
            this._unparent(panelActor(statusIcon));

        if (this._button.menu.isOpen && !this._managing)
            this._relayoutHiddenIcons();
    }

    _isInOverflow(statusIcon) {
        const parent = panelActor(statusIcon).get_parent();
        if (!parent)
            return false;
        if (parent === this._hiddenGrid)
            return true;
        return parent.get_parent() === this._hiddenGrid;
    }

    _scaleFactor() {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    _applyGridSpacing() {
        const spacing = this._cellSpacing * this._scaleFactor();
        this._gridLayout.column_spacing = spacing;
        this._gridLayout.row_spacing = spacing;
    }

    _relayoutHiddenIcons() {
        const icons = this._hiddenIcons().filter(icon =>
            icon !== this._parkedMenuSource && icon !== this._menuSourceIcon);
        this._unparentHiddenIcons();
        this._unparent(this._emptyLabel);

        if (!icons.length) {
            this._gridLayout.attach(this._emptyLabel, 0, 0, 1, 1);
            return;
        }

        icons.forEach((icon, index) => {
            const col = index % this._iconsPerRow;
            const row = Math.floor(index / this._iconsPerRow);

            this._applyOverflowCellStyle(icon);
            const actor = panelActor(icon);
            this._unparent(actor);
            this._gridLayout.attach(this._wrapOverflowCell(actor), col, row, 1, 1);
        });
    }

    _wrapOverflowCell(actor) {
        const size = this._cellSize * this._scaleFactor();
        const bin = new St.Bin({
            style_class: 'appindicator-overflow-cell',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            clip_to_allocation: true,
        });
        bin.set({
            width: size,
            height: size,
            xExpand: false,
            yExpand: false,
        });
        bin.set_child(actor);
        return bin;
    }

    // St.Bin keeps its own reference to its child, so taking the child away
    // behind its back leaves it pointing at a foreign actor.
    _unparent(actor) {
        const parent = actor.get_parent();
        if (!parent)
            return;

        if (parent.get_child && parent.get_child() === actor)
            parent.set_child(null);
        else
            parent.remove_child(actor);
    }

    _resetActorGeometry(actor) {
        // set_position() turns fixed positioning on, so drop the flag after it.
        actor.set_position(0, 0);
        actor.set_fixed_position_set(false);
    }

    _applyOverflowCellStyle(actor) {
        this._unmanageMenu(actor.menu);
        this._connectCellFeedback(actor);
        this._applyCellGeometry(actor, this._cellSize, this._overflowIconSize,
            'appindicator-overflow-item');
    }

    // A tray icon is a plain widget rather than a button, so the pressed state
    // the stylesheet draws has to be maintained by hand.
    _connectCellFeedback(statusIcon) {
        if (statusIcon._overflowFeedbackIds)
            return;

        const setPressed = pressed => {
            if (pressed)
                statusIcon.add_style_pseudo_class('active');
            else
                statusIcon.remove_style_pseudo_class('active');
            return Clutter.EVENT_PROPAGATE;
        };

        statusIcon._overflowFeedbackIds = [
            statusIcon.connect('button-press-event', () => setPressed(true)),
            statusIcon.connect('button-release-event', () => setPressed(false)),
            statusIcon.connect('leave-event', () => setPressed(false)),
        ];
    }

    _disconnectCellFeedback(statusIcon) {
        if (!statusIcon._overflowFeedbackIds)
            return;

        statusIcon._overflowFeedbackIds.forEach(id => statusIcon.disconnect(id));
        delete statusIcon._overflowFeedbackIds;
        statusIcon.remove_style_pseudo_class('active');
    }

    // The cell is sized in stage pixels while the icon inside it is sized in
    // CSS pixels, which is what the icon actors themselves work with.
    _applyCellGeometry(actor, cellSize, iconSize, styleClass) {
        const size = cellSize * this._scaleFactor();
        this._resetActorGeometry(actor);
        actor.add_style_class_name(styleClass);
        actor.set_x_expand(false);
        actor.set_y_expand(false);
        actor.set_x_align(Clutter.ActorAlign.CENTER);
        actor.set_y_align(Clutter.ActorAlign.CENTER);
        actor.set_style(
            '-natural-hpadding: 0px; -minimum-hpadding: 0px; padding: 0; margin: 0;');
        actor.set({
            width: size,
            height: size,
            clipToAllocation: true,
        });
        if (actor.setForcedIconSize)
            actor.setForcedIconSize(iconSize);
    }

    _clearOverflowCellStyle(actor) {
        this._disconnectCellFeedback(actor);
        actor.remove_style_class_name('appindicator-overflow-item');
        actor.remove_style_class_name('appindicator-overflow-list-icon');
        actor.clip_to_allocation = false;
        // Clearing the size also clears the minimum size; setting a minimum of
        // zero instead would let a crowded panel squeeze the icon to nothing.
        actor.set_size(-1, -1);

        if (actor.setForcedIconSize)
            actor.setForcedIconSize(null);

        if (actor._updateSpacing)
            actor._updateSpacing();
        else
            actor.set_style(null);
    }

    _applyOrder() {
        this._applyPanelOrder();
        this._applyOverflowBoxOrder();
    }

    _applyPanelOrder() {
        if (!this._button)
            return;

        const buttonActor = panelActor(this._button);
        const parent = buttonActor.get_parent();
        if (!parent)
            return;

        const pinnedIcons = this.orderedKeys()
            .flatMap(key => this._iconsForKey(key))
            .filter(icon => !this.isHidden(icon))
            .filter(icon => panelActor(icon).get_parent() === parent);

        const pinned = pinnedIcons.map(icon => panelActor(icon));
        const group = this._settings.get_string('overflow-button-side') === 'end'
            ? [...pinned, buttonActor] : [buttonActor, ...pinned];
        const children = parent.get_children();
        let start = Math.min(...group.map(actor => children.indexOf(actor)));
        group.forEach(actor => {
            parent.set_child_at_index(actor, start);
            start += 1;
        });

        // A legacy tray icon is an X window that is moved by the shell only
        // while the icon actor itself is allocated, and reordering the panel
        // leaves that actor with an unchanged allocation of its own.
        pinnedIcons.forEach(icon => {
            if (icon._icon)
                icon._icon.queue_relayout();
        });
    }

    _applyOverflowBoxOrder() {
        if (this._button && this._button.menu.isOpen && !this._managing)
            this._relayoutHiddenIcons();
    }

    onMenuOpenChanged(open) {
        if (open) {
            if (this._parkedMenuSource)
                this._unparkMenuSource(this._parkedMenuSource);
            const manage = this._button._openMode === 'manage';
            this._button._openMode = 'icons';
            this.setManaging(manage);
        } else {
            const keep = this._menuSourceIcon;
            this.releaseEmbeddedIcons();
            this._managing = false;
            this._unparentHiddenIcons();
            if (keep)
                this._parkMenuSource(keep);
        }
    }

    _isEmbeddedInList(statusIcon) {
        const parent = panelActor(statusIcon).get_parent();
        return this._managing && !!parent && !this._isInOverflow(statusIcon);
    }

    releaseEmbeddedIcons() {
        this._icons.forEach(icon => {
            if (icon === this._parkedMenuSource || icon === this._menuSourceIcon)
                return;
            if (this._isInOverflow(icon))
                return;
            if (Main.panel.statusArea[`appindicator-${icon.uniqueId}`] === icon)
                return;
            this._unparent(panelActor(icon));
        });
    }

    isOverflowSource(statusIcon) {
        return this._isInOverflow(statusIcon) ||
            this._isEmbeddedInList(statusIcon) ||
            this._parkedMenuSource === statusIcon;
    }

    // An icon shown inside our popup must be unknown to the panel's menu
    // manager: entering it with the pointer would otherwise make the manager
    // switch to its menu, closing the popup right under the cursor.
    _unmanageMenu(menu) {
        const manager = Main.panel.menuManager;
        if (!menu || !manager || manager.activeMenu === menu)
            return;

        try {
            manager.removeMenu(menu);
        } catch (e) {
            // Unregistering can make the shell drop a grab that is not the top
            // one; the source events we care about are disconnected by then.
        }
    }

    _ensureMenuManaged(menu) {
        if (!menu || !Main.panel.menuManager)
            return;
        try {
            Main.panel.menuManager.removeMenu(menu);
        } catch (e) {
        }
        Main.panel.menuManager.addMenu(menu);
    }

    _parkMenuSource(statusIcon) {
        if (!statusIcon)
            return;

        const actor = panelActor(statusIcon);

        // Already parked: the reparenting has not been laid out yet, so reading
        // the anchor again would yield an empty transform and drop the menu in
        // the top left corner of the screen.
        if (this._parkedMenuSource === statusIcon &&
            actor.get_parent() === Main.layoutManager.uiGroup)
            return;

        let [x, y] = [0, 0];
        const parkedSize = this._cellSize * this._scaleFactor();
        let [w, h] = [parkedSize, parkedSize];

        // An icon that is off stage, or that has just been reparented and has
        // no allocation yet, reports the stage origin; the overflow button is
        // then the only anchor that can keep the menu next to the tray.
        for (const anchor of [actor, panelActor(this._button)]) {
            if (!anchor || !anchor.get_parent())
                continue;

            const [ax, ay] = anchor.get_transformed_position();
            if (!ax && !ay)
                continue;

            [x, y] = [ax, ay];
            const [aw, ah] = anchor.get_transformed_size();
            if (aw > 0 && ah > 0)
                [w, h] = [aw, ah];
            break;
        }

        if (actor.get_parent() !== Main.layoutManager.uiGroup) {
            this._unparent(actor);
            Main.layoutManager.uiGroup.add_child(actor);
        }

        actor.opacity = 0;
        actor.visible = true;
        actor.set_position(Math.round(x), Math.round(y));
        actor.set_size(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
        this._parkedMenuSource = statusIcon;
        this._menuSourceIcon = statusIcon;

        if (statusIcon.menu && !statusIcon._overflowMenuCloseId) {
            statusIcon._overflowMenuCloseId = statusIcon.menu.connect(
                'open-state-changed', (_menu, open) => {
                    if (open)
                        return;
                    if (statusIcon._overflowMenuCloseId && statusIcon.menu) {
                        statusIcon.menu.disconnect(statusIcon._overflowMenuCloseId);
                        delete statusIcon._overflowMenuCloseId;
                    }
                    this._unparkMenuSource(statusIcon);
                });
        }
    }

    _unparkMenuSource(statusIcon) {
        if (this._parkedMenuSource !== statusIcon && this._menuSourceIcon !== statusIcon)
            return;

        if (this._parkedMenuSource === statusIcon)
            this._parkedMenuSource = null;
        if (this._menuSourceIcon === statusIcon)
            this._menuSourceIcon = null;

        const actor = panelActor(statusIcon);
        actor.opacity = 255;
        if (actor.get_parent() === Main.layoutManager.uiGroup)
            Main.layoutManager.uiGroup.remove_child(actor);

        actor.set_size(-1, -1);
        this._resetActorGeometry(actor);
        this._clearOverflowCellStyle(statusIcon);

        if (statusIcon.menu && Main.panel.menuManager && this.isHidden(statusIcon)) {
            try {
                Main.panel.menuManager.removeMenu(statusIcon.menu);
            } catch (e) {
            }
        }
    }

    openIconMenu(statusIcon) {
        if (!statusIcon)
            return;

        this._menuSourceIcon = statusIcon;
        this._parkMenuSource(statusIcon);

        if (statusIcon.menu)
            this._ensureMenuManaged(statusIcon.menu);

        const menu = statusIcon.menu;
        const openMenu = () => {
            if (menu && !menu.isOpen)
                menu.open();

            // A menu that refuses to open would leave its invisible source
            // actor parked on top of the screen, eating every click on it.
            if (!menu || !menu.isOpen)
                this._unparkMenuSource(statusIcon);
        };

        if (this._button && this._button.menu.isOpen) {
            const overflowMenu = this._button.menu;
            const id = overflowMenu.connect('open-state-changed', (_m, open) => {
                if (open)
                    return;
                overflowMenu.disconnect(id);
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    openMenu();
                    return GLib.SOURCE_REMOVE;
                });
            });
            overflowMenu.close();
            return;
        }

        if (menu) {
            openMenu();
            return;
        }

        if (statusIcon.icon && statusIcon.icon.click) {
            const event = Clutter.get_current_event();
            if (event)
                statusIcon.icon.click(event);
        }
    }

    activateStatusIcon(statusIcon, event) {
        if (!statusIcon)
            return;

        const button = event && (typeof event.get_button === 'function'
            ? event.get_button() : event.button);

        if (statusIcon._indicator) {
            if (button === Clutter.BUTTON_MIDDLE) {
                if (Main.panel.menuManager.activeMenu)
                    Main.panel.menuManager._closeMenu(true, Main.panel.menuManager.activeMenu);
                statusIcon._indicator.secondaryActivate(event.time, event.x, event.y);
                return;
            }
            this.openIconMenu(statusIcon);
            return;
        }

        if (statusIcon.icon && statusIcon.icon.click)
            statusIcon.icon.click(event);
    }

    _applyListRowIconStyle(actor) {
        this._unmanageMenu(actor.menu);
        actor.remove_style_class_name('appindicator-overflow-item');
        this._applyCellGeometry(actor, 22, 16, 'appindicator-overflow-list-icon');
    }

    setManaging(managing) {
        this._managing = managing;
        if (managing) {
            this._unparentHiddenIcons();
            this._button.showManagePage();
        } else {
            this._button.showIconsPage();
            this._showHiddenIcons();
        }
    }

    _hiddenIcons() {
        // A passive icon asked not to be shown, and giving it a cell would
        // look like a broken icon rather than an absent one.
        return this.orderedKeys()
            .flatMap(key => this._iconsForKey(key))
            .filter(icon => this.isHidden(icon) && icon.isReady() && icon.visible);
    }

    _showHiddenIcons() {
        if (this._managing)
            return;
        this._relayoutHiddenIcons();
        this._refreshPopupActors();
    }

    _unparentHiddenIcons() {
        this._hiddenGrid.get_children().slice().forEach(child => {
            const inner = child.get_child ? child.get_child() : null;
            if (inner) {
                if (child.set_child)
                    child.set_child(null);
                else
                    child.remove_child(inner);
            }
            this._hiddenGrid.remove_child(child);
            if (child !== this._emptyLabel && child !== inner)
                child.destroy();
        });
    }

    _refreshPopupActors() {
        // Icons outliving the manager still run their destroy handler.
        if (!this._button)
            return;

        this._button.visible = this._settings.get_boolean('overflow-enabled');
    }

    getTrayIcons() {
        return [...this._icons.values()].filter(
            i => i instanceof IndicatorStatusIcon.IndicatorStatusTrayIcon);
    }

    _destroy() {
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        if (this._parkedMenuSource)
            this._unparkMenuSource(this._parkedMenuSource);

        // Destroying the button closes its menu, and the close handler must not
        // park an icon again while we are tearing everything down.
        this._menuSourceIcon = null;
        this._unparentHiddenIcons();
        if (this._scaleChangedId) {
            this._themeContext.disconnect(this._scaleChangedId);
            this._scaleChangedId = 0;
        }
        if (this._emptyLabel) {
            this._emptyLabel.destroy();
            this._emptyLabel = null;
        }
        if (this._button) {
            this._button.destroy();
            this._button = null;
        }
        this._icons.clear();
    }
};

const OverflowButton = GObject.registerClass(
class AppIndicatorsOverflowButton extends PanelMenu.Button {
    _init(manager) {
        super._init(0.5, _('Tray overflow'), false);
        this._manager = manager;
        this._openMode = 'icons';
        this.add_style_class_name('appindicator-button');
        this.add_style_class_name('appindicator-overflow-button');

        this._statsLabel = new St.Label({
            style_class: 'appindicator-overflow-stats',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._statsLabel);

        this._stats = new SystemStats.SystemStats();
        this._updateStats();
        this._statsTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT_IDLE,
            STATS_INTERVAL_SECONDS, () => {
                this._updateStats();
                return GLib.SOURCE_CONTINUE;
            });
        this.connect('destroy', () => {
            if (this._statsTimeoutId)
                GLib.source_remove(this._statsTimeoutId);
            this._statsTimeoutId = 0;
        });

        this._iconsItem = new PopupMenu.PopupBaseMenuItem({
            activate: false,
            hover: false,
            reactive: false,
        });
        this._iconsItem.add_child(manager._hiddenGrid);
        // The slot a menu item reserves for its ornament would push the grid
        // off centre, and no cell of it can ever carry one.
        if (this._iconsItem._ornamentLabel)
            this._iconsItem._ornamentLabel.hide();
        this.menu.addMenuItem(this._iconsItem);

        // The grid holds tray icons only, so the way into the list is a plain
        // row rather than a cell that does not belong to any application.
        this._manageEntry = new PopupMenu.PopupMenuItem(_('Manage tray icons…'));
        this._manageEntry.connect('button-release-event', () => {
            manager.setManaging(true);
            return Clutter.EVENT_STOP;
        });
        this.menu.addMenuItem(this._manageEntry);

        this._manageSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._manageSection);
        this._manageActor().visible = false;

        this.menu.connect('open-state-changed', (_menu, open) =>
            manager.onMenuOpenChanged(open));
    }

    _updateStats() {
        this._statsLabel.text =
            `${formatUsage(this._stats.cpuUsage(), 'U')} ${formatUsage(this._stats.memoryUsage(), 'M')}`;
    }

    _eventButton(event) {
        if (event && typeof event.get_button === 'function')
            return event.get_button();
        return event && event.button ? event.button : Clutter.BUTTON_PRIMARY;
    }

    vfunc_event(event) {
        if (!this.menu ||
            (event.type() !== Clutter.EventType.TOUCH_BEGIN &&
             event.type() !== Clutter.EventType.BUTTON_PRESS))
            return super.vfunc_event(event);

        const wantManage = this._eventButton(event) === Clutter.BUTTON_SECONDARY;
        if (this.menu.isOpen) {
            if (wantManage === this._manager._managing)
                this.menu.close();
            else
                this._manager.setManaging(wantManage);
            return Clutter.EVENT_STOP;
        }

        this._openMode = wantManage ? 'manage' : 'icons';
        this.menu.open();
        return Clutter.EVENT_STOP;
    }

    _manageActor() {
        return this._manageSection.actor || this._manageSection.box || this._manageSection;
    }

    _createRowButton(iconName, enabled) {
        return new St.Button({
            style_class: 'appindicator-order-btn',
            child: new St.Icon({
                icon_name: iconName,
                style_class: 'popup-menu-icon',
            }),
            reactive: enabled,
            can_focus: enabled,
            opacity: enabled ? 255 : 70,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    _createHeaderButton(iconName, onClicked) {
        const button = new St.Button({
            style_class: 'appindicator-overflow-item appindicator-overflow-manage-icon',
            reactive: true,
            can_focus: true,
        });
        const icon = new St.Icon({
            icon_name: iconName,
            style_class: 'popup-menu-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (button.set_child)
            button.set_child(icon);
        else
            button.add_actor(icon);
        button.connect('clicked', onClicked);
        return button;
    }

    showIconsPage() {
        this._manager.releaseEmbeddedIcons();
        this._iconsItem.visible = true;
        this._manageEntry.visible = true;
        this._manageActor().visible = false;
        this._manageSection.removeAll();
    }

    showManagePage() {
        this._iconsItem.visible = false;
        this._manageEntry.visible = false;
        this._manageActor().visible = true;
        this.rebuildManageList();
    }

    rebuildManageList() {
        this._manager.releaseEmbeddedIcons();
        this._manageSection.removeAll();

        const top = new PopupMenu.PopupBaseMenuItem({ activate: false });
        top.add_style_class_name('appindicator-overflow-manage-header');
        top.add_child(this._createHeaderButton('view-grid-symbolic', () =>
            this._manager.setManaging(false)));
        top.add_child(new St.Label({
            text: _('Overflow list'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._manageSection.addMenuItem(top);

        const header = new PopupMenu.PopupMenuItem(
            _('Click a name to open its menu, click the eye to show or hide it'), {
                reactive: false,
                activate: false,
            });
        header.setSensitive(false);
        this._manageSection.addMenuItem(header);

        const filterRow = new PopupMenu.PopupBaseMenuItem({ activate: false });
        const filterLabel = new St.Label({
            text: _('Only show running'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const filterState = new St.Label({
            text: this._manager._onlyRunning ? _('On') : _('Off'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        filterRow.add_child(filterLabel);
        filterRow.add_child(filterState);
        filterRow.connect('button-release-event', () => {
            this._manager._onlyRunning = !this._manager._onlyRunning;
            this._manager._settings.set_boolean(
                'overflow-manage-only-running', this._manager._onlyRunning);
            this.rebuildManageList();
            return Clutter.EVENT_STOP;
        });
        this._manageSection.addMenuItem(filterRow);

        let entries = this._manager.listManagedEntries();
        if (this._manager._onlyRunning)
            entries = entries.filter(entry => entry.live);

        if (!entries.length) {
            const empty = new PopupMenu.PopupMenuItem(
                this._manager._onlyRunning
                    ? _('No tray icon is running') : _('No tray icon yet'), {
                    reactive: false,
                    activate: false,
                });
            empty.setSensitive(false);
            this._manageSection.addMenuItem(empty);
            return;
        }

        const visibleIds = entries.map(entry => entry.id);
        entries.forEach((entry, index) => {
            const statusIcon = this._manager._iconForKey(entry.id);
            const suffix = statusIcon ? '' : ` ${_('(not running)')}`;
            const row = new PopupMenu.PopupBaseMenuItem({ activate: false });
            const canEmbed = statusIcon && this._manager.isHidden(statusIcon);

            if (canEmbed) {
                this._manager._applyListRowIconStyle(statusIcon);
                const actor = panelActor(statusIcon);
                this._manager._unparent(actor);
                row.add_child(actor);
                if (statusIcon.icon && statusIcon.icon._invalidateIconWhenFullyReady)
                    statusIcon.icon._invalidateIconWhenFullyReady();
            }

            const nameLabel = new St.Label({
                text: `${entry.name}${suffix}`,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const stateToggle = this._createRowButton(
                entry.pinned ? 'view-reveal-symbolic' : 'view-conceal-symbolic', true);
            stateToggle.accessible_name = entry.pinned
                ? _('Show on the panel') : _('Move into the overflow');
            const up = this._createRowButton('go-up-symbolic', index > 0);
            const down = this._createRowButton('go-down-symbolic',
                index < entries.length - 1);

            up.connect('clicked', () => this._manager.moveKey(entry.id, -1, visibleIds));
            down.connect('clicked', () => this._manager.moveKey(entry.id, 1, visibleIds));
            stateToggle.connect('clicked', () =>
                this._manager.setPinned(entry.id, !this._manager.isKeyPinned(entry.id)));

            if (statusIcon) {
                nameLabel.reactive = true;
                nameLabel.connect('button-press-event', (_actor, event) => {
                    this._manager.activateStatusIcon(statusIcon, event);
                    return Clutter.EVENT_STOP;
                });
            }

            row.add_child(nameLabel);
            row.add_child(stateToggle);
            row.add_child(up);
            row.add_child(down);
            this._manageSection.addMenuItem(row);
        });
    }
});
