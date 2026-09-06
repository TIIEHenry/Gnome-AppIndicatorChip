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

/* exported buildItemOrderPage, flattenInnerScrolls */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Gdk = imports.gi.Gdk;
const Adw = imports.gi.Adw;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Gettext = imports.gettext.domain(
    Me ? Me.metadata['gettext-domain'] : 'AppIndicatorExtension');
const _ = Gettext.gettext;

const TRAY_SLOT = 'appindicator-overflow';
const BOXES = ['left', 'center', 'right'];
const BOX_TITLES = {
    left: _('Left Top Bar Box'),
    center: _('Center Top Bar Box'),
    right: _('Right Top Bar Box'),
};

function slotLabel(slot) {
    if (slot === TRAY_SLOT)
        return _('Tray (overflow + icons)');
    return slot;
}

function dropRow(value) {
    if (!value)
        return null;
    if (value instanceof BoxOrderRow)
        return value;
    if (value.get_object)
        return value.get_object();
    return value;
}

function readOrders(settings) {
    const orders = {};
    BOXES.forEach(box => {
        orders[box] = settings.get_strv(`${box}-box-order`).slice();
    });
    return orders;
}

function writeOrders(settings, orders) {
    BOXES.forEach(box => {
        const next = orders[box];
        const current = settings.get_strv(`${box}-box-order`);
        if (JSON.stringify(current) !== JSON.stringify(next))
            settings.set_strv(`${box}-box-order`, next);
    });
    for (const box of BOXES) {
        if (orders[box].includes(TRAY_SLOT)) {
            if (settings.get_string('tray-pos') !== box)
                settings.set_string('tray-pos', box);
            break;
        }
    }
}

function moveItem(settings, item, fromBox, toBox, toIndex) {
    const orders = readOrders(settings);
    const from = orders[fromBox].filter(entry => entry !== item);
    const to = fromBox === toBox ? from : orders[toBox].filter(entry => entry !== item);
    const index = Math.max(0, Math.min(toIndex, to.length));
    to.splice(index, 0, item);
    orders[fromBox] = fromBox === toBox ? to : from;
    orders[toBox] = to;
    writeOrders(settings, orders);
}

function forgetItem(settings, item, fromBox) {
    const orders = readOrders(settings);
    orders[fromBox] = orders[fromBox].filter(entry => entry !== item);
    writeOrders(settings, orders);
}

const BoxOrderRow = GObject.registerClass({
    GTypeName: 'AppIndicatorBoxOrderRow',
}, class AppIndicatorBoxOrderRow extends Adw.ActionRow {
    _init(item) {
        super._init({ title: slotLabel(item) });
        this.item = item;

        const handle = new Gtk.Image({
            icon_name: 'list-drag-handle-symbolic',
        });
        this.add_prefix(handle);

        const menu = new Gio.Menu();
        menu.append(_('Forget'), 'row.forget');
        const options = new Gtk.MenuButton({
            icon_name: 'view-more-symbolic',
            menu_model: menu,
            has_frame: false,
            valign: Gtk.Align.CENTER,
        });
        this.add_suffix(options);

        const forget = new Gio.SimpleAction({ name: 'forget' });
        forget.connect('activate', () => {
            if (this._controller)
                this._controller.forgetRow(this);
        });
        const group = new Gio.SimpleActionGroup();
        group.add_action(forget);
        this.insert_action_group('row', group);

        const drag = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE });
        drag.connect('prepare', (_source, x, y) => {
            this._dragX = x;
            this._dragY = y;
            const value = new GObject.Value();
            value.init(BoxOrderRow);
            value.set_object(this);
            return Gdk.ContentProvider.new_for_value(value);
        });
        drag.connect('drag-begin', (_source, gdkDrag) => {
            const icon = Gtk.DragIcon.get_for_drag(gdkDrag);
            const ghost = new BoxOrderRow(this.item);
            ghost.set_size_request(this.get_allocated_width(),
                this.get_allocated_height());
            icon.set_child(ghost);
            gdkDrag.set_hotspot(this._dragX || 0, this._dragY || 0);
        });
        this.add_controller(drag);

        const drop = new Gtk.DropTarget({
            actions: Gdk.DragAction.MOVE,
            formats: Gdk.ContentFormats.new_for_gtype(BoxOrderRow),
        });
        drop.connect('drop', (_target, value) => {
            const source = dropRow(value);
            if (!source || source === this || !this._controller)
                return false;
            this._controller.dropOnRow(source, this);
            return true;
        });
        this.add_controller(drop);
    }
});

