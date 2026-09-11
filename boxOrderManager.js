// This file is part of the AppIndicator/KStatusNotifierItem GNOME Shell extension
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program; if not, write to the Free Software
// Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.

/* exported BoxOrderManager, TRAY_SLOT, isTrayRole */

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const Main = imports.ui.main;
const Panel = imports.ui.panel;

const Extension = imports.misc.extensionUtils.getCurrentExtension();
const SettingsManager = Extension.imports.settingsManager;

// The chip and every AppIndicator / XEmbed icon are one slot in the box
// orders. Identity of the icons themselves stays in OverflowManager.
var TRAY_SLOT = 'appindicator-overflow';
const BOXES = ['left', 'center', 'right'];
const ORGANIZER_SCHEMA = 'org.gnome.shell.extensions.top-bar-organizer';

let boxOrderManager = null;
let originalAddToPanelBox = null;
let patchedAddToPanelBox = null;

function isTrayRole(role) {
    return role === TRAY_SLOT || role.startsWith('appindicator-');
}

function panelBox(name) {
    switch (name) {
    case 'left':
        return Main.panel._leftBox;
    case 'center':
        return Main.panel._centerBox;
    case 'right':
        return Main.panel._rightBox;
    default:
        return null;
    }
}

function isUserSession() {
    return Main.sessionMode.currentMode === 'user' ||
        Main.sessionMode.parentMode === 'user';
}