function bindGroups(settings, groups) {
    const controller = {
        _saving: false,
        boxOfRow(row) {
            return row._box;
        },
        dropOnRow(source, target) {
            const fromBox = source._box;
            const toBox = target._box;
            let toIndex = settings.get_strv(`${toBox}-box-order`).indexOf(target.item);
            if (toIndex < 0)
                toIndex = settings.get_strv(`${toBox}-box-order`).length;
            if (fromBox === toBox) {
                const fromIndex = settings.get_strv(`${fromBox}-box-order`).indexOf(source.item);
                if (fromIndex >= 0 && fromIndex < toIndex)
                    toIndex -= 1;
            }
            if (fromBox !== toBox &&
                (fromBox === 'left' && toBox !== 'left' ||
                 fromBox === 'center' && toBox === 'right'))
                toIndex += 1;
            this._saving = true;
            try {
                moveItem(settings, source.item, fromBox, toBox, toIndex);
            } finally {
                this._saving = false;
            }
            this.reload();
        },
        dropOnGroup(source, toBox) {
            this._saving = true;
            try {
                moveItem(settings, source.item, source._box, toBox, 0);
            } finally {
                this._saving = false;
            }
            this.reload();
        },
        forgetRow(row) {
            this._saving = true;
            try {
                forgetItem(settings, row.item, row._box);
            } finally {
                this._saving = false;
            }
            this.reload();
        },
        reload() {
            BOXES.forEach(box => {
                const group = groups[box];
                (group._orderRows || []).slice().forEach(row => {
                    group.remove(row);
                    row.destroy();
                });
                group._orderRows = [];
                settings.get_strv(`${box}-box-order`).forEach(item => {
                    const row = new BoxOrderRow(item);
                    row._box = box;
                    row._controller = controller;
                    group.add(row);
                    group._orderRows.push(row);
                });
            });
        },
    };

    BOXES.forEach(box => {
        const drop = new Gtk.DropTarget({
            actions: Gdk.DragAction.MOVE,
            formats: Gdk.ContentFormats.new_for_gtype(BoxOrderRow),
        });
        drop.connect('drop', (_target, value) => {
            const source = dropRow(value);
            if (!source)
                return false;
            controller.dropOnGroup(source, box);
            return true;
        });
        groups[box].add_controller(drop);
    });

    controller.reload();
    return controller;
}

function walkWidgets(widget, fn) {
    fn(widget);
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
        walkWidgets(child, fn);
}

function firstScrolled(widget) {
    if (widget instanceof Gtk.ScrolledWindow)
        return widget;
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        const found = firstScrolled(child);
        if (found)
            return found;
    }
    return null;
}

// The preferences window already scrolls. Any ScrolledWindow nested inside a
// page is the second bar the user sees; turn those into ordinary expanding
// boxes so only the page moves.
function flattenInnerScrolls(page) {
    const apply = () => {
        const outer = firstScrolled(page);
        walkWidgets(page, widget => {
            if (!(widget instanceof Gtk.ScrolledWindow) || widget === outer)
                return;
            widget.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.NEVER);
            widget.propagate_natural_height = true;
            widget.propagate_natural_width = true;
        });
    };
    page.connect('map', apply);
}

function startEdgeScroll(page) {
    page.connect('realize', () => {
        const scrolled = firstScrolled(page);
        if (!scrolled || scrolled._appindicatorEdgeScroll)
            return;

        scrolled._appindicatorEdgeScroll = true;
        const adj = scrolled.get_vadjustment();
        let step = 0;
        let id = 0;

        const tick = () => {
            adj.set_value(Math.max(adj.lower,
                Math.min(adj.upper - adj.page_size, adj.value + step)));
            return GLib.SOURCE_CONTINUE;
        };

        const motion = new Gtk.DropControllerMotion();
        motion.connect('motion', (_c, _x, y) => {
            const height = scrolled.get_allocated_height();
            if (y <= height * 0.1)
                step = -16;
            else if (y >= height * 0.9)
                step = 16;
            else
                step = 0;

            if (step && !id)
                id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, tick);
            if (!step && id) {
                GLib.source_remove(id);
                id = 0;
            }
        });
        const stop = () => {
            step = 0;
            if (id) {
                GLib.source_remove(id);
                id = 0;
            }
        };
        motion.connect('leave', stop);
        scrolled.add_controller(motion);
        scrolled.connect('destroy', stop);
    });
}

function buildGtk4Page(settings) {
    const page = new Adw.PreferencesPage({
        title: _('Item Order'),
        icon_name: 'view-list-symbolic',
    });

    const groups = {};
    BOXES.forEach(box => {
        groups[box] = new Adw.PreferencesGroup({
            title: BOX_TITLES[box],
            description: box === 'left'
                ? _('Simply use drag and drop to order the items any way you want. The tray chip and its icons move as one item.')
                : '',
        });
        page.add(groups[box]);
    });

    const controller = bindGroups(settings, groups);
    BOXES.forEach(box => {
        settings.connect(`changed::${box}-box-order`, () => {
            if (!controller._saving)
                controller.reload();
        });
    });

    flattenInnerScrolls(page);
    startEdgeScroll(page);
    return page;
}

function buildGtk3Page(settings) {
    const page = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        margin_start: 24,
        margin_end: 24,
        margin_top: 24,
        margin_bottom: 24,
    });
    const label = new Gtk.Label({
        label: _('Item Order is available in GNOME 42 settings (GTK 4).'),
        wrap: true,
        xalign: 0,
    });
    page.pack_start(label, false, false, 0);
    BOXES.forEach(box => {
        const heading = new Gtk.Label({
            label: BOX_TITLES[box],
            xalign: 0,
        });
        page.pack_start(heading, false, false, 0);
        settings.get_strv(`${box}-box-order`).forEach(item => {
            page.pack_start(new Gtk.Label({
                label: slotLabel(item),
                xalign: 0,
            }), false, false, 0);
        });
    });
    return page;
}

function buildItemOrderPage(settings) {
    if (imports.gi.versions.Gtk === '4.0')
        return buildGtk4Page(settings);
    return buildGtk3Page(settings);
}