var BoxOrderManager = class AppIndicatorsBoxOrderManager {
    static getDefault() {
        if (!boxOrderManager)
            boxOrderManager = new BoxOrderManager();
        return boxOrderManager;
    }

    static peek() {
        return boxOrderManager;
    }

    static destroy() {
        if (!boxOrderManager)
            return;
        boxOrderManager._destroy();
        boxOrderManager = null;
    }

    constructor() {
        if (boxOrderManager)
            throw new Error('BoxOrderManager is already constructed');

        this._settings = SettingsManager.getDefaultGSettings();
        this._destroyed = false;
        this._applying = false;
        this._writingSettings = false;
        this._syncingTrayPos = false;
        this._idleId = 0;
        this._boxSignals = [];
        this._settingsIds = [];

        this._migrateFromOrganizer();
        this._installHooks();
        this.apply();
    }

    apply() {
        if (this._destroyed || this._applying || !isUserSession())
            return;

        this._applying = true;
        try {
            this._adoptNewSlots();
            if (this._applyAllBoxes())
                this._relayoutLegacyIcons();
        } finally {
            this._applying = false;
        }
    }

    scheduleApply() {
        if (this._destroyed || this._idleId || this._applying)
            return;

        this._idleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 50, () => {
            this._idleId = 0;
            if (this._destroyed || !isUserSession())
                return GLib.SOURCE_REMOVE;
            this.apply();
            return GLib.SOURCE_REMOVE;
        });
    }

    _panelBoxes() {
        return BOXES.map(panelBox);
    }

    _actorsOf(indicator) {
        if (!indicator)
            return [];

        // Every actor carries an "actor" property that only logs a deprecation
        // warning and hands back the actor itself, so it is read for the older
        // indicators that really do keep their actor beside them.
        if (indicator instanceof Clutter.Actor)
            return [indicator.container, indicator].filter(actor => !!actor);
        return [indicator.container, indicator.actor].filter(actor => !!actor);
    }

    _rolesByActor() {
        const roles = new Map();
        const statusArea = Main.panel.statusArea;
        for (const role in statusArea) {
            this._actorsOf(statusArea[role]).forEach(actor => {
                if (!roles.has(actor))
                    roles.set(actor, role);
            });
        }
        return roles;
    }

    _actorForSlot(slot) {
        return this._actorsOf(Main.panel.statusArea[slot]).find(actor => actor.get_parent());
    }

    // Dash to Panel pulls Activities, the date menu and the system menu out of
    // the three boxes and allocates them on the panel itself. Moving those
    // back into a box fights that layout.
    _isPanelChrome(actor) {
        const parent = actor && actor.get_parent();
        return parent === Main.panel;
    }

    _slotForRole(role) {
        if (!role)
            return null;
        return isTrayRole(role) ? TRAY_SLOT : role;
    }

    _presentSlots(boxName, roles) {
        const seen = new Set();
        const slots = [];
        for (const actor of panelBox(boxName).get_children()) {
            const slot = this._slotForRole(roles.get(actor));
            if (!slot || seen.has(slot))
                continue;
            seen.add(slot);
            slots.push(slot);
        }
        return slots;
    }

    _readOrders() {
        const orders = {};
        BOXES.forEach(box => {
            orders[box] = this._settings.get_strv(`${box}-box-order`);
        });
        return orders;
    }

    _writeOrders(orders) {
        this._writingSettings = true;
        try {
            BOXES.forEach(box => {
                const next = orders[box];
                const current = this._settings.get_strv(`${box}-box-order`);
                if (JSON.stringify(current) !== JSON.stringify(next))
                    this._settings.set_strv(`${box}-box-order`, next);
            });
        } finally {
            this._writingSettings = false;
        }
    }

    _slotInOrders(orders, slot) {
        return BOXES.some(box => orders[box].includes(slot));
    }

    _insertNear(order, slot, present) {
        const idx = present.indexOf(slot);
        for (let i = idx - 1; i >= 0; i--) {
            const prev = order.indexOf(present[i]);
            if (prev !== -1) {
                order.splice(prev + 1, 0, slot);
                return;
            }
        }
        for (let i = idx + 1; i < present.length; i++) {
            const next = order.indexOf(present[i]);
            if (next !== -1) {
                order.splice(next, 0, slot);
                return;
            }
        }
        order.push(slot);
    }

    _dedupeOrders(orders) {
        let trayBox = null;
        BOXES.forEach(box => {
            const kept = [];
            const seen = new Set();
            orders[box].forEach(slot => {
                if (seen.has(slot))
                    return;
                if (slot === TRAY_SLOT) {
                    if (trayBox)
                        return;
                    trayBox = box;
                }
                seen.add(slot);
                kept.push(slot);
            });
            orders[box] = kept;
        });
        return trayBox;
    }

    _adoptNewSlots() {
        const orders = this._readOrders();
        const roles = this._rolesByActor();
        BOXES.forEach(box => {
            const present = this._presentSlots(box, roles);
            present.forEach(slot => {
                if (this._slotInOrders(orders, slot))
                    return;
                this._insertNear(orders[box], slot, present);
            });
        });
        const trayBox = this._dedupeOrders(orders);
        this._writeOrders(orders);
        if (trayBox)
            this._setTrayPos(trayBox);
    }

    _setTrayPos(box) {
        if (this._settings.get_string('tray-pos') === box)
            return;
        this._syncingTrayPos = true;
        try {
            this._settings.set_string('tray-pos', box);
        } finally {
            this._syncingTrayPos = false;
        }
    }

    _syncTrayPosFromOrders() {
        const orders = this._readOrders();
        const trayBox = this._dedupeOrders(orders);
        this._writeOrders(orders);
        if (trayBox)
            this._setTrayPos(trayBox);
    }

    _onTrayPosChanged() {
        if (this._syncingTrayPos || this._writingSettings || this._applying)
            return;

        const pos = this._settings.get_string('tray-pos');
        if (!BOXES.includes(pos))
            return;

        const orders = this._readOrders();
        const currentBox = BOXES.find(box => orders[box].includes(TRAY_SLOT));
        if (currentBox === pos) {
            this.apply();
            return;
        }

        BOXES.forEach(box => {
            orders[box] = orders[box].filter(slot => slot !== TRAY_SLOT);
        });
        if (!orders[pos].includes(TRAY_SLOT))
            orders[pos].push(TRAY_SLOT);
        this._writeOrders(orders);
        this.apply();
    }

    _onOrderChanged() {
        if (this._writingSettings || this._applying)
            return;
        this._syncTrayPosFromOrders();
        this.apply();
    }

    _trayGroupActors() {
        const OverflowManager = Extension.imports.overflowManager.OverflowManager;
        const manager = OverflowManager.peek();
        if (manager)
            return manager.trayGroupActors();

        const button = Main.panel.statusArea[TRAY_SLOT];
        const actor = button && button.container;
        return actor ? [actor] : [];
    }

    _applyAllBoxes() {
        if (!isUserSession())
            return false;
        return BOXES.map(box => this._applyBox(box)).includes(true);
    }

    _applyBox(boxName) {
        const target = panelBox(boxName);
        const seen = new Set();
        const actors = [];

        const addActor = actor => {
            if (!actor || seen.has(actor) || this._isPanelChrome(actor))
                return;
            seen.add(actor);
            actors.push(actor);
        };

        this._settings.get_strv(`${boxName}-box-order`).forEach(slot => {
            if (slot === TRAY_SLOT)
                this._trayGroupActors().forEach(addActor);
            else
                addActor(this._actorForSlot(slot));
        });

        // The ordered actors end up as one run at the edge the box fills from,
        // so a box that already reads that way is left untouched: reshuffling
        // it anyway would relayout the whole panel on every panel change.
        const children = target.get_children();
        const start = boxName === 'right' ? children.length - actors.length : 0;
        if (start >= 0 && actors.every((actor, i) => children[start + i] === actor))
            return false;

        const visibility = actors.map(actor => actor.visible);
        actors.forEach((actor, i) => {
            const parent = actor.get_parent();

            // Moving a child inside its own box never detaches it, which keeps
            // the box from announcing a removal and an addition for every icon.
            if (parent === target) {
                target.set_child_at_index(actor, boxName === 'right' ? -1 : i);
                return;
            }

            if (parent)
                parent.remove_child(actor);
            if (boxName === 'right')
                target.insert_child_at_index(actor, -1);
            else
                target.insert_child_at_index(actor, i);
            if (!visibility[i])
                actor.hide();
        });
        return true;
    }

    _relayoutLegacyIcons() {
        const OverflowManager = Extension.imports.overflowManager.OverflowManager;
        const manager = OverflowManager.peek();
        if (manager)
            manager.queueLegacyRelayout();
    }

    _collapseOrganizerOrder(roles) {
        const slots = [];
        const seen = new Set();
        roles.forEach(role => {
            const slot = this._slotForRole(role);
            if (!slot || seen.has(slot))
                return;
            seen.add(slot);
            slots.push(slot);
        });
        return slots;
    }

    _readOrganizerOrders() {
        const source = Gio.SettingsSchemaSource.get_default();
        const schema = source && source.lookup(ORGANIZER_SCHEMA, true);
        if (!schema)
            return null;

        try {
            const settings = new Gio.Settings({ settings_schema: schema });
            const orders = {};
            BOXES.forEach(box => {
                orders[box] = this._collapseOrganizerOrder(
                    settings.get_strv(`${box}-box-order`));
            });
            return orders;
        } catch (e) {
            return null;
        }
    }

    _migrateFromOrganizer() {
        if (this._settings.get_boolean('box-order-migrated'))
            return;

        const migrated = this._readOrganizerOrders();
        if (migrated) {
            const ours = this._readOrders();
            const empty = BOXES.every(box => ours[box].length === 0);
            if (empty) {
                this._dedupeOrders(migrated);
                this._writeOrders(migrated);
            }
        }

        this._settings.set_boolean('box-order-migrated', true);
    }

    _installHooks() {
        if (!originalAddToPanelBox) {
            originalAddToPanelBox = Panel.Panel.prototype._addToPanelBox;
            patchedAddToPanelBox = function (role, indicator, position, box) {
                originalAddToPanelBox.call(this, role, indicator, position, box);
                if (boxOrderManager)
                    boxOrderManager.scheduleApply();
            };
            Panel.Panel.prototype._addToPanelBox = patchedAddToPanelBox;
        }

        this._panelBoxes().forEach(box => {
            if (!box)
                return;
            this._boxSignals.push([box, box.connect('actor-added', () => {
                if (!this._applying && !this._destroyed)
                    this.scheduleApply();
            })]);
        });

        BOXES.forEach(box => {
            this._settingsIds.push(this._settings.connect(
                `changed::${box}-box-order`, () => this._onOrderChanged()));
        });
        this._settingsIds.push(this._settings.connect(
            'changed::tray-pos', () => this._onTrayPosChanged()));
    }

    _destroy() {
        this._destroyed = true;

        if (this._idleId) {
            try {
                GLib.source_remove(this._idleId);
            } catch (e) {}
            this._idleId = 0;
        }

        this._settingsIds.forEach(id => {
            try {
                this._settings.disconnect(id);
            } catch (e) {}
        });
        this._settingsIds = [];

        this._boxSignals.forEach(([box, id]) => {
            try {
                box.disconnect(id);
            } catch (e) {}
        });
        this._boxSignals = [];

        if (Panel.Panel.prototype._addToPanelBox === patchedAddToPanelBox &&
            originalAddToPanelBox) {
            Panel.Panel.prototype._addToPanelBox = originalAddToPanelBox;
            originalAddToPanelBox = null;
            patchedAddToPanelBox = null;
        }
    }
};
